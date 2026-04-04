import json
import os
import azure.functions as func

from shared.log_analytics import query_law
from shared.sentinel import list_incidents, get_incident, update_incident
from shared.auth import get_openrouter_api_key_from_env_or_kv


def _json(req: func.HttpRequest) -> dict:
    try:
        return req.get_json()
    except Exception:
        return {}


def main(req: func.HttpRequest) -> func.HttpResponse:
    route = req.route_params.get("route")

    try:
        if route == "kql/query":
            body = _json(req)
            kql = body.get("query")
            timespan = body.get("timespan", "PT1H")
            if not kql:
                return func.HttpResponse("Missing 'query'", status_code=400)
            return func.HttpResponse(json.dumps(query_law(kql, timespan)), mimetype="application/json")

        if route == "sentinel/incidents":
            # Dynamic from env set by Terraform
            sub = os.environ["AZURE_SUBSCRIPTION_ID"]
            rg = os.environ["AZURE_RESOURCE_GROUP"]
            ws = os.environ["LAW_WORKSPACE_NAME"]
            return func.HttpResponse(json.dumps(list_incidents(sub, rg, ws)), mimetype="application/json")

        if route == "sentinel/incident":
            sub = os.environ["AZURE_SUBSCRIPTION_ID"]
            rg = os.environ["AZURE_RESOURCE_GROUP"]
            ws = os.environ["LAW_WORKSPACE_NAME"]
            incident_id = req.params.get("id")
            if not incident_id:
                return func.HttpResponse("Missing id", status_code=400)
            return func.HttpResponse(json.dumps(get_incident(sub, rg, ws, incident_id)), mimetype="application/json")

        if route == "sentinel/incident/update":
            sub = os.environ["AZURE_SUBSCRIPTION_ID"]
            rg = os.environ["AZURE_RESOURCE_GROUP"]
            ws = os.environ["LAW_WORKSPACE_NAME"]
            incident_id = req.params.get("id")
            if not incident_id:
                return func.HttpResponse("Missing id", status_code=400)
            body = _json(req)
            props = body.get("properties")
            if not isinstance(props, dict):
                return func.HttpResponse("Missing properties patch", status_code=400)
            return func.HttpResponse(
                json.dumps(update_incident(sub, rg, ws, incident_id, props)),
                mimetype="application/json",
            )

        if route == "llm/openrouter":
            # Optional utility endpoint
            body = _json(req)
            prompt = body.get("prompt")
            model = body.get("model", "openai/gpt-4o-mini")
            if not prompt:
                return func.HttpResponse("Missing prompt", status_code=400)

            key = get_openrouter_api_key_from_env_or_kv()
            import requests

            r = requests.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
                json={
                    "model": model,
                    "messages": [{"role": "user", "content": prompt}],
                },
                timeout=60,
            )
            r.raise_for_status()
            return func.HttpResponse(r.text, mimetype="application/json")

        return func.HttpResponse("Unknown route", status_code=404)

    except Exception as e:
        return func.HttpResponse(json.dumps({"error": str(e)}), status_code=500, mimetype="application/json")
