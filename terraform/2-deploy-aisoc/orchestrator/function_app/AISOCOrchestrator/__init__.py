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


def _invoke_agent(project_endpoint: str, agent_name: str, user_text: str) -> str:
    # Invoke agent via OpenAI v1 Responses endpoint under the project.
    # NOTE: When using /openai/v1 paths, the service rejects api-version query params.
    url = project_endpoint.rstrip("/") + "/openai/v1/responses"

    payload = {
        "input": user_text,
        "agent_reference": {"name": agent_name, "type": "agent_reference"},
    }

    r = requests.post(
        url,
        headers={
            "Authorization": f"Bearer {_ai_projects_token()}",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=240,
    )
    if r.status_code >= 400:
        raise RuntimeError(f"Agent '{agent_name}' response failed ({r.status_code}): {r.text[:4000]}")

    return _response_text(r.json())


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
        triage_out = _invoke_agent(
            project_endpoint,
            "triage",
            user_text=(
                "You are the TRIAGE agent. Use the AISOC Runner OpenAPI tool to fetch incident and context. "
                "Return a concise triage summary and immediate next steps.\n\n"
                + f"INCIDENT_REF:\n{incident_json}"
            ),
        )

        if mode == "triage_only":
            out = {
                "ok": True,
                "mode": mode,
                "incident_ref": {"incidentNumber": incident_number, "incidentId": incident_id},
                "triage": {"raw": _clip(triage_out, max_chars)},
            }
            return func.HttpResponse(json.dumps(out), mimetype="application/json")

        inv_out = _invoke_agent(
            project_endpoint,
            "investigator",
            user_text=(
                "You are the INVESTIGATOR agent. Use the AISOC Runner OpenAPI tool to fetch incident details and run relevant KQL queries. "
                "Ground findings in evidence and produce a short timeline + verdict.\n\n"
                + f"INCIDENT_REF:\n{incident_json}\n\nTRIAGE_OUTPUT:\n{_clip(triage_out, 4000)}"
            ),
        )

        writeback = bool(body.get("writeback"))
        rep_out = _invoke_agent(
            project_endpoint,
            "reporter",
            user_text=(
                "You are the REPORTER agent. Write an exec-ready summary and a Sentinel-ready case note. "
                + ("writeback=true: Add the case note as a Sentinel incident comment using the AISOC Runner OpenAPI tool. " if writeback else "")
                + "\n\n"
                + f"INCIDENT_REF:\n{incident_json}\n\nTRIAGE_OUTPUT:\n{_clip(triage_out, 4000)}\n\nINVESTIGATOR_OUTPUT:\n{_clip(inv_out, 8000)}"
            ),
        )

        wrote_comment = None

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
