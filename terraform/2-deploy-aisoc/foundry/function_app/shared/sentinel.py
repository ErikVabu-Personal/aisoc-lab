import os
import requests
from azure.identity import DefaultAzureCredential


def _mgmt_token() -> str:
    cred = DefaultAzureCredential()
    return cred.get_token("https://management.azure.com/.default").token


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
    r.raise_for_status()
    return r.json()
