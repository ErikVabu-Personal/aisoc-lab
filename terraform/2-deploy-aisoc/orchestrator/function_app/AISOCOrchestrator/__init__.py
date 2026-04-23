from __future__ import annotations

import json
import os
from typing import Any, Dict

import azure.functions as func
import requests
from azure.identity import DefaultAzureCredential

from shared.kv import get_kv_secret


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


def _model_call(project_endpoint: str, model_deployment: str, system: str, user: str) -> str:
    """Call Foundry model.

    We avoid depending on a specific azure-ai-projects SDK "inference" surface because it changes
    between versions (and can break at runtime). Instead, call the Foundry inference REST endpoint
    directly using DefaultAzureCredential.

    Expected env vars:
      - AZURE_AI_FOUNDRY_PROJECT_ENDPOINT: https://<resource>.services.ai.azure.com/api/projects/<project>
      - AZURE_AI_MODEL_DEPLOYMENT: deployment name (e.g. model-router)
    """

    # Derive base resource URL from the project endpoint.
    # Example:
    #   https://...services.ai.azure.com/api/projects/<project>
    # -> https://...services.ai.azure.com
    base = project_endpoint.split("/api/projects/")[0].rstrip("/")

    # Foundry inference is compatible with Azure OpenAI-style chat completions under /openai/deployments/.../chat/completions
    # (this is the stable path across many Foundry setups).
    url = f"{base}/openai/deployments/{model_deployment}/chat/completions?api-version=2024-06-01"

    token = DefaultAzureCredential().get_token("https://cognitiveservices.azure.com/.default").token

    r = requests.post(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        json={
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": 0.2,
        },
        timeout=90,
    )

    if r.status_code >= 400:
        raise RuntimeError(f"Foundry inference failed ({r.status_code}): {r.text[:4000]}")

    data = r.json()
    try:
        return data["choices"][0]["message"]["content"]
    except Exception:
        raise RuntimeError(f"Unexpected Foundry response shape: {json.dumps(data)[:2000]}")


