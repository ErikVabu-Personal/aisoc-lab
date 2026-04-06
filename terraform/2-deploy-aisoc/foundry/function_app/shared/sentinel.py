import os
import requests


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
        return r.json()["access_token"]

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
    return r.json()["access_token"]


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
