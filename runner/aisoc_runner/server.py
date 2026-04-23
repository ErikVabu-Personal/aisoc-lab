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
        idx = lower.index(needle) + len(needle)
        remainder = s[idx:]
        guid = remainder.split("/", 1)[0].split("?", 1)[0].strip()
        return guid or None

    return s


app = FastAPI(title="aisoc-runner")


def _require_bearer(auth: str | None, api_key: str | None) -> None:
    expected = os.getenv("RUNNER_BEARER_TOKEN", "")
    if not expected:
        raise RuntimeError("Server misconfigured: RUNNER_BEARER_TOKEN missing")

    # Support either:
    # - Authorization: Bearer <token>
    # - x-aisoc-runner-key: <token>
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
        return len(os.getenv(name, ""))

    return {
        "socgateway_base_url": os.getenv("SOCGATEWAY_BASE_URL", ""),
        "socgateway_function_code_set": bool(os.getenv("SOCGATEWAY_FUNCTION_CODE", "")),
        "socgateway_read_key_len": redacted_len("SOCGATEWAY_READ_KEY"),
        "socgateway_write_key_len": redacted_len("SOCGATEWAY_WRITE_KEY"),
        "enable_writes": os.getenv("ENABLE_WRITES", "0"),
        "pixelagents_url_set": bool(os.getenv("PIXELAGENTS_URL", "")),
        "pixelagents_token_set": bool(os.getenv("PIXELAGENTS_TOKEN", "")),
    }


