import os
import uuid

import requests


def _jwt_claims(token: str) -> dict:
    """Decode JWT claims without verification (debugging only)."""

    try:
        import base64
        import json

        parts = token.split(".")
        if len(parts) < 2:
            return {}
        payload = parts[1]
        payload += "=" * (-len(payload) % 4)
        payload = payload.replace("-", "+").replace("_", "/")
        return json.loads(base64.b64decode(payload).decode("utf-8"))
    except Exception:
        return {}


def _mgmt_token() -> str:
    # Azure Functions provides MSI_ENDPOINT/MSI_SECRET in many hosting modes.
    msi_endpoint = os.getenv("MSI_ENDPOINT")
    msi_secret = os.getenv("MSI_SECRET")

    if msi_endpoint and msi_secret:
        r = requests.get(
            msi_endpoint,
            params={
                "resource": "https://management.azure.com/",
                "api-version": "2017-09-01",
            },
            headers={"Secret": msi_secret},
            timeout=30,
        )
        r.raise_for_status()
        token = r.json()["access_token"]
        if os.getenv("AISOC_DEBUG_IDENTITY", "0") == "1":
            claims = _jwt_claims(token)
            try:
                print(
                    f"[sentinel:_mgmt_token] source=msi_endpoint oid={claims.get('oid')} tid={claims.get('tid')} appid={claims.get('appid')}",
                    flush=True,
                )
            except Exception:
                pass
        return token

    r = requests.get(
        "http://169.254.169.254/metadata/identity/oauth2/token",
        params={
            "api-version": "2018-02-01",
            "resource": "https://management.azure.com/",
        },
        headers={"Metadata": "true"},
        timeout=30,
    )
    r.raise_for_status()
    token = r.json()["access_token"]
    if os.getenv("AISOC_DEBUG_IDENTITY", "0") == "1":
        claims = _jwt_claims(token)
        try:
            print(
                f"[sentinel:_mgmt_token] source=imds oid={claims.get('oid')} tid={claims.get('tid')} appid={claims.get('appid')}",
                flush=True,
            )
        except Exception:
            pass
    return token


def list_incidents(subscription_id: str, resource_group: str, workspace_name: str, api_version: str = "2024-03-01") -> dict:
    token = _mgmt_token()
    url = (
        f"https://management.azure.com/subscriptions/{subscription_id}/resourceGroups/{resource_group}"
        f"/providers/Microsoft.OperationalInsights/workspaces/{workspace_name}"
        f"/providers/Microsoft.SecurityInsights/incidents?api-version={api_version}"
    )
    r = requests.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=60)
    r.raise_for_status()
    return r.json()


def get_incident(subscription_id: str, resource_group: str, workspace_name: str, incident_id: str, api_version: str = "2024-03-01") -> dict:
    token = _mgmt_token()
    url = (
        f"https://management.azure.com/subscriptions/{subscription_id}/resourceGroups/{resource_group}"
        f"/providers/Microsoft.OperationalInsights/workspaces/{workspace_name}"
        f"/providers/Microsoft.SecurityInsights/incidents/{incident_id}?api-version={api_version}"
    )
    r = requests.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=60)
    r.raise_for_status()
    return r.json()


def update_incident(subscription_id: str, resource_group: str, workspace_name: str, incident_id: str, properties_patch: dict, api_version: str = "2024-03-01") -> dict:
    token = _mgmt_token()
    url = (
        f"https://management.azure.com/subscriptions/{subscription_id}/resourceGroups/{resource_group}"
        f"/providers/Microsoft.OperationalInsights/workspaces/{workspace_name}"
        f"/providers/Microsoft.SecurityInsights/incidents/{incident_id}?api-version={api_version}"
    )
    payload = {"properties": properties_patch}
    r = requests.patch(
        url,
        json=payload,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        timeout=60,
    )
    if r.status_code >= 400 and os.getenv("AISOC_DEBUG_IDENTITY", "0") == "1":
        try:
            print(
                f"[sentinel:update_incident] arm_error status={r.status_code} body={r.text[:2000]!r}",
                flush=True,
            )
        except Exception:
            pass
    r.raise_for_status()
    return r.json()


def add_incident_comment(
    subscription_id: str,
    resource_group: str,
    workspace_name: str,
    incident_id: str,
    message: str,
    api_version: str = "2024-03-01",
) -> dict:
    """Create a comment on a Sentinel incident.

    Uses the ``comments`` sub-resource. Sentinel's REST API requires the caller
    to generate the comment's own GUID and PUT to that exact path (POST to the
    collection is not supported).
    """

    token = _mgmt_token()
    comment_id = str(uuid.uuid4())
    url = (
        f"https://management.azure.com/subscriptions/{subscription_id}/resourceGroups/{resource_group}"
        f"/providers/Microsoft.OperationalInsights/workspaces/{workspace_name}"
        f"/providers/Microsoft.SecurityInsights/incidents/{incident_id}"
        f"/comments/{comment_id}?api-version={api_version}"
    )

    payload = {
        "properties": {
            "message": message,
        }
    }

    r = requests.put(
        url,
        json=payload,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        timeout=60,
    )
    if r.status_code >= 400 and os.getenv("AISOC_DEBUG_IDENTITY", "0") == "1":
        try:
            print(
                f"[sentinel:add_incident_comment] arm_error status={r.status_code} body={r.text[:2000]!r}",
                flush=True,
            )
        except Exception:
            pass
    r.raise_for_status()
    return r.json()
