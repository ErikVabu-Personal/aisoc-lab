import os
import requests
from azure.identity import DefaultAzureCredential


def query_law(kql: str, timespan: str = "PT1H") -> dict:
    """Query Log Analytics using AAD token auth.

    Requires:
      - LAW_WORKSPACE_ID (workspace GUID)
    """
    workspace_id = os.getenv("LAW_WORKSPACE_ID")
    if not workspace_id:
        raise RuntimeError("LAW_WORKSPACE_ID env var not set")

    cred = DefaultAzureCredential()
    token = cred.get_token("https://api.loganalytics.io/.default").token

    url = f"https://api.loganalytics.io/v1/workspaces/{workspace_id}/query"
    payload = {"query": kql, "timespan": timespan}

    r = requests.post(url, json=payload, headers={"Authorization": f"Bearer {token}"}, timeout=60)
    r.raise_for_status()
    return r.json()
