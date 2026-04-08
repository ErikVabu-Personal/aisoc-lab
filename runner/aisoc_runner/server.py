from __future__ import annotations

import os
from typing import Any, Literal

import requests
from fastapi import FastAPI, Header, HTTPException

app = FastAPI(title="aisoc-runner")


def _require_bearer(auth: str | None, api_key: str | None) -> None:
    expected = os.getenv("RUNNER_BEARER_TOKEN", "")
    if not expected:
        raise RuntimeError("Server misconfigured: RUNNER_BEARER_TOKEN missing")

    # Support either:
    # - Authorization: Bearer <token>
    # - x-aisoc-runner-key: <token>  (for Foundry OpenAPI tool connections)
    token: str | None = None

    if api_key:
        token = api_key
    elif auth and auth.lower().startswith("bearer "):
        token = auth.split(" ", 1)[1]

    if not token:
        raise HTTPException(status_code=401, detail="Missing token")

    if token != expected:
        raise HTTPException(status_code=403, detail="Forbidden")


def _gw_url(path: str) -> str:
    base = os.getenv("SOCGATEWAY_BASE_URL", "").rstrip("/")
    if not base:
        raise RuntimeError("SOCGATEWAY_BASE_URL missing")
    return f"{base}/{path.lstrip('/')}"


def _gw_params() -> dict[str, str]:
    code = os.getenv("SOCGATEWAY_FUNCTION_CODE", "")
    if not code:
        raise RuntimeError("SOCGATEWAY_FUNCTION_CODE missing")
    return {"code": code}


def _gw_headers(scope: Literal["read", "write"]) -> dict[str, str]:
    if scope == "read":
        key = os.getenv("SOCGATEWAY_READ_KEY", "")
    else:
        enabled = os.getenv("ENABLE_WRITES", "0") == "1"
        if not enabled:
            raise HTTPException(status_code=403, detail="Writes disabled")
        key = os.getenv("SOCGATEWAY_WRITE_KEY", "")

    if not key:
        raise RuntimeError(f"SOCGATEWAY_{scope.upper()}_KEY missing")

    return {"x-aisoc-key": key, "Content-Type": "application/json"}


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"ok": "true"}


@app.get("/debug/config")
def debug_config(
    authorization: str | None = Header(default=None),
    x_aisoc_runner_key: str | None = Header(default=None, alias="x-aisoc-runner-key"),
) -> dict[str, Any]:
    _require_bearer(authorization, x_aisoc_runner_key)

    def redacted_len(name: str) -> int:
        v = os.getenv(name, "")
        return len(v)

    return {
        "socgateway_base_url": os.getenv("SOCGATEWAY_BASE_URL", ""),
        "socgateway_function_code_set": bool(os.getenv("SOCGATEWAY_FUNCTION_CODE", "")),
        "socgateway_read_key_len": redacted_len("SOCGATEWAY_READ_KEY"),
        "socgateway_write_key_len": redacted_len("SOCGATEWAY_WRITE_KEY"),
        "enable_writes": os.getenv("ENABLE_WRITES", "0"),
    }


@app.post("/tools/execute")
def tools_execute(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
    x_aisoc_runner_key: str | None = Header(default=None, alias="x-aisoc-runner-key"),
) -> dict[str, Any]:
    _require_bearer(authorization, x_aisoc_runner_key)

    tool_name = payload.get("tool_name")
    args = payload.get("arguments") or {}

    if tool_name == "kql_query":
        query = args.get("query")
        timespan = args.get("timespan", "PT1H")
        if not query:
            raise HTTPException(status_code=400, detail="Missing arguments.query")
        r = requests.post(
            _gw_url("kql/query"),
            params=_gw_params(),
            headers=_gw_headers("read"),
            json={"query": query, "timespan": timespan},
            timeout=60,
        )
        if r.status_code >= 400:
            raise HTTPException(status_code=r.status_code, detail=r.text)
        return {"result": r.json()}

    if tool_name == "list_incidents":
        r = requests.get(
            _gw_url("sentinel/incidents"),
            params=_gw_params(),
            headers=_gw_headers("read"),
            timeout=60,
        )
        if r.status_code >= 400:
            raise HTTPException(status_code=r.status_code, detail=r.text)
        return {"result": r.json()}

    if tool_name == "get_incident":
        incident_id = args.get("id")
        if not incident_id:
            raise HTTPException(status_code=400, detail="Missing arguments.id")
        r = requests.get(
            _gw_url(f"sentinel/incidents/{incident_id}"),
            params=_gw_params(),
            headers=_gw_headers("read"),
            timeout=60,
        )
        if r.status_code >= 400:
            raise HTTPException(status_code=r.status_code, detail=r.text)
        return {"result": r.json()}

    if tool_name == "update_incident":
        incident_id = args.get("id")
        properties = args.get("properties")
        if not incident_id:
            raise HTTPException(status_code=400, detail="Missing arguments.id")
        if not isinstance(properties, dict):
            raise HTTPException(status_code=400, detail="Missing arguments.properties (object)")
        r = requests.patch(
            _gw_url(f"sentinel/incidents/{incident_id}"),
            params=_gw_params(),
            headers=_gw_headers("write"),
            json={"properties": properties},
            timeout=60,
        )
        if r.status_code >= 400:
            raise HTTPException(status_code=r.status_code, detail=r.text)
        return {"result": r.json()}

    raise HTTPException(status_code=400, detail=f"Unknown tool_name: {tool_name}")


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8080"))
    uvicorn.run(app, host="0.0.0.0", port=port)
