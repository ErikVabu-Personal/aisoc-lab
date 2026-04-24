import os
import requests


def _get_token() -> str:
    """Get an AAD token for Log Analytics.

    Prefer managed identity via the local IMDS endpoint.
    """
    # Azure Functions provides MSI_ENDPOINT/MSI_SECRET in many hosting modes.
    msi_endpoint = os.getenv("MSI_ENDPOINT")
    msi_secret = os.getenv("MSI_SECRET")

    if msi_endpoint and msi_secret:
        r = requests.get(
            msi_endpoint,
            params={
                "resource": "https://api.loganalytics.io",
                "api-version": "2017-09-01",
            },
            headers={"Secret": msi_secret},
            timeout=30,
        )
        r.raise_for_status()
        return r.json()["access_token"]

    # Fallback to IMDS (works when managed identity is enabled)
    r = requests.get(
        "http://169.254.169.254/metadata/identity/oauth2/token",
        params={
            "api-version": "2018-02-01",
            "resource": "https://api.loganalytics.io",
        },
        headers={"Metadata": "true"},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["access_token"]


def query_law(kql: str, timespan: str = "PT1H") -> dict:
    """Query Log Analytics using AAD token auth.

    Requires:
      - LAW_WORKSPACE_ID (workspace GUID)
    """
    workspace_id = os.getenv("LAW_WORKSPACE_ID")
    if not workspace_id:
        raise RuntimeError("LAW_WORKSPACE_ID env var not set")

    token = _get_token()

    url = f"https://api.loganalytics.io/v1/workspaces/{workspace_id}/query"
    payload = {"query": kql, "timespan": timespan}

    r = requests.post(url, json=payload, headers={"Authorization": f"Bearer {token}"}, timeout=60)
    if r.status_code >= 400:
        # Surface the Log Analytics error body. `raise_for_status()` only
        # includes a generic message ("400 Client Error: ... for url ..."),
        # which is useless when diagnosing why a KQL query was rejected —
        # e.g. reserved names in a `by` clause, unknown functions, malformed
        # timespans. Including the body in the exception means the Gateway's
        # outer catch-all will pass it through to the caller.
        body = r.text[:4000]
        if os.getenv("AISOC_DEBUG_IDENTITY", "0") == "1":
            try:
                print(
                    f"[log_analytics:query_law] status={r.status_code} body={body!r}",
                    flush=True,
                )
            except Exception:
                pass
        raise RuntimeError(f"Log Analytics returned {r.status_code}: {body}")
    return r.json()
