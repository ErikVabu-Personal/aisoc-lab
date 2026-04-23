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
    # Agent Service uses ai.azure.com audience.
    return DefaultAzureCredential().get_token("https://ai.azure.com/.default").token


def _api_version() -> str:
    return os.environ.get("AISOC_AIPROJECTS_API_VERSION", "v1")


def _agents_list(project_endpoint: str) -> list[dict[str, Any]]:
    url = project_endpoint.rstrip("/") + f"/agents?api-version={_api_version()}"
    r = requests.get(url, headers={"Authorization": f"Bearer {_ai_projects_token()}"}, timeout=30)
    if r.status_code >= 400:
        raise RuntimeError(f"List agents failed ({r.status_code}): {r.text[:2000]}")
    data = r.json()
    if isinstance(data, dict) and isinstance(data.get("data"), list):
        return data["data"]
    raise RuntimeError(f"Unexpected agents list shape: {json.dumps(data)[:1000]}")


def _agent_latest_id(project_endpoint: str, agent_name: str) -> str:
    agents = _agents_list(project_endpoint)
    for a in agents:
        if str(a.get("name") or a.get("id") or "").lower() == agent_name.lower():
            latest = ((a.get("versions") or {}).get("latest") or {})
            agent_id = latest.get("id")
            if isinstance(agent_id, str) and agent_id:
                return agent_id
    available = [str(x.get("name") or x.get("id") or "") for x in agents]
    raise RuntimeError(f"Agent '{agent_name}' not found. Available: {available}")


def _response_text(data: Any) -> str:
    # Similar extraction to OpenAI Responses.
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
    agent_id = _agent_latest_id(project_endpoint, agent_name)
    url = project_endpoint.rstrip("/") + f"/responses?api-version={_api_version()}"

    payload = {
        "agent_id": agent_id,
        "input": user_text,
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