def _clip(s: str, max_chars: int) -> str:
    s = s or ""
    return s if len(s) <= max_chars else (s[: max_chars - 3] + "...")


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

    if incident_number is None and incident_id is None:
        return func.HttpResponse("Missing incidentNumber or incidentId", status_code=400)

    project_endpoint = os.environ.get("AZURE_AI_FOUNDRY_PROJECT_ENDPOINT", "")
    model_deployment = os.environ.get("AZURE_AI_MODEL_DEPLOYMENT", "")
    runner_url = os.environ.get("RUNNER_URL", "")
    kv_uri = os.environ.get("KEYVAULT_URI", "")
    bearer_secret = os.environ.get("AISOC_RUNNER_BEARER_SECRET_NAME", "AISOC-RUNNER-BEARER")

    if not project_endpoint or not model_deployment:
        return func.HttpResponse("Missing AZURE_AI_FOUNDRY_PROJECT_ENDPOINT or AZURE_AI_MODEL_DEPLOYMENT", status_code=500)
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

        triage_out = _model_call(
            project_endpoint,
            model_deployment,
            system=(
                "You are a SOC triage analyst. Output ONLY strict JSON with keys: "
                "summary, verdict, confidence, entities, next_actions. "
                "entities must include username and clientIp when present, else null. "
                "Keep summary under 6 bullets. next_actions max 5 items."
            ),
            user=f"Triage this Sentinel incident:\n{incident_json}",
        )

        if mode == "triage_only":
            out = {
                "ok": True,
                "mode": mode,
                "incident_ref": {"incidentNumber": incident_number, "incidentId": incident_id},
                "triage": json.loads(triage_out) if triage_out.strip().startswith("{") else {"raw": _clip(triage_out, max_chars)},
            }
            return func.HttpResponse(json.dumps(out), mimetype="application/json")

        # Investigator: generate a few targeted KQL queries, run them via Runner as agent=investigator,
        # then write findings grounded in the results.
        inv_plan = _model_call(
            project_endpoint,
            model_deployment,
            system=(
                "You are an incident investigator. Output ONLY strict JSON with keys: "
                "hypotheses, evidence_needed, queries. "
                "queries is an array of {name,kql,timespan}. Keep to max 3 queries. "
                "Each kql must be short (<= 400 chars). Prefer querying the tables relevant to this incident."
            ),
            user=f"Create a minimal investigation query plan for this incident.\nINCIDENT:\n{incident_json}\n\nTRIAGE_JSON:\n{triage_out}",
        )

        inv_plan_j: dict[str, Any] | None = None
        try:
            inv_plan_j = json.loads(inv_plan) if inv_plan.strip().startswith("{") else None
        except Exception:
            inv_plan_j = None

        query_results: list[dict[str, Any]] = []
        if inv_plan_j and isinstance(inv_plan_j.get("queries"), list):
            for q in inv_plan_j.get("queries", [])[:3]:
                try:
                    name = str(q.get("name") or "query")
                    kql = q.get("kql")
                    timespan = q.get("timespan") or "PT1H"
                    if isinstance(kql, str) and kql.strip():
                        res = _runner_post(
                            runner_url,
                            runner_bearer,
                            {"tool_name": "kql_query", "arguments": {"query": kql.strip(), "timespan": str(timespan)}},
                            agent="investigator",
                        )
                        query_results.append({"name": name, "timespan": str(timespan), "kql": kql.strip(), "result": res.get("result")})
                except Exception as e:
                    query_results.append({"name": str(q.get("name") or "query"), "error": str(e)})

        inv_out = _model_call(
            project_endpoint,
            model_deployment,
            system=(
                "You are an incident investigator. Output ONLY strict JSON with keys: "
                "hypotheses, findings, timeline, verdict, confidence, next_actions. "
                "Ground conclusions in the provided query results; if results are empty, say so."
            ),
            user=(
                f"Investigate based on incident + triage + query results.\n"
                f"INCIDENT:\n{incident_json}\n\nTRIAGE_JSON:\n{triage_out}\n\n"
                f"QUERY_RESULTS_JSON:\n{json.dumps(query_results)[:12000]}"
            ),
        )

        rep_out = _model_call(
            project_endpoint,
            model_deployment,
            system=(
                "You are an incident reporter. Output ONLY strict JSON with keys: "
                "executive_summary, timeline, impact, actions_taken, recommendations, closure, case_note_markdown. "
                "case_note_markdown must be a concise comment suitable for pasting into Sentinel (<= 1200 chars). "
                "Keep executive_summary <= 6 bullets. recommendations max 5."
            ),
            user=f"Write report and propose closure.\nINCIDENT:\n{incident_json}\n\nTRIAGE_JSON:\n{triage_out}\n\nINVESTIGATION_JSON:\n{inv_out}",
        )

        # Optional writeback: add reporter case note as Sentinel incident comment.
        writeback = bool(body.get("writeback"))
        wrote_comment = False
        if writeback:
            # Use best-effort extraction of case note text.
            case_note = None
            s = (rep_out or "").strip()
            if s.startswith("{"):
                try:
                    rep_j = json.loads(s)
                    case_note = rep_j.get("case_note_markdown") or rep_j.get("case_note")
                except Exception:
                    case_note = None
            if not isinstance(case_note, str) or not case_note.strip():
                case_note = _clip(rep_out, 1200)

            _runner_post(
                runner_url,
                runner_bearer,
                {
                    "tool_name": "add_incident_comment",
                    "arguments": {
                        "incidentNumber": incident_number,
                        "id": incident_id,
                        "message": case_note,
                    },
                },
                agent="reporter",
            )
            wrote_comment = True

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
        }
        return func.HttpResponse(json.dumps(out), mimetype="application/json")

    except Exception as e:
        return func.HttpResponse(json.dumps({"ok": False, "error": str(e)}), status_code=500, mimetype="application/json")
