from __future__ import annotations

import json
import os
import re
import time
from typing import Any, Dict

import azure.functions as func
import requests
from azure.identity import DefaultAzureCredential

from shared.kv import get_kv_secret


# Case-sensitive marker the reporter emits when a human rejects its
# proposed case note / status change and wants the case re-investigated.
# See agents/instructions/reporter.md for how the reporter is instructed
# to emit this.
_REINVESTIGATION_RE = re.compile(r"NEEDS_REINVESTIGATION:\s*(.+?)(?:\n|$)")


def _extract_reinvestigation(text: str) -> str | None:
    if not isinstance(text, str):
        return None
    m = _REINVESTIGATION_RE.search(text)
    return m.group(1).strip() if m else None


def _json(req: func.HttpRequest) -> dict:
    try:
        return req.get_json()
    except Exception:
        return {}


def _runner_post(runner_url: str, runner_bearer: str, payload: dict[str, Any], agent: str) -> dict[str, Any]:
    r = requests.post(
        runner_url.rstrip("/") + "/tools/execute",
        headers={
            "x-aisoc-runner-key": runner_bearer,
            "x-aisoc-agent": agent,
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=90,
    )
    if r.status_code >= 400:
        raise RuntimeError(f"Runner tool call failed ({r.status_code}): {r.text[:4000]}")
    return r.json()


def _ai_projects_token() -> str:
    # Foundry Agent Service uses ai.azure.com audience.
    return DefaultAzureCredential().get_token("https://ai.azure.com/.default").token


def _response_text(data: Any) -> str:
    # Extract output text from an OpenAI Responses-shaped payload.
    if isinstance(data, dict):
        if isinstance(data.get("output_text"), str):
            return data["output_text"]
        out = data.get("output")
        if isinstance(out, list):
            texts: list[str] = []
            for item in out:
                if not isinstance(item, dict):
                    continue
                content = item.get("content")
                if not isinstance(content, list):
                    continue
                for block in content:
                    if isinstance(block, dict) and isinstance(block.get("text"), str):
                        texts.append(block["text"])
            if texts:
                return "\n".join(texts)
    return json.dumps(data)[:12000]


def _invoke_agent(project_endpoint: str, agent_name: str, user_text: str) -> tuple[str, dict]:
    """Invoke a Foundry agent and return (text, raw_response).

    Returning the raw response lets callers inspect structured output items
    (e.g. ``openapi_call`` invocations) to tell whether the agent actually
    hit any of its attached tools — text alone can't answer that.
    """

    # Invoke agent via OpenAI v1 Responses endpoint under the project.
    # NOTE: When using /openai/v1 paths, the service rejects api-version query params.
    url = project_endpoint.rstrip("/") + "/openai/v1/responses"

    payload = {
        "input": user_text,
        "agent_reference": {"name": agent_name, "type": "agent_reference"},
    }

    # Foundry model deployments can return 429 ("rate_limit_exceeded") when
    # TPM/RPM quota is saturated. Retry a few times, honouring Retry-After
    # when provided, before giving up. Individual agents share the deployment,
    # so the investigator often hits it right after triage burned through
    # tokens on a tool-heavy run.
    MAX_429_RETRIES = 4
    DEFAULT_429_WAIT_SEC = 15.0
    MAX_429_WAIT_SEC = 60.0

    r = None
    for attempt in range(MAX_429_RETRIES + 1):
        r = requests.post(
            url,
            headers={
                "Authorization": f"Bearer {_ai_projects_token()}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=240,
        )
        if r.status_code != 429 or attempt >= MAX_429_RETRIES:
            break

        retry_after = r.headers.get("Retry-After", "")
        try:
            wait = float(retry_after) if retry_after else DEFAULT_429_WAIT_SEC
        except ValueError:
            wait = DEFAULT_429_WAIT_SEC
        # Cap the wait so a misconfigured Retry-After can't park us for minutes.
        wait = min(max(wait, 1.0), MAX_429_WAIT_SEC)
        print(
            f"[invoke_agent] 429 from agent={agent_name!r}, sleeping {wait:.1f}s "
            f"(attempt {attempt + 1}/{MAX_429_RETRIES})",
            flush=True,
        )
        time.sleep(wait)

    # Tool-call failures inside an agent can return 400 with code=tool_user_error.
    # For demo resilience, treat those as a soft failure and return the error payload as text
    # so the pipeline can continue (investigator may still produce a useful report).
    if r.status_code >= 400:
        try:
            j = r.json()
            err = (j.get("error") or {}) if isinstance(j, dict) else {}
            if r.status_code == 400 and err.get("code") == "tool_user_error":
                return f"[TOOL_USER_ERROR:{agent_name}] {json.dumps(j)[:4000]}", (j if isinstance(j, dict) else {})
        except Exception:
            pass

        raise RuntimeError(f"Agent '{agent_name}' response failed ({r.status_code}): {r.text[:4000]}")

    data = r.json()
    return _response_text(data), (data if isinstance(data, dict) else {})


def _detect_tool_calls(raw: dict, tool_names: set[str]) -> list[dict]:
    """Return a list of tool invocations in a Foundry Responses payload whose
    underlying tool_name matches one of ``tool_names``.

    Best-effort: the exact field names inside ``openapi_call`` / ``tool_call``
    items can vary by API version, so we check the common places.
    """

    hits: list[dict] = []
    output = (raw or {}).get("output") or []
    for item in output:
        if not isinstance(item, dict):
            continue
        if item.get("type") not in ("openapi_call", "tool_call", "function_call"):
            continue
        args = item.get("arguments") or {}
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except Exception:
                args = {}
        name = (
            (args.get("tool_name") if isinstance(args, dict) else None)
            or item.get("name")
            or (item.get("tool") or {}).get("name")
        )
        if name in tool_names:
            hits.append({"name": name, "arguments": args if isinstance(args, dict) else {}})
    return hits


def _clip(s: str, max_chars: int) -> str:
    s = s or ""
    return s if len(s) <= max_chars else (s[: max_chars - 3] + "...")


# ─── Phase heartbeats ────────────────────────────────────────────────────
#
# Always-on structured logs around each agent invocation, regardless of
# success or failure. Two purposes:
#   1) When troubleshooting, we can see "phase=investigator started" at
#      timestamp X even when there's no 429/error noise in the logs.
#   2) Future SOC Manager UI can query App Insights for these lines (or
#      ingest the equivalent COSTS records) to build a per-incident
#      agent-call timeline. Format is key=value pairs so kusto's parse
#      operator can split them cleanly.


def _phase_start(
    *,
    phase: str,
    incident_number: Any,
    incident_id: Any,
    workflow_run_id: str,
    iteration: int = 0,
) -> float:
    """Log a phase-start heartbeat and return the start timestamp."""
    started = time.time()
    print(
        f"[orchestrator] phase={phase} event=start "
        f"incident_number={incident_number} incident_id={incident_id} "
        f"workflow_run_id={workflow_run_id} iteration={iteration}",
        flush=True,
    )
    return started


def _phase_end(
    *,
    phase: str,
    started: float,
    workflow_run_id: str,
    usage: Any,
) -> None:
    """Log a phase-end heartbeat with duration + token counts."""
    duration_ms = int((time.time() - started) * 1000)
    if isinstance(usage, dict):
        tokens_in = int(usage.get("input_tokens") or usage.get("prompt_tokens") or 0)
        tokens_out = int(usage.get("output_tokens") or usage.get("completion_tokens") or 0)
    else:
        tokens_in = 0
        tokens_out = 0
    print(
        f"[orchestrator] phase={phase} event=end "
        f"workflow_run_id={workflow_run_id} duration_ms={duration_ms} "
        f"tokens_in={tokens_in} tokens_out={tokens_out}",
        flush=True,
    )


# ─── Cost tracking ────────────────────────────────────────────────────────
#
# We pull response.usage off every Foundry call and ship a per-call cost
# record to PixelAgents Web, which accumulates them in-process so the
# incident panel can show EUR per incident in real time. The LAW-based
# Option A Workbook is deliberately NOT part of this path — this is the
# per-incident story. Prices come from env vars (set by Phase 2 Terraform
# from module-level variables) so re-pricing doesn't require a code change.


def _pixelagents_base_url() -> str:
    """Base URL for PixelAgents Web; strips a trailing /events if present.

    PIXELAGENTS_URL historically points at the telemetry ingestion endpoint
    (/events). For the new /api/cost/record call we need the bare base.
    """
    url = (os.getenv("PIXELAGENTS_URL", "") or "").strip().rstrip("/")
    for suffix in ("/events", "/events/"):
        if url.endswith(suffix):
            url = url[: -len(suffix)]
            break
    return url.rstrip("/")


def _price_eur_per_token(kind: str) -> float:
    """EUR-per-token unit price, from TOKEN_PRICE_EUR_PER_1M_{INPUT,OUTPUT}."""
    if kind == "input":
        raw = os.getenv("TOKEN_PRICE_EUR_PER_1M_INPUT", "0.35")
    else:
        raw = os.getenv("TOKEN_PRICE_EUR_PER_1M_OUTPUT", "1.40")
    try:
        return float(raw) / 1_000_000.0
    except Exception:
        return 0.0


def _emit_cost_record(
    *,
    incident_number: Any,
    incident_id: Any,
    agent_name: str,
    phase: str,
    usage: Any,
    workflow_run_id: str,
) -> None:
    """POST a per-call cost record to PixelAgents Web. Best-effort; never
    raises so cost accounting can't break the pipeline."""

    base = _pixelagents_base_url()
    token = (os.getenv("PIXELAGENTS_TOKEN", "") or "").strip()
    if not base or not token:
        return
    if not isinstance(usage, dict):
        return

    input_tokens = int(
        usage.get("input_tokens")
        or usage.get("prompt_tokens")
        or 0
    )
    output_tokens = int(
        usage.get("output_tokens")
        or usage.get("completion_tokens")
        or 0
    )
    if input_tokens == 0 and output_tokens == 0:
        return

    eur_cost = (
        input_tokens * _price_eur_per_token("input")
        + output_tokens * _price_eur_per_token("output")
    )

    record = {
        "incident_number": incident_number,
        "incident_id": incident_id,
        "agent": agent_name,
        "phase": phase,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "eur_cost": round(eur_cost, 6),
        "workflow_run_id": workflow_run_id,
        "ts": time.time(),
    }

    try:
        requests.post(
            f"{base}/api/cost/record",
            headers={
                "x-pixelagents-token": token,
                "Content-Type": "application/json",
            },
            json=record,
            timeout=5,
        )
    except Exception as e:
        # Cost telemetry is best-effort; don't surface into the pipeline.
        print(f"[orchestrator] cost-record POST failed: {e!r}", flush=True)


# ─── Incident owner assignment ────────────────────────────────────────────


def _set_incident_status(
    runner_url: str,
    runner_bearer: str,
    incident_number: Any,
    incident_id: Any,
    status: str,
) -> None:
    """Update incident.status (e.g. New -> Active) via the runner's
    update_incident tool.

    Status transitions are nice-to-have for the UI's view-state pill
    ("Active · Agentic Analysis" rendered in PixelAgents Web). If the
    write fails for any reason — bad permissions, ARM hiccup, schema
    mismatch — log it but don't block the pipeline; the analysis itself
    still produces value.
    """

    args: dict[str, Any] = {"properties": {"status": status}}
    if incident_number is not None:
        args["incidentNumber"] = incident_number
    elif incident_id is not None:
        args["id"] = incident_id
    else:
        return

    try:
        result = _runner_post(
            runner_url,
            runner_bearer,
            {"tool_name": "update_incident", "arguments": args},
            # Tag the runner call with "triage" rather than something
            # like "orchestrator". Reason: the runner emits a PixelAgents
            # event for every /tools/execute call using this slug, and
            # any unrecognised slug spawns a ghost character in the Live
            # Agent View. This status bump runs at the very start of the
            # pipeline, immediately before the triage phase, so tagging
            # it as triage is both visually appropriate (the triage
            # character lights up briefly as work kicks off) and avoids
            # adding agents to the PixelAgents roster.
            agent="triage",
        )
        body = result.get("result") if isinstance(result, dict) else None
        if isinstance(body, dict) and body.get("ok") is False:
            err = body.get("error") or body
            print(
                f"[orchestrator] status set to {status!r} rejected: {err}",
                flush=True,
            )
    except Exception as e:
        print(
            f"[orchestrator] status set to {status!r} raised: {e!r}",
            flush=True,
        )


def _assign_incident_owner(
    runner_url: str,
    runner_bearer: str,
    incident_number: Any,
    incident_id: Any,
    display_name: str,
) -> None:
    """Set incident.owner.assignedTo to `display_name` before each phase.

    Uses the runner's update_incident tool so the existing RBAC path
    (Gateway's MI → Sentinel Contributor) is reused. Sentinel's incident
    owner object has multiple fields; we send ownerType=User + assignedTo
    + a dummy objectId so API versions that require an identity still
    accept the payload. The UI reads assignedTo so the display is
    driven by that one field regardless.
    """

    # Minimal owner payload — confirmed working against Sentinel's
    # 2024-03-01 api-version once the Gateway switched update_incident
    # from PATCH to GET-then-PUT with etag. The other owner sub-fields
    # (ownerType, objectId, email, userPrincipalName) are nullable and
    # left unset so we don't trip identity-validation paths that look
    # for a real Entra user.
    args: dict[str, Any] = {
        "properties": {
            "owner": {"assignedTo": display_name}
        }
    }
    if incident_number is not None:
        args["incidentNumber"] = incident_number
    elif incident_id is not None:
        args["id"] = incident_id
    else:
        return

    # Tag the runner call with the agent that's *taking over*, not
    # "orchestrator". So when the assignee flips to "Triage Agent", the
    # triage character lights up briefly via the runner's tool.call.start
    # event — and we don't spawn a separate orchestrator character in
    # the PixelAgents office. Derive the slug from display_name so the
    # caller can keep using human-readable strings.
    #   "Triage Agent"                    -> "triage"
    #   "Investigator Agent (re-review)"  -> "investigator"
    #   "Reporter Agent"                  -> "reporter"
    lower = display_name.lower()
    agent_slug = (
        lower.split(" agent", 1)[0].strip().replace(" ", "-") or "orchestrator"
    )

    try:
        result = _runner_post(
            runner_url,
            runner_bearer,
            {"tool_name": "update_incident", "arguments": args},
            agent=agent_slug,
        )
        # The runner wraps tool errors as {ok: false} inside a 200 OK
        # response (so agents can recover). _runner_post only raises on
        # non-2xx, so we have to inspect the envelope here to see real
        # ARM errors (e.g. incident-owner schema validation).
        body = result.get("result") if isinstance(result, dict) else None
        if isinstance(body, dict) and body.get("ok") is False:
            err = body.get("error") or body
            print(
                f"[orchestrator] owner assign to {display_name!r} rejected: {err}",
                flush=True,
            )
    except Exception as e:
        # Ownership is nice-to-have visual; don't block the pipeline.
        print(
            f"[orchestrator] owner assign to {display_name!r} raised: {e!r}",
            flush=True,
        )


def _post_incident_comment(
    runner_url: str,
    runner_bearer: str,
    incident_number: Any,
    incident_id: Any,
    body_text: str,
    *,
    agent_slug: str = "orchestrator",
) -> bool:
    """Post a Sentinel incident comment via the runner. Returns True on
    apparent success.

    Why this exists in the orchestrator: relying on the agent itself
    to call `add_incident_comment` was unreliable — the model would
    sometimes finish its turn without invoking the tool, leaving the
    case timeline missing the agent's writeback. Having the
    orchestrator post the agent's reply text as the comment after
    the agent run is a deterministic backstop: even if the agent
    forgets to call the tool, the comment lands.

    `body_text` is the agent's full reply text; we trust the prompt to
    have shaped it as the spine. If the spine is missing, the comment
    is still useful (raw agent output is better than no comment at
    all, and the human reading the case can spot the deviation).
    """
    if not body_text or not body_text.strip():
        print(
            f"[orchestrator] skipping {agent_slug} comment — empty body",
            flush=True,
        )
        return False

    args: dict[str, Any] = {"message": body_text}
    if incident_number is not None:
        args["incidentNumber"] = incident_number
    elif incident_id is not None:
        args["incidentId"] = incident_id
    else:
        return False

    try:
        result = _runner_post(
            runner_url,
            runner_bearer,
            {"tool_name": "add_incident_comment", "arguments": args},
            agent=agent_slug,
        )
        body = result.get("result") if isinstance(result, dict) else None
        if isinstance(body, dict) and body.get("ok") is False:
            err = body.get("error") or body
            print(
                f"[orchestrator] comment post for {agent_slug} rejected: {err}",
                flush=True,
            )
            return False
        return True
    except Exception as e:
        print(
            f"[orchestrator] comment post for {agent_slug} raised: {e!r}",
            flush=True,
        )
        return False


# Closure marker the reporter is supposed to write on the **Next:**
# line of its case-note spine. We match liberally — any of the
# variants (Closed (false positive), Closed/True Positive, Closed
# - benign true positive, …) maps to a status update we trigger
# from the orchestrator side.
import re as _re

_CLOSURE_RE = _re.compile(
    r"\*\*Next:\*\*[^\n]*\bStatus[^\n]*\bClosed\b[^\n]*",
    _re.IGNORECASE,
)
_CLASSIFICATION_KEYWORDS: list[tuple[str, str]] = [
    # Order matters — "benign true positive" before "true positive"
    # so the more specific match wins.
    ("benign true positive", "BenignPositive"),
    ("benign positive",      "BenignPositive"),
    ("false positive",       "FalsePositive"),
    ("true positive",        "TruePositive"),
]


def _detect_reporter_closure(reporter_text: str) -> str | None:
    """If the reporter's reply text says it's closing the incident,
    return the Sentinel classification value (FalsePositive /
    TruePositive / BenignPositive). Otherwise None.

    Driven by the spine's `**Next:** Status set to Closed (…)` line.
    A successful match means the orchestrator should call
    update_incident with status=Closed + that classification —
    independent of whether the reporter agent actually called the
    tool itself."""
    if not reporter_text:
        return None
    m = _CLOSURE_RE.search(reporter_text)
    if not m:
        return None
    line_lower = m.group(0).lower()
    for needle, classification in _CLASSIFICATION_KEYWORDS:
        if needle in line_lower:
            return classification
    # Default classification when we can detect "Closed" but not the
    # specific verdict — Undetermined is the safest.
    return "Undetermined"


def _close_incident(
    runner_url: str,
    runner_bearer: str,
    incident_number: Any,
    incident_id: Any,
    classification: str,
) -> bool:
    """Set incident.status=Closed + classification via the runner.

    Backstop for the case where the reporter's case note says it's
    closing the incident but the agent never actually called
    `update_incident`. We parse the reporter reply text for a
    closure marker (see _detect_reporter_closure) and call this if
    we find one.
    """
    args: dict[str, Any] = {
        "properties": {
            "status": "Closed",
            "classification": classification,
        }
    }
    if incident_number is not None:
        args["incidentNumber"] = incident_number
    elif incident_id is not None:
        args["id"] = incident_id
    else:
        return False

    try:
        result = _runner_post(
            runner_url,
            runner_bearer,
            {"tool_name": "update_incident", "arguments": args},
            agent="reporter",
        )
        body = result.get("result") if isinstance(result, dict) else None
        if isinstance(body, dict) and body.get("ok") is False:
            err = body.get("error") or body
            print(
                f"[orchestrator] closure (Closed/{classification}) rejected: {err}",
                flush=True,
            )
            return False
        print(
            f"[orchestrator] incident closed by orchestrator backstop: "
            f"classification={classification}",
            flush=True,
        )
        return True
    except Exception as e:
        print(
            f"[orchestrator] closure raised: {e!r}",
            flush=True,
        )
        return False


def _handle_incident_assign(req: func.HttpRequest) -> func.HttpResponse:
    """Standalone owner / status writeback. Called by pixelagents_web
    when an analyst edits the Owner or Status cell on the dashboard.
    Body: {"incidentNumber": int, "owner"?: str, "status"?: str}.

    Reuses the runner's update_incident tool (same RBAC chain the
    workflow handoff uses) without invoking any Foundry agents — no
    triage / investigator / reporter, just the ARM write."""

    body = _json(req)
    incident_number = body.get("incidentNumber")
    incident_id = body.get("incidentId")
    owner = body.get("owner")
    status = body.get("status")

    if incident_number is None and incident_id is None:
        return func.HttpResponse("Missing incidentNumber or incidentId", status_code=400)
    if owner is None and status is None:
        return func.HttpResponse(
            "Need at least one of: owner, status",
            status_code=400,
        )

    runner_url = os.environ.get("AISOC_RUNNER_URL", "")
    bearer_secret = os.environ.get("AISOC_RUNNER_BEARER_SECRET_NAME", "aisoc-runner-key")
    kv_uri = os.environ.get("KEYVAULT_URI", "")
    if not runner_url:
        return func.HttpResponse("Missing RUNNER_URL", status_code=500)
    if not kv_uri:
        return func.HttpResponse("Missing KEYVAULT_URI", status_code=500)

    try:
        runner_bearer = get_kv_secret(kv_uri, bearer_secret)
    except Exception as e:
        return func.HttpResponse(
            json.dumps({"ok": False, "error": f"runner bearer fetch failed: {e!r}"}),
            status_code=500,
            mimetype="application/json",
        )

    properties: dict[str, Any] = {}
    if isinstance(owner, str) and owner.strip():
        properties["owner"] = {"assignedTo": owner.strip()}
    if isinstance(status, str) and status.strip():
        properties["status"] = status.strip()
    if not properties:
        return func.HttpResponse("Empty owner+status", status_code=400)

    args: dict[str, Any] = {"properties": properties}
    if incident_number is not None:
        args["incidentNumber"] = incident_number
    elif incident_id is not None:
        args["id"] = incident_id

    try:
        result = _runner_post(
            runner_url,
            runner_bearer,
            {"tool_name": "update_incident", "arguments": args},
            agent="triage",  # filtered to the roster slug, no phantom row
        )
    except Exception as e:
        return func.HttpResponse(
            json.dumps({"ok": False, "error": f"runner update_incident raised: {e!r}"}),
            status_code=502,
            mimetype="application/json",
        )

    out = {
        "ok": True,
        "incident_number": incident_number,
        "incident_id": incident_id,
        "owner": owner,
        "status": status,
        "runner_result": result.get("result") if isinstance(result, dict) else None,
    }
    return func.HttpResponse(json.dumps(out), mimetype="application/json")


def _handle_create_rule(req: func.HttpRequest) -> func.HttpResponse:
    """Create a Sentinel analytic rule via the runner. Called by
    pixelagents_web's _apply_detection_rule_change after a human
    approves a detection-rule proposal in the Changes queue.

    Body is the rule definition (displayName, query, severity,
    tactics, techniques, ...). We just thread it through the
    runner's existing create_analytic_rule tool — same path the
    detection-engineer agent used to take directly before rules
    moved behind the approval queue."""

    body = _json(req)
    if not isinstance(body, dict) or not body.get("displayName") or not body.get("query"):
        return func.HttpResponse(
            "Body must be a rule definition with at least displayName + query",
            status_code=400,
        )

    runner_url = os.environ.get("AISOC_RUNNER_URL", "")
    bearer_secret = os.environ.get("AISOC_RUNNER_BEARER_SECRET_NAME", "aisoc-runner-key")
    kv_uri = os.environ.get("KEYVAULT_URI", "")
    if not runner_url:
        return func.HttpResponse("Missing RUNNER_URL", status_code=500)
    if not kv_uri:
        return func.HttpResponse("Missing KEYVAULT_URI", status_code=500)

    try:
        runner_bearer = get_kv_secret(kv_uri, bearer_secret)
    except Exception as e:
        return func.HttpResponse(
            json.dumps({"ok": False, "error": f"runner bearer fetch failed: {e!r}"}),
            status_code=500,
            mimetype="application/json",
        )

    try:
        result = _runner_post(
            runner_url,
            runner_bearer,
            {"tool_name": "create_analytic_rule", "arguments": body},
            agent="detection-engineer",
        )
    except Exception as e:
        return func.HttpResponse(
            json.dumps({"ok": False, "error": f"runner create_analytic_rule raised: {e!r}"}),
            status_code=502,
            mimetype="application/json",
        )

    return func.HttpResponse(
        json.dumps({
            "ok": True,
            "displayName": body.get("displayName"),
            "runner_result": result.get("result") if isinstance(result, dict) else None,
        }),
        mimetype="application/json",
    )


def main(req: func.HttpRequest) -> func.HttpResponse:
    route = req.route_params.get("route") or ""

    if route == "incident/assign":
        return _handle_incident_assign(req)

    if route == "sentinel/create-rule":
        return _handle_create_rule(req)

    if route not in ("incident", "incident/pipeline"):
        return func.HttpResponse("Unknown route", status_code=404)

    body = _json(req)
    incident_number = body.get("incidentNumber")
    incident_id = body.get("incidentId")

    # demo-friendly controls
    mode = (body.get("mode") or "triage_only").lower()  # triage_only | full
    max_chars = int(body.get("max_chars") or 1800)

    # Confidence thresholds (0–100). Tunes how readily each agent
    # reaches for ask_human mid-flow. Lower = cautious (ask often),
    # higher = confident (ask rarely). Per-agent values are now the
    # canonical input — `confidence_thresholds` is a dict keyed by
    # agent slug. The legacy single-int `confidence_threshold` is
    # accepted as a fallback (applied to every agent) so older PA-Web
    # builds still work until both halves redeploy. The
    # AISOC_CONFIDENCE_THRESHOLD env var is the final fallback.
    def _clamp(v: Any, default: int = 50) -> int:
        try:
            n = int(v)
        except (TypeError, ValueError):
            return default
        return max(0, min(100, n))

    fallback_threshold = _clamp(
        body.get("confidence_threshold")
        if "confidence_threshold" in body
        else os.environ.get("AISOC_CONFIDENCE_THRESHOLD", "50")
    )

    raw_thresholds = body.get("confidence_thresholds")
    confidence_thresholds: dict[str, int] = {}
    if isinstance(raw_thresholds, dict):
        for k, v in raw_thresholds.items():
            confidence_thresholds[str(k).strip().lower()] = _clamp(v, fallback_threshold)

    def _threshold_for(agent_slug: str) -> int:
        return confidence_thresholds.get(agent_slug, fallback_threshold)

    # Identity of the human who triggered this run (None / empty for
    # auto-pickup). Used two ways downstream:
    #   1. Injected into the investigator's and reporter's user_text as
    #      TRIGGERING_USER so ask_human can target this analyst by email.
    #   2. After the run, on handoff to a human (any successful run
    #      that didn't end in autonomous closure, OR failure), the
    #      Sentinel incident's owner is reassigned to this user instead
    #      of staying on the last agent. Auto-pickup runs leave the
    #      owner on whoever the orchestrator last set it to (typically
    #      Reporter Agent).
    triggering_user = (body.get("triggering_user") or "").strip()

    # A single identifier so cost records + future correlation can group
    # every agent invocation inside this orchestrator run.
    import uuid as _uuid
    workflow_run_id = str(_uuid.uuid4())

    # Workflow-level heartbeat so App Insights always shows the run was
    # received, even if a phase prints nothing on the happy path.
    print(
        f"[orchestrator] workflow event=start "
        f"workflow_run_id={workflow_run_id} "
        f"incident_number={incident_number} incident_id={incident_id} mode={mode}",
        flush=True,
    )

    if incident_number is None and incident_id is None:
        return func.HttpResponse("Missing incidentNumber or incidentId", status_code=400)

    project_endpoint = os.environ.get("AZURE_AI_FOUNDRY_PROJECT_ENDPOINT", "")
    runner_url = os.environ.get("RUNNER_URL", "")
    kv_uri = os.environ.get("KEYVAULT_URI", "")
    bearer_secret = os.environ.get("AISOC_RUNNER_BEARER_SECRET_NAME", "AISOC-RUNNER-BEARER")

    if not project_endpoint:
        return func.HttpResponse("Missing AZURE_AI_FOUNDRY_PROJECT_ENDPOINT", status_code=500)
    if not runner_url:
        return func.HttpResponse("Missing RUNNER_URL", status_code=500)
    if not kv_uri:
        return func.HttpResponse("Missing KEYVAULT_URI", status_code=500)

    try:
        runner_bearer = get_kv_secret(kv_uri, bearer_secret)

        # Fetch incident context via runner
        if incident_number is not None:
            inc = _runner_post(
                runner_url,
                runner_bearer,
                {"tool_name": "get_incident", "arguments": {"incidentNumber": incident_number}},
                agent="triage",
            )
        else:
            inc = _runner_post(
                runner_url,
                runner_bearer,
                {"tool_name": "get_incident", "arguments": {"id": incident_id}},
                agent="triage",
            )

        incident_json = json.dumps(inc.get("result"), indent=2)[:12000]

        # Pull the alert's evidence window out of the incident JSON
        # and surface it as an explicit ALERT_WINDOW block in the
        # agent's user_text. The agent was previously expected to
        # extract `properties.firstActivityTimeUtc` / `lastActivityTimeUtc`
        # itself — error-prone in practice (LLMs miscount nested
        # JSON) and the consequence was the agent picking a
        # ±5-minute window that excluded the rule's own evidence.
        #
        # We bracket the alert window by ±15 minutes for the
        # KQL-anchor hint we hand to the agent. This matches the
        # rule's lookback (PT15M for the SCP failed-login rule) so
        # any row the rule found is within the suggested window.
        # If the incident JSON doesn't carry these fields (older
        # API versions, partial extraction), the block reads
        # "unknown" and the agent falls back to ago(2h) per its
        # instructions.
        from datetime import datetime, timezone, timedelta
        def _parse_iso(value: Any) -> datetime | None:
            if not isinstance(value, str) or not value:
                return None
            v = value.strip().replace("Z", "+00:00")
            try:
                return datetime.fromisoformat(v)
            except Exception:
                return None
        inc_props = (inc.get("result") or {}).get("properties") or {} if isinstance(inc, dict) else {}
        first_activity = _parse_iso(inc_props.get("firstActivityTimeUtc")) \
                         or _parse_iso(inc_props.get("firstActivityTime"))
        last_activity  = _parse_iso(inc_props.get("lastActivityTimeUtc")) \
                         or _parse_iso(inc_props.get("lastActivityTime"))
        if first_activity and last_activity:
            window_start = (first_activity - timedelta(minutes=15)).replace(microsecond=0).isoformat().replace("+00:00", "Z")
            window_end   = (last_activity  + timedelta(minutes=15)).replace(microsecond=0).isoformat().replace("+00:00", "Z")
            alert_window_block = (
                f"ALERT_WINDOW: {window_start} .. {window_end}\n"
                f"  (firstActivityTimeUtc = {inc_props.get('firstActivityTimeUtc') or inc_props.get('firstActivityTime')}, "
                f"lastActivityTimeUtc = {inc_props.get('lastActivityTimeUtc') or inc_props.get('lastActivityTime')}; "
                f"bracketed by ±15 min so the rule's lookback is fully covered.)\n"
                "Use this window when running KQL against ContainerAppConsoleLogs_CL "
                "to reproduce what the analytic rule found. Don't tighten it.\n\n"
            )
        else:
            alert_window_block = (
                "ALERT_WINDOW: unknown — the incident JSON didn't carry "
                "firstActivityTimeUtc / lastActivityTimeUtc. Default to "
                "`TimeGenerated > ago(2h)` for any KQL anchor; widen if "
                "your first query returns 0 rows.\n\n"
            )

        # Promote the incident from "New" -> "Active" before the first
        # agentic phase begins. Per the UI design, any workflow run —
        # auto-pickup OR manual — moves the incident into the Active
        # state so the dashboard pill flips to "Active · Agentic
        # Analysis". The call is idempotent against an already-Active
        # incident; on a Closed incident the manual re-trigger will
        # re-open it (which matches the "human asked for more work"
        # branch of the design). Best-effort — failures don't block the
        # pipeline.
        _set_incident_status(runner_url, runner_bearer, incident_number, incident_id, "Active")

        # Call agents via Foundry Agent Service runtime (agents + responses).
        # Each phase: (1) assign the incident to the agent so the UI +
        # Sentinel reflect "who's handling this right now", (2) log a
        # heartbeat, (3) invoke the agent, (4) emit a cost record from
        # response.usage, (5) log the phase-end heartbeat.
        _assign_incident_owner(runner_url, runner_bearer, incident_number, incident_id, "Triage Agent")
        _t = _phase_start(
            phase="triage",
            incident_number=incident_number,
            incident_id=incident_id,
            workflow_run_id=workflow_run_id,
        )
        # Run-context block — gives the agent the literal values it
        # should drop into the comment-spine `**Run:**` line. Without
        # this, the triage prompt told the agent to fall back to the
        # angle-bracket placeholder text (`<orchestrator_run_id>`),
        # which Sentinel's incident-comment renderer then strips as
        # if it were an unknown HTML tag — leaving the activity log
        # with a blank `Run:` line and visually empty body.
        from datetime import datetime, timezone
        run_started_at = datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
        # Short, human-friendly handle that's still unique within the
        # demo. Full UUID is overkill for an audit comment line.
        run_short = workflow_run_id[:8]
        run_context_block = (
            f"RUN_ID: {run_short}\n"
            f"RUN_STARTED_AT: {run_started_at}\n"
            "Use these values literally when filling the `**Run:**` line "
            "of the comment spine. Never write angle-bracket placeholders "
            "like `<orchestrator_run_id>` — Sentinel's comment renderer "
            "strips them as HTML, leaving the line blank.\n\n"
        )

        triage_out, triage_raw = _invoke_agent(
            project_endpoint,
            "triage",
            user_text=(
                "You are the TRIAGE agent. Use the AISOC Runner OpenAPI tool "
                "to fetch incident and context. Return a triage summary "
                "matching the spine in your instructions (header / Run / "
                "Summary / Entities / Findings / Confidence / Next).\n\n"
                "Do NOT call `add_incident_comment` yourself — the "
                "orchestrator will post your reply text as the Sentinel "
                "comment after your run completes. Just produce the spine "
                "in your final reply.\n\n"
                + run_context_block
                + alert_window_block
                + f"INCIDENT_REF:\n{incident_json}"
            ),
        )
        # Backstop: post the agent's reply text as a Sentinel comment.
        # Replaces the agent-side `add_incident_comment` call, which
        # was unreliable (model would sometimes skip the tool).
        _post_incident_comment(
            runner_url, runner_bearer,
            incident_number, incident_id,
            triage_out,
            agent_slug="triage",
        )
        _phase_end(
            phase="triage",
            started=_t,
            workflow_run_id=workflow_run_id,
            usage=triage_raw.get("usage"),
        )
        _emit_cost_record(
            incident_number=incident_number,
            incident_id=incident_id,
            agent_name="triage",
            phase="triage",
            usage=triage_raw.get("usage"),
            workflow_run_id=workflow_run_id,
        )

        if mode == "triage_only":
            # Triage-only runs don't reach the reporter (and so can't
            # close the incident), so the workflow MUST end with the
            # incident assigned to a human — leaving it on "Triage
            # Agent" would strand it in agent-owned land. Apply the
            # same Pass-4 handoff logic the full pipeline uses at the
            # end.
            owner_handoff_to: str | None = None
            if triggering_user:
                try:
                    _assign_incident_owner(
                        runner_url, runner_bearer,
                        incident_number, incident_id,
                        triggering_user,
                    )
                    owner_handoff_to = triggering_user
                    print(
                        f"[orchestrator] triage_only handoff: "
                        f"incident_number={incident_number} "
                        f"owner -> {triggering_user!r}",
                        flush=True,
                    )
                except Exception as e:
                    print(
                        f"[orchestrator] triage_only handoff to "
                        f"{triggering_user!r} raised: {e!r}",
                        flush=True,
                    )

            out = {
                "ok": True,
                "mode": mode,
                "incident_ref": {"incidentNumber": incident_number, "incidentId": incident_id},
                "triage": {"raw": _clip(triage_out, max_chars)},
                "triggering_user": triggering_user or None,
                "owner_handoff_to": owner_handoff_to,
            }
            return func.HttpResponse(json.dumps(out), mimetype="application/json")

        # Shared blocks injected into the investigator + reporter prompts.
        # CONFIDENCE_THRESHOLD tunes how readily that agent reaches for
        # ask_human; TRIGGERING_USER lets ask_human target the right
        # analyst. Each agent gets ITS OWN threshold value — the
        # operator can dial them independently from /config.
        def _confidence_block(agent_slug: str) -> str:
            v = _threshold_for(agent_slug)
            return (
                f"CONFIDENCE_THRESHOLD: {v}%\n"
                "This is a 0–100 dial the human operator set specifically "
                "for you. It controls how readily you should reach for "
                "`ask_human` mid-flow. Lower values mean the operator wants "
                "you to be cautious and ask often when something is "
                "ambiguous. Higher values mean the operator trusts you to "
                "push through on your own and only interrupt them when "
                "you're truly stuck. 50 is neutral. Use this as a soft "
                "prior — never as license to make up evidence you don't "
                "have, and never as a reason to skip a writeback the case "
                "clearly needs.\n\n"
            )

        if triggering_user:
            triggering_user_block = (
                f"TRIGGERING_USER: {triggering_user}\n"
                "This is the human analyst who triggered this run from the "
                "dashboard. When you call `ask_human`, pass `target` with "
                "this email so the question is routed to them specifically "
                "rather than broadcast to every signed-in analyst.\n\n"
            )
        else:
            triggering_user_block = (
                "TRIGGERING_USER: (auto-pickup — no specific human triggered this run)\n"
                "Use `ask_human` without a `target` argument so the question "
                "is broadcast to every signed-in analyst.\n\n"
            )

        _assign_incident_owner(runner_url, runner_bearer, incident_number, incident_id, "Investigator Agent")
        _t = _phase_start(
            phase="investigator",
            incident_number=incident_number,
            incident_id=incident_id,
            workflow_run_id=workflow_run_id,
        )
        inv_out, inv_raw = _invoke_agent(
            project_endpoint,
            "investigator",
            user_text=(
                "You are the INVESTIGATOR agent. Use the AISOC Runner "
                "OpenAPI tool to fetch incident details and run relevant "
                "KQL queries. Ground findings in evidence and produce a "
                "short timeline + verdict. You may call `ask_human` "
                "mid-investigation when you genuinely need a human-in-the-"
                "loop steer (clarifying scope, picking between competing "
                "hypotheses, confirming an assumption). Use the "
                "CONFIDENCE_THRESHOLD below to decide how readily to do "
                "so — at the same incident_number so the question shows "
                "up under the right case in the human's queue.\n\n"
                "Do NOT call `add_incident_comment` yourself — the "
                "orchestrator will post your reply text as the Sentinel "
                "comment after your run completes. Just produce the "
                "spine in your final reply (header / Run / Summary / "
                "Entities (resolved) / Findings / Timeline / Confidence "
                "/ Next). The orchestrator treats your reply text AS the "
                "comment body, so include the spine literally — no extra "
                "prose around it.\n\n"
                + run_context_block
                + alert_window_block
                + _confidence_block("investigator")
                + triggering_user_block
                + f"INCIDENT_NUMBER: {incident_number}\n\n"
                + f"INCIDENT_REF:\n{incident_json}\n\n"
                + f"TRIAGE_OUTPUT:\n{_clip(triage_out, 4000)}"
            ),
        )
        # Backstop: post the investigator's reply text as a Sentinel
        # comment. Same reason as the triage backstop above.
        _post_incident_comment(
            runner_url, runner_bearer,
            incident_number, incident_id,
            inv_out,
            agent_slug="investigator",
        )
        _phase_end(
            phase="investigator",
            started=_t,
            workflow_run_id=workflow_run_id,
            usage=inv_raw.get("usage"),
        )
        _emit_cost_record(
            incident_number=incident_number,
            incident_id=incident_id,
            agent_name="investigator",
            phase="investigator",
            usage=inv_raw.get("usage"),
            workflow_run_id=workflow_run_id,
        )

        # Writeback is now controlled by the reporter's own prompt (it must
        # gate on ask_human / confidence). The body flag is kept for
        # backwards compat but no longer injected into the prompt text —
        # the reporter decides.
        _ = bool(body.get("writeback"))

        def _invoke_reporter(investigator_output: str) -> tuple[str, dict]:
            return _invoke_agent(
                project_endpoint,
                "reporter",
                user_text=(
                    "You are the REPORTER agent. Produce a Sentinel-ready "
                    "case note that drives the verdict + status decision. "
                    "When you are reasonably sure but not certain, call "
                    "`ask_human` for a free-text approval at the same "
                    "incident_number, then continue. Use the "
                    "CONFIDENCE_THRESHOLD below to calibrate how readily "
                    "to ask vs. act on your own.\n\n"
                    "Required tool sequence:\n"
                    "1. Call `get_template({\"kind\": \"incident-comment\"})` "
                    "FIRST, before drafting anything. The returned "
                    "`content` is your case-note skeleton — keep all "
                    "section headings and order, replace bracketed "
                    "placeholders with incident-specific content. NEVER "
                    "write a short free-form comment in place of the "
                    "template.\n"
                    "2. In the `**Run:**` line, substitute the literal "
                    "`RUN_ID` and `RUN_STARTED_AT` values from the "
                    "run-context block below — never angle-bracket "
                    "placeholders.\n\n"
                    "Do NOT call `add_incident_comment` or `update_incident` "
                    "yourself. The orchestrator handles both writebacks "
                    "based on your reply:\n"
                    "  - your reply text IS the comment body (filled "
                    "    template, including the **Next:** Status set to "
                    "    Closed (...) line that drives the closure "
                    "    decision);\n"
                    "  - if your reply's `**Next:**` line says "
                    "    `Status set to Closed (<verdict>)`, the "
                    "    orchestrator closes the incident in Sentinel "
                    "    with classification matching <verdict> "
                    "    (FalsePositive / TruePositive / BenignPositive).\n"
                    "Implication: be precise on the **Next:** line. The "
                    "orchestrator parses it. Examples it understands:\n"
                    "  **Next:** Status set to Closed (false positive — duplicate alert).\n"
                    "  **Next:** Status set to Closed (true positive, contained).\n"
                    "  **Next:** Status set to Closed (benign true positive — captain mistyped).\n"
                    "  **Next:** Status set to Active (escalated to L3 — see comment).\n"
                    "If you write 'Status set to Active' (anything that "
                    "isn't Closed), the orchestrator leaves the incident "
                    "open. So don't say you'll close in prose if you mean "
                    "the case stays Active.\n\n"
                    + run_context_block
                    + _confidence_block("reporter")
                    + triggering_user_block
                    + f"INCIDENT_NUMBER: {incident_number}\n\n"
                    + f"INCIDENT_REF:\n{incident_json}\n\n"
                    + f"TRIAGE_OUTPUT:\n{_clip(triage_out, 4000)}\n\n"
                    + f"INVESTIGATOR_OUTPUT:\n{_clip(investigator_output, 8000)}"
                ),
            )

        _assign_incident_owner(runner_url, runner_bearer, incident_number, incident_id, "Reporter Agent")
        _t = _phase_start(
            phase="reporter",
            incident_number=incident_number,
            incident_id=incident_id,
            workflow_run_id=workflow_run_id,
        )
        rep_out, rep_raw = _invoke_reporter(inv_out)
        _phase_end(
            phase="reporter",
            started=_t,
            workflow_run_id=workflow_run_id,
            usage=rep_raw.get("usage"),
        )
        _emit_cost_record(
            incident_number=incident_number,
            incident_id=incident_id,
            agent_name="reporter",
            phase="reporter",
            usage=rep_raw.get("usage"),
            workflow_run_id=workflow_run_id,
        )
        # Backstop: post the reporter's reply text as a Sentinel
        # comment AND, if the reply's `**Next:**` line says it's
        # closing the incident, drive the closure ourselves.
        # NEEDS_REINVESTIGATION takes precedence — if the reporter
        # is asking for another investigator pass, don't post the
        # comment yet (the next iteration will produce the final one).
        _maybe_note = _extract_reinvestigation(rep_out)
        if not _maybe_note:
            _post_incident_comment(
                runner_url, runner_bearer,
                incident_number, incident_id,
                rep_out,
                agent_slug="reporter",
            )
            _classification = _detect_reporter_closure(rep_out)
            if _classification:
                _close_incident(
                    runner_url, runner_bearer,
                    incident_number, incident_id,
                    _classification,
                )

        # Reinvestigation loop — if the reporter emits NEEDS_REINVESTIGATION,
        # re-run the investigator with the human's feedback as extra context
        # and then re-run the reporter. Capped to avoid infinite loops.
        MAX_REINVESTIGATIONS = 1
        reinvestigation_count = 0
        reinvestigation_history: list[dict] = []
        while reinvestigation_count < MAX_REINVESTIGATIONS:
            note = _extract_reinvestigation(rep_out)
            if not note:
                break

            reinvestigation_count += 1
            prior_inv_out = inv_out  # snapshot for the record
            prior_rep_out = rep_out

            _assign_incident_owner(runner_url, runner_bearer, incident_number, incident_id, "Investigator Agent (re-review)")
            _t = _phase_start(
                phase=f"investigator-rerun-{reinvestigation_count}",
                incident_number=incident_number,
                incident_id=incident_id,
                workflow_run_id=workflow_run_id,
                iteration=reinvestigation_count,
            )
            inv_out, inv_raw = _invoke_agent(
                project_endpoint,
                "investigator",
                user_text=(
                    "You are the INVESTIGATOR agent. The reporter flagged the case "
                    "for reinvestigation after a human review. Re-investigate with "
                    "the new context below. Run additional KQL queries as needed; "
                    "do not simply restate the prior investigation.\n\n"
                    + f"INCIDENT_REF:\n{incident_json}\n\n"
                    + f"PRIOR_TRIAGE:\n{_clip(triage_out, 3000)}\n\n"
                    + f"PRIOR_INVESTIGATION:\n{_clip(prior_inv_out, 5000)}\n\n"
                    + f"HUMAN_FEEDBACK_VIA_REPORTER:\n{note}"
                ),
            )
            _phase_end(
                phase=f"investigator-rerun-{reinvestigation_count}",
                started=_t,
                workflow_run_id=workflow_run_id,
                usage=inv_raw.get("usage"),
            )
            _emit_cost_record(
                incident_number=incident_number,
                incident_id=incident_id,
                agent_name="investigator",
                phase=f"investigator-rerun-{reinvestigation_count}",
                usage=inv_raw.get("usage"),
                workflow_run_id=workflow_run_id,
            )

            _assign_incident_owner(runner_url, runner_bearer, incident_number, incident_id, "Reporter Agent (re-review)")
            _t = _phase_start(
                phase=f"reporter-rerun-{reinvestigation_count}",
                incident_number=incident_number,
                incident_id=incident_id,
                workflow_run_id=workflow_run_id,
                iteration=reinvestigation_count,
            )
            rep_out, rep_raw = _invoke_reporter(inv_out)
            _phase_end(
                phase=f"reporter-rerun-{reinvestigation_count}",
                started=_t,
                workflow_run_id=workflow_run_id,
                usage=rep_raw.get("usage"),
            )
            _emit_cost_record(
                incident_number=incident_number,
                incident_id=incident_id,
                agent_name="reporter",
                phase=f"reporter-rerun-{reinvestigation_count}",
                usage=rep_raw.get("usage"),
                workflow_run_id=workflow_run_id,
            )

            reinvestigation_history.append(
                {
                    "note": note,
                    "investigation": _clip(inv_out, 4000),
                    "report": _clip(rep_out, 4000),
                    "prior_report": _clip(prior_rep_out, 2000),
                }
            )

        # Detect whether the reporter actually invoked a write tool inside Foundry.
        # Without this the response would carry a perpetual null for wrote_comment.
        write_hits = _detect_tool_calls(rep_raw, {"add_incident_comment", "update_incident"})
        wrote_comment: Any = (
            {"count": len(write_hits), "calls": write_hits} if write_hits else False
        )

        # Did the reporter close the incident outright? With auto-close
        # gone as a global setting, the reporter is always free to close
        # via update_incident with status="Closed" when sufficiently
        # confident. We surface that decision to the dashboard by
        # inspecting the reporter's tool calls.
        def _is_close_call(call: dict) -> bool:
            args = call.get("arguments") or {}
            if call.get("name") != "update_incident":
                return False
            props = args.get("properties") if isinstance(args, dict) else None
            status = (props or {}).get("status") if isinstance(props, dict) else None
            return isinstance(status, str) and status.strip().lower() == "closed"

        did_close = any(_is_close_call(c) for c in write_hits)

        # Pass 4 — Sentinel owner attribution on handoff. If the run
        # didn't end in autonomous closure AND a human triggered it,
        # reassign the incident owner from "Reporter Agent" to that
        # human's email. That puts the case in their queue in Sentinel,
        # matching the UI's "Active · Human Analysis" state.
        #
        # Auto-pickup runs (no triggering_user) leave the owner on
        # whoever the orchestrator last set it to (typically Reporter
        # Agent). Per Erik's design: "auto-pickup should follow the
        # actual state — the current agent or human assigned to it."
        owner_handoff_to: str | None = None
        if not did_close and triggering_user:
            try:
                _assign_incident_owner(
                    runner_url, runner_bearer,
                    incident_number, incident_id,
                    triggering_user,
                )
                owner_handoff_to = triggering_user
                print(
                    f"[orchestrator] handoff: incident_number={incident_number} "
                    f"owner -> {triggering_user!r}",
                    flush=True,
                )
            except Exception as e:
                # Best-effort — don't fail the whole pipeline over a
                # final ownership write that didn't take.
                print(
                    f"[orchestrator] handoff to {triggering_user!r} raised: {e!r}",
                    flush=True,
                )

        def _maybe_json(s: str) -> Any:
            s = (s or "").strip()
            if s.startswith("{"):
                try:
                    return json.loads(s)
                except Exception:
                    return {"raw": _clip(s, max_chars)}
            return {"raw": _clip(s, max_chars)}

        out = {
            "ok": True,
            "mode": mode,
            "incident_ref": {"incidentNumber": incident_number, "incidentId": incident_id},
            "triage": _maybe_json(triage_out),
            "investigation": _maybe_json(inv_out),
            "report": _maybe_json(rep_out),
            # True iff the reporter chose to close the incident outright
            # via update_incident(status="Closed"). The reporter is free
            # to do that whenever it's confident the case is a false
            # positive; the CONFIDENCE_THRESHOLD biases that decision.
            "did_close": did_close,
            "confidence_threshold": fallback_threshold,
            "confidence_thresholds": {
                "investigator": _threshold_for("investigator"),
                "reporter":     _threshold_for("reporter"),
            },
            "triggering_user": triggering_user or None,
            "owner_handoff_to": owner_handoff_to,
            "wrote_comment": wrote_comment,
            # Number of reinvestigation loops the reporter triggered
            # (0 = the first reporter run was approved or wrote directly;
            # N > 0 = the human rejected N times and the investigator +
            # reporter re-ran). Full per-iteration trace lives in
            # reinvestigation_history for debugging.
            "reinvestigations": reinvestigation_count,
            "reinvestigation_history": reinvestigation_history,
        }
        return func.HttpResponse(json.dumps(out), mimetype="application/json")

    except Exception as e:
        return func.HttpResponse(json.dumps({"ok": False, "error": str(e)}), status_code=500, mimetype="application/json")
