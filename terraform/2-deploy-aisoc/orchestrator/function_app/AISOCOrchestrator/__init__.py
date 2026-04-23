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


def _foundry_base(project_endpoint: str) -> str:
    # https://...services.ai.azure.com/api/projects/<project> -> https://...services.ai.azure.com
    return project_endpoint.split("/api/projects/")[0].rstrip("/")


def _bearer() -> str:
    return DefaultAzureCredential().get_token("https://cognitiveservices.azure.com/.default").token


def _foundry_list_agents(project_endpoint: str) -> list[dict[str, Any]]:
    """List Foundry agents for the given project.

    NOTE: API surfaces evolve; we try a small set of known paths.
    """

    base = _foundry_base(project_endpoint)
    token = _bearer()

    candidates = [
        # common "projects"-scoped agents collection
        project_endpoint.rstrip("/") + "/agents?api-version=2025-06-01",
        project_endpoint.rstrip("/") + "/agents?api-version=2024-10-01-preview",
        # some surfaces expose agents under /api/agents with project query
        base + "/api/agents?api-version=2025-06-01",
    ]

    last_err = None
    for url in candidates:
        try:
            r = requests.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=30)
            if r.status_code >= 400:
                last_err = f"{r.status_code}: {r.text[:4000]}"
                continue
            data = r.json()
            if isinstance(data, dict) and isinstance(data.get("value"), list):
                return data["value"]
            if isinstance(data, list):
                return data
            # unknown shape
            last_err = f"Unexpected list agents response: {json.dumps(data)[:1000]}"
        except Exception as e:
            last_err = str(e)

    raise RuntimeError(f"Failed to list Foundry agents. Last error: {last_err}")


def _foundry_run_agent(project_endpoint: str, agent_name: str, user: str) -> str:
    """Run a Foundry agent by name.

    We locate the agent id by listing agents, then invoke a run endpoint.
    The exact run endpoint differs across API versions; we try a few candidates.
    """

    agents = _foundry_list_agents(project_endpoint)
    agent = None
    for a in agents:
        # try common fields
        n = a.get("name") or a.get("properties", {}).get("displayName") or a.get("displayName")
        if str(n).strip().lower() == agent_name.lower():
            agent = a
            break

    if not agent:
        available = [str((x.get("name") or x.get("displayName") or x.get("properties", {}).get("displayName") or "")).strip() for x in agents]
        raise RuntimeError(f"Agent '{agent_name}' not found. Available: {available}")

    agent_id = agent.get("id") or agent.get("name")
    if not agent_id:
        raise RuntimeError(f"Agent '{agent_name}' has no id/name field")

    token = _bearer()

    # Run endpoint candidates (API varies). We keep it minimal and fail with the last error.
    base = _foundry_base(project_endpoint)
    candidates = [
        # project-scoped agent runs
        project_endpoint.rstrip("/") + f"/agents/{agent_id}/runs?api-version=2025-06-01",
        project_endpoint.rstrip("/") + f"/agents/{agent_id}/runs?api-version=2024-10-01-preview",
        # generic api surface
        base + f"/api/agents/{agent_id}:run?api-version=2025-06-01",
    ]

    payload = {"input": user}

    last_err = None
    for url in candidates:
        try:
            r = requests.post(
                url,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                },
                json=payload,
                timeout=120,
            )
            if r.status_code >= 400:
                last_err = f"{r.status_code}: {r.text[:4000]}"
                continue
            data = r.json()

            # Try a few common response shapes for final text.
            for key in ("output", "result", "message", "content"):
                if isinstance(data, dict) and isinstance(data.get(key), str):
                    return data[key]

            # nested "output.text" style
            if isinstance(data, dict) and isinstance(data.get("output"), dict):
                out = data["output"]
                if isinstance(out.get("text"), str):
                    return out["text"]

            # unknown but successful
            return json.dumps(data)
        except Exception as e:
            last_err = str(e)

    raise RuntimeError(f"Failed to run agent '{agent_name}'. Last error: {last_err}")


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

        # Triage agent (Foundry Agent runtime). Agent should call Runner tools itself.
        triage_out = _foundry_run_agent(
            project_endpoint,
            "triage",
            user=f"Triage Sentinel incident. First fetch incident details via AISOC Runner tool if needed.\nINCIDENT_REF:\n{incident_json}",
        )

        if mode == "triage_only":
            out = {
                "ok": True,
                "mode": mode,
                "incident_ref": {"incidentNumber": incident_number, "incidentId": incident_id},
                "triage": {"raw": _clip(triage_out, max_chars)},
            }
            return func.HttpResponse(json.dumps(out), mimetype="application/json")

        # Investigator agent (Foundry Agent runtime).
        inv_out = _foundry_run_agent(
            project_endpoint,
            "investigator",
            user=(
                "Investigate this incident. Use AISOC Runner tool to fetch incident + run relevant KQL queries. "
                "Base your findings on evidence you retrieve.\n\n"
                f"INCIDENT_REF:\n{incident_json}\n\nTRIAGE_OUTPUT:\n{_clip(triage_out, 4000)}"
            ),
        )

        # Reporter agent (Foundry Agent runtime). If writeback=true, the reporter should add a Sentinel comment
        # via the AISOC Runner tool.
        writeback = bool(body.get("writeback"))
        rep_out = _foundry_run_agent(
            project_endpoint,
            "reporter",
            user=(
                "Write an executive-ready incident report and a concise case note suitable for Sentinel comments.\n"
                + ("IMPORTANT: writeback=true. Add the case note as a Sentinel incident comment using AISOC Runner tool.\n" if writeback else "")
                + f"\nINCIDENT_REF:\n{incident_json}\n\nTRIAGE_OUTPUT:\n{_clip(triage_out, 4000)}\n\nINVESTIGATOR_OUTPUT:\n{_clip(inv_out, 8000)}"
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
