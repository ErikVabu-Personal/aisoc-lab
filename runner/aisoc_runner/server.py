from __future__ import annotations

import os
import time
from typing import Any, Literal

import requests
from fastapi import FastAPI, Header, HTTPException


def _emit_pixelagents_event(event: dict[str, Any]) -> None:
    """Best-effort event emission to PixelAgents Web.

    Configure with:
      - PIXELAGENTS_URL (e.g. https://<pixelagents-web>/events)
      - PIXELAGENTS_TOKEN

    Failures are intentionally swallowed to avoid breaking tool execution.
    """
    url = os.getenv("PIXELAGENTS_URL", "").strip()
    token = os.getenv("PIXELAGENTS_TOKEN", "").strip()
    if not url or not token:
        return

    try:
        requests.post(
            url,
            headers={"x-pixelagents-token": token, "Content-Type": "application/json"},
            json=event,
            timeout=2,
        )
    except Exception:
        return


def _extract_incident_guid(value: Any) -> str | None:
    """Extract Sentinel incident GUID from either a GUID string or an ARM resource ID.

    Accepts workspace-scoped incident IDs too (case-insensitive '/incidents/').
    """
    if not isinstance(value, str):
        return None

    s = value.strip()
    if not s:
        return None

    lower = s.lower()
    needle = "/incidents/"
    if needle in lower:
        # Find the segment after /incidents/ in a case-insensitive way.
        idx = lower.index(needle) + len(needle)
        remainder = s[idx:]
        guid = remainder.split("/", 1)[0].split("?", 1)[0].strip()
        return guid or None

    # If it's already a GUID, just return it.
    return s

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
    # Optional build metadata (set at build/deploy time)
    return {
        "ok": "true",
        "git_sha": os.getenv("GIT_SHA", ""),
        "image": os.getenv("CONTAINER_IMAGE", ""),
    }


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
    x_aisoc_agent: str | None = Header(default=None, alias="x-aisoc-agent"),
) -> dict[str, Any]:
    _require_bearer(authorization, x_aisoc_runner_key)

    # Foundry OpenAPI tools can sometimes wrap the call using the operationId as the outer
    # tool_name (e.g. tool_name="toolsExecute") and place the intended payload under
    # arguments={tool_name:<inner>, arguments:{...}}. Normalize to the inner shape.
    if payload.get("tool_name") == "toolsExecute" and isinstance(payload.get("arguments"), dict):
        inner = payload.get("arguments")
        if isinstance(inner, dict) and ("tool_name" in inner or "arguments" in inner):
            payload = inner

    tool_name = payload.get("tool_name")
    # Normalize (avoid whitespace / accidental non-str values)
    if tool_name is not None and not isinstance(tool_name, str):
        tool_name = str(tool_name)
    tool_name = (tool_name or "").strip()

    args = payload.get("arguments") or {}
    # Log minimal debug info (shows up in ACA logs)
    try:
        print(
            f"[tools_execute] tool_name={tool_name!r} payload_keys={sorted(list(payload.keys()))} args_type={type(args).__name__}",
            flush=True,
        )
    except Exception:
        pass

    agent = x_aisoc_agent or payload.get("agent") or os.getenv("DEFAULT_AGENT_NAME", "unknown")
    started = time.time()
    _emit_pixelagents_event(
        {
            "type": "tool.call.start",
            "agent": agent,
            "state": "typing",
            "tool_name": tool_name,
            "args_keys": sorted(list(args.keys())) if isinstance(args, dict) else [],
            "ts": started,
        }
    )

    try:
        if not tool_name:
            raise HTTPException(
                status_code=400,
                detail=f"Missing tool_name. Payload keys={sorted(list(payload.keys()))}",
            )

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
            result = {"result": r.json()}
            return result

        if tool_name == "list_incidents":
            r = requests.get(
                _gw_url("sentinel/incidents"),
                params=_gw_params(),
                headers=_gw_headers("read"),
                timeout=60,
            )
            if r.status_code >= 400:
                raise HTTPException(status_code=r.status_code, detail=r.text)
            result = {"result": r.json()}
            return result

        if tool_name == "get_incident":
            raw_id = args.get("id") or args.get("incident_id")
            incident_number = args.get("incidentNumber") or args.get("incident_number")

            if incident_number is not None and raw_id is None:
                # Resolve incidentNumber -> incident name (GUID) via list_incidents
                try:
                    n = int(incident_number)
                except Exception:
                    raise HTTPException(status_code=400, detail="arguments.incidentNumber must be an integer")

                lr = requests.get(
                    _gw_url("sentinel/incidents"),
                    params=_gw_params(),
                    headers=_gw_headers("read"),
                    timeout=60,
                )
                if lr.status_code >= 400:
                    raise HTTPException(status_code=lr.status_code, detail=lr.text)
                data = lr.json()
                candidates = data.get("value") if isinstance(data, dict) else None
                if not isinstance(candidates, list):
                    raise HTTPException(status_code=502, detail="Unexpected list_incidents response shape")

                match = None
                for item in candidates:
                    try:
                        props = item.get("properties", {}) if isinstance(item, dict) else {}
                        if int(props.get("incidentNumber")) == n:
                            match = item
                            break
                    except Exception:
                        continue

                if not match:
                    raise HTTPException(status_code=404, detail=f"No incident found with incidentNumber={n}")

                raw_id = match.get("name") or match.get("id")

            incident_id = _extract_incident_guid(raw_id)
            if not incident_id:
                raise HTTPException(status_code=400, detail="Missing arguments.id (or incident_id) or arguments.incidentNumber")

            r = requests.get(
                _gw_url(f"sentinel/incidents/{incident_id}"),
                params=_gw_params(),
                headers=_gw_headers("read"),
                timeout=60,
            )
            if r.status_code >= 400:
                raise HTTPException(status_code=r.status_code, detail=r.text)
            result = {"result": r.json()}
            return result

        raise HTTPException(
            status_code=400,
            detail=f"Unknown tool_name: {tool_name!r}; payload_keys={sorted(list(payload.keys()))}",
        )

        if tool_name == "update_incident":
            raw_id = args.get("id") or args.get("incident_id")
            incident_number = args.get("incidentNumber") or args.get("incident_number")
            properties = args.get("properties")

            if incident_number is not None and raw_id is None:
                # Resolve incidentNumber -> incident name (GUID) via list_incidents
                try:
                    n = int(incident_number)
                except Exception:
                    raise HTTPException(status_code=400, detail="arguments.incidentNumber must be an integer")

                lr = requests.get(
                    _gw_url("sentinel/incidents"),
                    params=_gw_params(),
                    headers=_gw_headers("read"),
                    timeout=60,
                )
                if lr.status_code >= 400:
                    raise HTTPException(status_code=lr.status_code, detail=lr.text)
                data = lr.json()
                candidates = data.get("value") if isinstance(data, dict) else None
                if not isinstance(candidates, list):
                    raise HTTPException(status_code=502, detail="Unexpected list_incidents response shape")

                match = None
                for item in candidates:
                    try:
                        props = item.get("properties", {}) if isinstance(item, dict) else {}
                        if int(props.get("incidentNumber")) == n:
                            match = item
                            break
                    except Exception:
                        continue

                if not match:
                    raise HTTPException(status_code=404, detail=f"No incident found with incidentNumber={n}")

                raw_id = match.get("name") or match.get("id")

            incident_id = _extract_incident_guid(raw_id)
            if not incident_id:
                raise HTTPException(status_code=400, detail="Missing arguments.id (or incident_id) or arguments.incidentNumber")
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
            result = {"result": r.json()}
            return result

        raise HTTPException(status_code=400, detail=f"Unknown tool_name: {tool_name}")

    finally:
        ended = time.time()
        _emit_pixelagents_event(
            {
                "type": "tool.call.end",
                "agent": agent,
                "state": "idle",
                "tool_name": tool_name,
                "duration_ms": int((ended - started) * 1000),
                "ts": ended,
            }
        )


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8080"))
    uvicorn.run(app, host="0.0.0.0", port=port)
