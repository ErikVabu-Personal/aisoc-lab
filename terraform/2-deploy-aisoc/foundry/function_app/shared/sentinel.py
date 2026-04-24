import os
import uuid
from typing import Any

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
    """Update specific properties on a Sentinel incident.

    The Sentinel REST API for incidents documents "Create or Update" as a
    PUT operation that takes the full incident body plus an `etag` for
    concurrency control. PATCH on the incident root with partial
    properties is technically supported by the schema but often returns
    "502 Server Error: Forbidden" from the ARM frontdoor — observed in
    this repo for owner / description / labels updates against the
    2024-03-01 api-version.

    To avoid that, do a GET → merge → PUT round trip. We strip server-
    set read-only fields before the PUT so ARM doesn't reject the body.
    """

    token = _mgmt_token()
    url = (
        f"https://management.azure.com/subscriptions/{subscription_id}/resourceGroups/{resource_group}"
        f"/providers/Microsoft.OperationalInsights/workspaces/{workspace_name}"
        f"/providers/Microsoft.SecurityInsights/incidents/{incident_id}?api-version={api_version}"
    )

    # 1) GET current incident (we need both the etag and the full
    #    properties block so PUT-with-merged-properties is idempotent).
    g = requests.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=60)
    if g.status_code >= 400 and os.getenv("AISOC_DEBUG_IDENTITY", "0") == "1":
        try:
            print(
                f"[sentinel:update_incident] get_for_put status={g.status_code} body={g.text[:2000]!r}",
                flush=True,
            )
        except Exception:
            pass
    g.raise_for_status()
    current = g.json() if isinstance(g.json(), dict) else {}
    etag = current.get("etag")
    current_props = current.get("properties") or {}

    # 2) Merge — caller's patch wins on conflict, including explicit
    #    `null` values (so the orchestrator can use {owner: null} to
    #    unassign).
    READ_ONLY = {
        "createdTimeUtc",
        "lastModifiedTimeUtc",
        "lastActivityTimeUtc",
        "firstActivityTimeUtc",
        "incidentNumber",
        "additionalData",
        "relatedAnalyticRuleIds",
        "incidentUrl",
        "providerName",
        "providerIncidentId",
    }
    merged_props = {
        k: v for k, v in current_props.items() if k not in READ_ONLY
    }
    if isinstance(properties_patch, dict):
        for k, v in properties_patch.items():
            merged_props[k] = v

    # 3) PUT — etag in the body (Sentinel's documented form, not as a
    #    header) so concurrent edits would 412 instead of clobbering.
    payload: dict[str, Any] = {"properties": merged_props}
    if etag:
        payload["etag"] = etag

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
                f"[sentinel:update_incident] arm_error status={r.status_code} body={r.text[:2000]!r}",
                flush=True,
            )
        except Exception:
            pass
    r.raise_for_status()
    return r.json()


def create_analytic_rule(
    subscription_id: str,
    resource_group: str,
    workspace_name: str,
    rule_id: str,
    properties: dict,
    api_version: str = "2024-03-01",
) -> dict:
    """Create or replace a Sentinel scheduled analytic rule.

    Sentinel's analytic rules live under the ``alertRules`` sub-resource of a
    Log Analytics workspace (not the ``analyticRules`` endpoint — ARM naming
    quirk). The caller supplies the rule_id (UUID) and the properties block
    matching the Scheduled alert-rule schema. We wrap it in a PUT so the
    operation is idempotent — a repeated call with the same rule_id replaces
    the rule rather than 409-ing.
    """

    token = _mgmt_token()
    url = (
        f"https://management.azure.com/subscriptions/{subscription_id}/resourceGroups/{resource_group}"
        f"/providers/Microsoft.OperationalInsights/workspaces/{workspace_name}"
        f"/providers/Microsoft.SecurityInsights/alertRules/{rule_id}?api-version={api_version}"
    )
    payload = {"kind": "Scheduled", "properties": properties}
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
                f"[sentinel:create_analytic_rule] arm_error status={r.status_code} body={r.text[:2000]!r}",
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
