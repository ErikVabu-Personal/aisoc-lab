from __future__ import annotations

import json
import os
import time
from collections import defaultdict, deque
from typing import Any, Deque, Dict

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import HTMLResponse, StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles

APP_TITLE = "pixelagents-web"

TOKEN_ENV = "PIXELAGENTS_TOKEN"

# In-memory state (demo-grade). For persistence, back with Redis/Cosmos.
AGENTS: Dict[str, Dict[str, Any]] = defaultdict(dict)
EVENTS: Deque[dict[str, Any]] = deque(maxlen=2000)

app = FastAPI(title=APP_TITLE)

# Serve vendored Pixel Agents assets
STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")
if os.path.isdir(STATIC_DIR):
    app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

# Serve built Pixel Agents webview UI assets (Vite build output) copied into the container
UI_DIST_DIR = os.path.join(os.path.dirname(__file__), "ui_dist")
if os.path.isdir(UI_DIST_DIR):
    app.mount("/ui", StaticFiles(directory=UI_DIST_DIR, html=True), name="ui")


def _require_token(x_pixelagents_token: str | None) -> None:
    expected = os.getenv(TOKEN_ENV, "")
    if not expected:
        raise RuntimeError(f"Server misconfigured: {TOKEN_ENV} missing")
    if not x_pixelagents_token:
        raise HTTPException(status_code=401, detail="Missing token")
    if x_pixelagents_token != expected:
        raise HTTPException(status_code=403, detail="Forbidden")


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"ok": "true"}


@app.get("/api/agents/state")
def api_agents_state() -> dict[str, Any]:
    # Minimal adapter for Pixel Agents UI
    # Ensure fixed roster exists even before events
    now = time.time()
    for name in ("triage", "investigator", "reporter"):
        AGENTS.setdefault(
            name,
            {
                "agent": name,
                "state": "idle",
                "last_event": None,
                "updated_at": now,
            },
        )

    cooldown = float(os.getenv("PIXELAGENTS_ACTIVE_COOLDOWN_SEC", "20"))

    def inferred_status(agent_record: dict[str, Any]) -> str:
        # Option B: infer "agent is working" for a short time after a tool call.
        # This provides richer animation despite runner-only telemetry.
        state = (agent_record.get("state") or "idle").lower()
        last_event = agent_record.get("last_event") or {}
        last_ts = float(last_event.get("ts") or agent_record.get("updated_at") or 0)
        age = now - last_ts

        if state in ("error", "failed"):
            return "error"

        if state == "typing":
            return "typing"

        # Keep "reading" (active) briefly after any tool call end/start.
        if age <= cooldown:
            return "reading"

        return "idle"

    agents = []
    for name in ("triage", "investigator", "reporter"):
        a = AGENTS.get(name, {})
        agents.append(
            {
                "id": name,
                "status": inferred_status(a),
                "updated_at": a.get("updated_at"),
                "tool_name": (a.get("last_event") or {}).get("tool_name"),
            }
        )

    return {"agents": agents, "ts": now, "cooldown_sec": cooldown}


@app.post("/events")
async def ingest_event(
    req: Request,
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> dict[str, str]:
    _require_token(x_pixelagents_token)

    body = await req.json()
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    body.setdefault("ts", time.time())
    EVENTS.append(body)

    agent = body.get("agent") or "unknown"
    # Keep a very small per-agent summary for the UI
    AGENTS[agent] = {
        "agent": agent,
        "state": body.get("state") or AGENTS[agent].get("state") or "idle",
        "last_event": body,
        "updated_at": body["ts"],
    }

    return {"ok": "true"}


@app.get("/events/stream")
async def sse_stream() -> StreamingResponse:
    async def gen():
        # SSE: send a snapshot, then follow new events.
        last_idx = 0
        snapshot = {
            "type": "snapshot",
            "agents": list(AGENTS.values()),
            "events": list(EVENTS)[-200:],
            "ts": time.time(),
        }
        payload = json.dumps(snapshot)
        payload = payload.replace("\n", "\\n")
        yield f"data: {payload}\n\n"

        while True:
            # Naive tailing loop (demo-grade). ACA will kill long-idle connections;
            # client will reconnect.
            await _sleep(0.5)
            if last_idx < len(EVENTS):
                # Send all new events since last_idx
                new_events = list(EVENTS)[last_idx:]
                last_idx = len(EVENTS)
                for e in new_events:
                    # Ensure each SSE payload is a single line to keep browser JSON.parse happy
                    payload = json.dumps({"type": "event", "event": e})
                    payload = payload.replace("\n", "\\n")
                    yield f"data: {payload}\n\n"

    return StreamingResponse(gen(), media_type="text/event-stream")


async def _sleep(seconds: float) -> None:
    # tiny wrapper to avoid importing asyncio at top-level in some environments
    import asyncio

    await asyncio.sleep(seconds)


@app.get("/", response_class=HTMLResponse)
def index() -> FileResponse:
    # Serve Pixel Agents webview UI build if present
    dist_index = os.path.join(os.path.dirname(__file__), "ui_dist", "index.html")
    if os.path.exists(dist_index):
        return FileResponse(dist_index)

    # Fallback
    return HTMLResponse("PixelAgents UI not built yet. Run the build and redeploy.")


# Serve UI assets at root-relative paths (e.g. /assets/...) because the built index.html uses ./assets/...
UI_DIST_DIR = os.path.join(os.path.dirname(__file__), "ui_dist")
if os.path.isdir(UI_DIST_DIR):
    app.mount("/assets", StaticFiles(directory=os.path.join(UI_DIST_DIR, "assets")), name="ui_assets")
    fonts_dir = os.path.join(UI_DIST_DIR, "fonts")
    if os.path.isdir(fonts_dir):
        app.mount("/fonts", StaticFiles(directory=fonts_dir), name="ui_fonts")


def main() -> None:
    import uvicorn

    port = int(os.getenv("PORT", "8080"))
    uvicorn.run("app.server:app", host="0.0.0.0", port=port)
