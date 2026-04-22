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
    """Call Foundry model via azure-ai-projects.

    NOTE: This is intentionally minimal. We'll harden once basic orchestration works.
    """

    # We avoid importing azure.ai.projects at module import time (cold start friendliness)
    from azure.ai.projects import AIProjectClient

    client = AIProjectClient(endpoint=project_endpoint, credential=DefaultAzureCredential())

    # The SDK surface for direct chat completion can vary. We use the generic REST-compatible
    # fallback by calling the underlying client if available.
    if hasattr(client, "inference") and hasattr(client.inference, "chat"):  # type: ignore[attr-defined]
        resp = client.inference.chat.completions.create(  # type: ignore[attr-defined]
            model=model_deployment,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
        )
        # Best-effort parse
        return resp.choices[0].message.content  # type: ignore[index]

    raise RuntimeError("azure-ai-projects SDK inference surface not available in this version")


def main(req: func.HttpRequest) -> func.HttpResponse:
    route = req.route_params.get("route") or ""

    if route not in ("incident", "incident/pipeline"):
        return func.HttpResponse("Unknown route", status_code=404)

    body = _json(req)
    incident_number = body.get("incidentNumber")
    incident_id = body.get("incidentId")

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
            system="You are the triage analyst.",
            user=f"Triage this Sentinel incident:\n{incident_json}",
        )

        inv_out = _model_call(
            project_endpoint,
            model_deployment,
            system="You are the incident investigator.",
            user=f"Investigate based on incident + triage.\nINCIDENT:\n{incident_json}\n\nTRIAGE:\n{triage_out}",
        )

        rep_out = _model_call(
            project_endpoint,
            model_deployment,
            system="You are the incident reporter.",
            user=f"Write report and propose closure.\nINCIDENT:\n{incident_json}\n\nTRIAGE:\n{triage_out}\n\nINVESTIGATION:\n{inv_out}",
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

        out = {
            "ok": True,
            "incident_ref": {"incidentNumber": incident_number, "incidentId": incident_id},
            "triage": triage_out,
            "investigation": inv_out,
            "report": rep_out,
            "did_close": did_close,
        }
        return func.HttpResponse(json.dumps(out), mimetype="application/json")

    except Exception as e:
        return func.HttpResponse(json.dumps({"ok": False, "error": str(e)}), status_code=500, mimetype="application/json")
