import json
import os
import azure.functions as func

from shared.log_analytics import query_law
from shared.sentinel import list_incidents, get_incident, update_incident, add_incident_comment
from shared.auth import get_openrouter_api_key_from_env_or_kv
from shared.permissions import require_key


def _json(req: func.HttpRequest) -> dict:
    try:
        return req.get_json()
    except Exception:
        return {}


def main(req: func.HttpRequest) -> func.HttpResponse:
    route = req.route_params.get("route")

    try:
        if route == "kql/query":
            require_key(req, "AISOC_READ_KEY")
            body = _json(req)
            kql = body.get("query")
            timespan = body.get("timespan", "PT1H")
            if not kql:
                return func.HttpResponse("Missing 'query'", status_code=400)
            return func.HttpResponse(json.dumps(query_law(kql, timespan)), mimetype="application/json")

        if route == "sentinel/incidents":
            require_key(req, "AISOC_READ_KEY")
            # Dynamic from env set by Terraform
            sub = os.environ["AZURE_SUBSCRIPTION_ID"]
            rg = os.environ["AZURE_RESOURCE_GROUP"]
            ws = os.environ["LAW_WORKSPACE_NAME"]
            return func.HttpResponse(json.dumps(list_incidents(sub, rg, ws)), mimetype="application/json")

        # REST-style get by id: GET /sentinel/incidents/{id}
        if route and route.startswith("sentinel/incidents/") and req.method.upper() == "GET":
            require_key(req, "AISOC_READ_KEY")
            sub = os.environ["AZURE_SUBSCRIPTION_ID"]
            rg = os.environ["AZURE_RESOURCE_GROUP"]
            ws = os.environ["LAW_WORKSPACE_NAME"]
            incident_id = route.split("/", 2)[2]
            if not incident_id:
                return func.HttpResponse("Missing id", status_code=400)
            return func.HttpResponse(json.dumps(get_incident(sub, rg, ws, incident_id)), mimetype="application/json")

        # Backwards-compatible query-param get: /sentinel/incident?id={id}
        if route == "sentinel/incident":
            require_key(req, "AISOC_READ_KEY")
            sub = os.environ["AZURE_SUBSCRIPTION_ID"]
            rg = os.environ["AZURE_RESOURCE_GROUP"]
            ws = os.environ["LAW_WORKSPACE_NAME"]
            incident_id = req.params.get("id")
            if not incident_id:
                return func.HttpResponse("Missing id", status_code=400)
            return func.HttpResponse(json.dumps(get_incident(sub, rg, ws, incident_id)), mimetype="application/json")

        # REST-style update: PATCH /sentinel/incidents/{id}
        if route and route.startswith("sentinel/incidents/") and req.method.upper() == "PATCH":
            require_key(req, "AISOC_WRITE_KEY")
            sub = os.environ["AZURE_SUBSCRIPTION_ID"]
            rg = os.environ["AZURE_RESOURCE_GROUP"]
            ws = os.environ["LAW_WORKSPACE_NAME"]
            incident_id = route.split("/", 2)[2]
            if not incident_id:
                return func.HttpResponse("Missing id", status_code=400)
            body = _json(req)
            props = body.get("properties")
            if not isinstance(props, dict):
                return func.HttpResponse("Missing properties patch", status_code=400)
            return func.HttpResponse(json.dumps(update_incident(sub, rg, ws, incident_id, props)), mimetype="application/json")

        # Backwards-compatible update: PATCH /sentinel/incident/update?id={id}
        if route == "sentinel/incident/update":
            require_key(req, "AISOC_WRITE_KEY")
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
            return func.HttpResponse(json.dumps(update_incident(sub, rg, ws, incident_id, props)), mimetype="application/json")

        # Create comment: POST /sentinel/incidents/{id}/comments
        if route and route.startswith("sentinel/incidents/") and route.endswith("/comments") and req.method.upper() == "POST":
            require_key(req, "AISOC_WRITE_KEY")
            sub = os.environ["AZURE_SUBSCRIPTION_ID"]
            rg = os.environ["AZURE_RESOURCE_GROUP"]
            ws = os.environ["LAW_WORKSPACE_NAME"]

            # route: sentinel/incidents/{id}/comments
            parts = route.split("/")
            if len(parts) < 4:
                return func.HttpResponse("Missing id", status_code=400)
            incident_id = parts[2]
            if not incident_id:
                return func.HttpResponse("Missing id", status_code=400)

            body = _json(req)
            message = body.get("message")
            if not isinstance(message, str) or not message.strip():
                return func.HttpResponse("Missing message", status_code=400)

            return func.HttpResponse(
                json.dumps(add_incident_comment(sub, rg, ws, incident_id, message.strip())),
                mimetype="application/json",
            )

        if route == "llm/openrouter":
            require_key(req, "AISOC_READ_KEY")
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

    except PermissionError as e:
        # Don't leak which key was expected
        return func.HttpResponse(json.dumps({"error": "Forbidden"}), status_code=403, mimetype="application/json")
    except Exception as e:
        return func.HttpResponse(json.dumps({"error": str(e)}), status_code=500, mimetype="application/json")