@app.post("/tools/execute")
def tools_execute(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
    x_aisoc_runner_key: str | None = Header(default=None, alias="x-aisoc-runner-key"),
    x_aisoc_agent: str | None = Header(default=None, alias="x-aisoc-agent"),
) -> dict[str, Any]:
    _require_bearer(authorization, x_aisoc_runner_key)

    # Foundry OpenAPI tools can wrap the call using the operationId as the outer tool_name.
    # Normalize to the inner payload shape.
    if payload.get("tool_name") == "toolsExecute" and isinstance(payload.get("arguments"), dict):
        inner = payload.get("arguments")
        if isinstance(inner, dict) and ("tool_name" in inner or "arguments" in inner):
            payload = inner

    tool_name: Any = payload.get("tool_name")
    if tool_name is not None and not isinstance(tool_name, str):
        tool_name = str(tool_name)
    tool_name = (tool_name or "").strip()

    args = payload.get("arguments") or {}

    try:
        print(
            f"[tools_execute] tool_name={tool_name!r} payload_keys={sorted(list(payload.keys()))} args_type={type(args).__name__}",
            flush=True,
        )
    except Exception:
        pass

    if not tool_name:
        raise HTTPException(status_code=400, detail=f"Missing tool_name. Payload keys={sorted(list(payload.keys()))}")

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
        if tool_name == "kql_query":
            query = args.get("query")
            # Some clients/LLMs include workspaceId/workspace_id; ignore it (Runner is already configured to a workspace via SOCGateway).
            _ = args.get("workspaceId") or args.get("workspace_id")
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
                # Log upstream details to container logs for debugging.
                try:
                    print(f"[kql_query] upstream_error status={r.status_code} body={r.text[:2000]!r}", flush=True)
                except Exception:
                    pass
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
            # Accept a few common aliases produced by LLMs / different client conventions.
            raw_id = args.get("id") or args.get("incident_id") or args.get("incidentId")
            incident_number = args.get("incidentNumber") or args.get("incident_number")

            if incident_number is not None and raw_id is None:
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
                raise HTTPException(
                    status_code=400,
                    detail="Missing arguments.id (or incident_id) or arguments.incidentNumber",
                )

            r = requests.get(
                _gw_url(f"sentinel/incidents/{incident_id}"),
                params=_gw_params(),
                headers=_gw_headers("read"),
                timeout=60,
            )
            if r.status_code >= 400:
                raise HTTPException(status_code=r.status_code, detail=r.text)
            return {"result": r.json()}

        def _resolve_incident_id(raw_id: Any, incident_number: Any) -> str:
            if incident_number is not None and raw_id is None:
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
                raise HTTPException(
                    status_code=400,
                    detail="Missing arguments.id (or incident_id) or arguments.incidentNumber",
                )
            return incident_id

        if tool_name == "update_incident":
            raw_id = args.get("id") or args.get("incident_id") or args.get("incidentId")
            incident_number = args.get("incidentNumber") or args.get("incident_number")
            properties = args.get("properties")

            incident_id = _resolve_incident_id(raw_id, incident_number)

            # Some clients/LLMs send a "flat" patch shape (status/classification/etc) instead of nesting under properties.
            # Accept that and wrap it into properties.
            if not isinstance(properties, dict):
                flat = {
                    k: v
                    for k, v in args.items()
                    if k
                    not in (
                        "id",
                        "incident_id",
                        "incidentId",
                        "incidentNumber",
                        "incident_number",
                        "properties",
                    )
                }
                if flat:
                    properties = flat

            # Also accept top-level comment field (common LLM behavior).
            if isinstance(properties, dict) and "comment" not in properties and isinstance(args.get("comment"), str):
                properties["comment"] = args.get("comment")

            # Also accept a singular comment field and treat it as an incident comment write.
            if isinstance(properties, dict) and "comment" in properties and "comments" not in properties:
                properties["comments"] = properties.pop("comment")

            if not isinstance(properties, dict):
                raise HTTPException(status_code=400, detail="Missing arguments.properties (object) or flat incident fields")

            # If caller included comments/work notes, Sentinel expects them via incidentComments sub-resource.
            # Translate common shapes into add-comment calls.
            comments = None
            if isinstance(properties, dict):
                comments = properties.pop("comments", None)
            if comments is not None:
                texts: list[str] = []
                if isinstance(comments, str) and comments.strip():
                    texts.append(comments.strip())
                elif isinstance(comments, list):
                    for c in comments:
                        if isinstance(c, dict):
                            t = c.get("comment") or c.get("message")
                            if isinstance(t, str) and t.strip():
                                texts.append(t.strip())
                        elif isinstance(c, str) and c.strip():
                            texts.append(c.strip())
                # Best-effort: add each comment (ignore failures? no, bubble up)
                for t in texts:
                    cr = requests.post(
                        _gw_url(f"sentinel/incidents/{incident_id}/comments"),
                        params=_gw_params(),
                        headers=_gw_headers("write"),
                        json={"message": t},
                        timeout=60,
                    )
                    if cr.status_code >= 400:
                        raise HTTPException(status_code=cr.status_code, detail=cr.text)

                # If this was comment-only, we're done. Don't PATCH empty properties.
                if not properties:
                    return {"result": {"ok": True, "wrote_comment": True}}

                # Demo hardening: when comment writeback is requested, ignore status patching.
                # Some Sentinel incident status updates can be finicky/unsupported depending on API/version.
                properties.pop("status", None)

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

        if tool_name == "add_incident_comment":
            raw_id = args.get("id") or args.get("incident_id") or args.get("incidentId")
            incident_number = args.get("incidentNumber") or args.get("incident_number")
            message = args.get("message") or args.get("comment")

            incident_id = _resolve_incident_id(raw_id, incident_number)

            if not isinstance(message, str) or not message.strip():
                raise HTTPException(status_code=400, detail="Missing arguments.message (string)")

            r = requests.post(
                _gw_url(f"sentinel/incidents/{incident_id}/comments"),
                params=_gw_params(),
                headers=_gw_headers("write"),
                json={"message": message.strip()},
                timeout=60,
            )
            if r.status_code >= 400:
                raise HTTPException(status_code=r.status_code, detail=r.text)
            return {"result": r.json()}

        raise HTTPException(
            status_code=400,
            detail=f"Unknown tool_name: {tool_name!r}; payload_keys={sorted(list(payload.keys()))}",
        )

    except HTTPException:
        raise
    except Exception as e:
        # Ensure we always get a deterministic traceback in Container Apps logs.
        try:
            import traceback

            print(
                f"[tools_execute] unhandled_exception tool_name={tool_name!r} agent={agent!r} err={e!r}",
                flush=True,
            )
            traceback.print_exc()
        except Exception:
            pass
        raise HTTPException(status_code=500, detail="Unhandled runner exception (see logs)")

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
