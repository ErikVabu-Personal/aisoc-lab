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

    try:
        result = _runner_post(
            runner_url,
            runner_bearer,
            {"tool_name": "update_incident", "arguments": args},
            agent="orchestrator",
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


def main(req: func.HttpRequest) -> func.HttpResponse:
    route = req.route_params.get("route") or ""

    if route not in ("incident", "incident/pipeline"):
        return func.HttpResponse("Unknown route", status_code=404)

    body = _json(req)
    incident_number = body.get("incidentNumber")
    incident_id = body.get("incidentId")

    # demo-friendly controls
    mode = (body.get("mode") or "triage_only").lower()  # triage_only | full
    max_chars = int(body.get("max_chars") or 1800)

    # A single identifier so cost records + future correlation can group
    # every agent invocation inside this orchestrator run.
    import uuid as _uuid
    workflow_run_id = str(_uuid.uuid4())

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

        # Call agents via Foundry Agent Service runtime (agents + responses).
        # Each phase: (1) assign the incident to the agent so the UI +
        # Sentinel reflect "who's handling this right now", (2) invoke
        # the agent, (3) emit a cost record from response.usage.
        _assign_incident_owner(runner_url, runner_bearer, incident_number, incident_id, "Triage Agent")
        triage_out, triage_raw = _invoke_agent(
            project_endpoint,
            "triage",
            user_text=(
                "You are the TRIAGE agent. Use the AISOC Runner OpenAPI tool to fetch incident and context. "
                "Return a concise triage summary and immediate next steps.\n\n"
                + f"INCIDENT_REF:\n{incident_json}"
            ),
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
            out = {
                "ok": True,
                "mode": mode,
                "incident_ref": {"incidentNumber": incident_number, "incidentId": incident_id},
                "triage": {"raw": _clip(triage_out, max_chars)},
            }
            return func.HttpResponse(json.dumps(out), mimetype="application/json")

        _assign_incident_owner(runner_url, runner_bearer, incident_number, incident_id, "Investigator Agent")
        inv_out, inv_raw = _invoke_agent(
            project_endpoint,
            "investigator",
            user_text=(
                "You are the INVESTIGATOR agent. Use the AISOC Runner OpenAPI tool to fetch incident details and run relevant KQL queries. "
                "Ground findings in evidence and produce a short timeline + verdict.\n\n"
                + f"INCIDENT_REF:\n{incident_json}\n\nTRIAGE_OUTPUT:\n{_clip(triage_out, 4000)}"
            ),
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

        def _invoke_reporter(investigator_output: str) -> tuple[str, dict]:
            return _invoke_agent(
                project_endpoint,
                "reporter",
                user_text=(
                    "You are the REPORTER agent. Produce an executive summary, draft "
                    "a Sentinel-ready case note, and propose a status change. Per "
                    "your instructions, call ask_human to validate before writing "
                    "anything back via add_incident_comment / update_incident.\n\n"
                    + f"INCIDENT_REF:\n{incident_json}\n\n"
                    + f"TRIAGE_OUTPUT:\n{_clip(triage_out, 4000)}\n\n"
                    + f"INVESTIGATOR_OUTPUT:\n{_clip(investigator_output, 8000)}"
                ),
            )

        _assign_incident_owner(runner_url, runner_bearer, incident_number, incident_id, "Reporter Agent")
        rep_out, rep_raw = _invoke_reporter(inv_out)
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
            _emit_cost_record(
                incident_number=incident_number,
                incident_id=incident_id,
                agent_name="investigator",
                phase=f"investigator-rerun-{reinvestigation_count}",
                usage=inv_raw.get("usage"),
                workflow_run_id=workflow_run_id,
            )

            _assign_incident_owner(runner_url, runner_bearer, incident_number, incident_id, "Reporter Agent (re-review)")
            rep_out, rep_raw = _invoke_reporter(inv_out)
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

        auto_close = os.environ.get("AISOC_AUTO_CLOSE", "0") == "1"
        did_close = False
        if auto_close:
            # Best-effort close
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
