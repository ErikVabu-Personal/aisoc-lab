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

# Case-sensitive marker the reporter emits when (a) auto-close mode is
# active for this run AND (b) the reporter is confident the case can be
# closed without human review. The orchestrator gates the autonomous
# Sentinel close call on the presence of this marker. See
# agents/instructions/reporter.md for the prompt-side contract.
_CLOSE_RECOMMENDED_RE = re.compile(r"CLOSE_RECOMMENDED:\s*(.+?)(?:\n|$)")


def _extract_reinvestigation(text: str) -> str | None:
    if not isinstance(text, str):
        return None
    m = _REINVESTIGATION_RE.search(text)
    return m.group(1).strip() if m else None


def _extract_close_recommendation(text: str) -> str | None:
    """Reporter's confidence signal for autonomous closure. Returns the
    rationale string when the marker is present, else None.
    Independent of NEEDS_REINVESTIGATION — they're mutually exclusive
    by design (the reporter's prompt says so), but we don't enforce
    that here; the close path will simply not fire if both somehow
    appear, because we only look for CLOSE_RECOMMENDED *after*
    confirming no reinvestigation was requested."""
    if not isinstance(text, str):
        return None
    m = _CLOSE_RECOMMENDED_RE.search(text)
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


def main(req: func.HttpRequest) -> func.HttpResponse:
    route = req.route_params.get("route") or ""

    if route == "incident/assign":
        return _handle_incident_assign(req)

    if route not in ("incident", "incident/pipeline"):
        return func.HttpResponse("Unknown route", status_code=404)

    body = _json(req)
    incident_number = body.get("incidentNumber")
    incident_id = body.get("incidentId")

    # demo-friendly controls
    mode = (body.get("mode") or "triage_only").lower()  # triage_only | full
    max_chars = int(body.get("max_chars") or 1800)

    # Auto-close: when True, the reporter is permitted to recommend
    # autonomous closure (see CLOSE_RECOMMENDED marker contract in
    # agents/instructions/reporter.md). Body value takes precedence;
    # AISOC_AUTO_CLOSE=1 in the environment is preserved as a fallback
    # so older callers (and CI smoke tests) keep working.
    if "auto_close" in body:
        auto_close = bool(body.get("auto_close"))
    else:
        auto_close = os.environ.get("AISOC_AUTO_CLOSE", "0") == "1"

    # Identity of the human who triggered this run (None / empty for
    # auto-pickup). Used two ways downstream:
    #   1. Injected into the reporter's user_text as TRIGGERING_USER
    #      so ask_human can target this analyst by email.
    #   2. After the run, on handoff to a human (success without
    #      auto-close OR failure), the Sentinel incident's owner is
    #      reassigned to this user instead of staying on the last
    #      agent. Auto-pickup runs leave the owner on whoever the
    #      orchestrator last set it to (typically Reporter Agent).
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
        triage_out, triage_raw = _invoke_agent(
            project_endpoint,
            "triage",
            user_text=(
                "You are the TRIAGE agent. Use the AISOC Runner OpenAPI tool to fetch incident and context. "
                "Return a concise triage summary and immediate next steps.\n\n"
                + f"INCIDENT_REF:\n{incident_json}"
            ),
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
            # Triage-only runs don't reach the reporter and never
            # auto-close, so the workflow MUST end with the incident
            # assigned to a human — leaving it on "Triage Agent"
            # would strand it in agent-owned land. Apply the same
            # Pass-4 handoff logic the full pipeline uses at the end.
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
                "You are the INVESTIGATOR agent. Use the AISOC Runner OpenAPI tool to fetch incident details and run relevant KQL queries. "
                "Ground findings in evidence and produce a short timeline + verdict.\n\n"
                + f"INCIDENT_REF:\n{incident_json}\n\nTRIAGE_OUTPUT:\n{_clip(triage_out, 4000)}"
            ),
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
        # gate on ask_human). The body flag is kept for backwards compat but
        # no longer injected into the prompt text — the reporter decides.
        _ = bool(body.get("writeback"))

        # When auto-close is on, tell the reporter explicitly so it can
        # take the autonomous-close branch in its instructions (skip
        # ask_human and emit CLOSE_RECOMMENDED when confident). When
        # off, the reporter MUST follow the ask_human flow regardless
        # of confidence — this is the user's safety contract.
        auto_close_block = (
            f"AUTO_CLOSE_MODE: {'on' if auto_close else 'off'}\n"
            + ("When AUTO_CLOSE_MODE is 'on' and the case is unambiguous "
               "(clear benign explanation, low severity, no signs of "
               "compromise), you MAY skip ask_human, write the case note "
               "via add_incident_comment, and emit a single-line "
               "`CLOSE_RECOMMENDED: <one-sentence rationale>` marker — "
               "the orchestrator will perform the actual Sentinel close "
               "call. When AUTO_CLOSE_MODE is 'off', follow the normal "
               "ask_human flow regardless of your confidence."
               if auto_close else
               "AUTO_CLOSE_MODE is off — follow the normal ask_human "
               "flow. Do NOT emit CLOSE_RECOMMENDED.")
            + "\n\n"
        )

        # When a human kicked off this run (manual trigger from the
        # dashboard), tell the reporter who it is so ask_human can
        # target them by email. Auto-pickup runs leave this empty and
        # the reporter falls back to broadcast (legacy behaviour).
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

        def _invoke_reporter(investigator_output: str) -> tuple[str, dict]:
            return _invoke_agent(
                project_endpoint,
                "reporter",
                user_text=(
                    "You are the REPORTER agent. Produce an executive summary, draft "
                    "a Sentinel-ready case note, and propose a status change. Per "
                    "your instructions, call ask_human to validate before writing "
                    "anything back via add_incident_comment / update_incident.\n\n"
                    + auto_close_block
                    + triggering_user_block
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

        # Auto-close path. Two conditions must be true to fire:
        #   1. auto_close was passed into this run (request body or
        #      env-var fallback — resolved at function entry).
        #   2. The reporter emitted CLOSE_RECOMMENDED, signalling that
        #      the case is unambiguous enough to close without a human.
        # Either condition false => no autonomous close. The case may
        # still get closed via the reporter's own ask_human-approved
        # update_incident tool call (which would show up in
        # `wrote_comment.calls`), but that's a separate path.
        close_rationale = _extract_close_recommendation(rep_out)
        did_close = False
        close_skip_reason: str | None = None
        if not auto_close:
            close_skip_reason = "auto_close=False"
        elif not close_rationale:
            close_skip_reason = "no CLOSE_RECOMMENDED marker"
        else:
            _runner_post(
                runner_url,
                runner_bearer,
                {
                    "tool_name": "update_incident",
                    "arguments": {
                        "incidentNumber": incident_number,
                        "properties": {"status": "Closed"},
                    },
                },
                agent="reporter",
            )
            did_close = True
            print(
                f"[orchestrator] auto-close fired "
                f"workflow_run_id={workflow_run_id} "
                f"incident_number={incident_number} "
                f"rationale={close_rationale!r}",
                flush=True,
            )

        # Pass 4 — Sentinel owner attribution on handoff. If the run
        # didn't auto-close AND a human triggered it, reassign the
        # incident owner from "Reporter Agent" to that human's email.
        # That puts the case in their queue in Sentinel, matching the
        # UI's "Active · Human Analysis" state.
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
            "did_close": did_close,
            # Auto-close diagnostics — useful for the dashboard to
            # explain "agents closed because X" or "agents could have
            # closed but auto_close=False". One of these is None.
            "close_rationale": close_rationale if did_close else None,
            "close_skipped_reason": close_skip_reason,
            "auto_close_mode": auto_close,
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
