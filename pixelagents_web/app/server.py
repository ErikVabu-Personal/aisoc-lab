from __future__ import annotations

import json
import os
import time
from collections import defaultdict, deque
from typing import Any, Deque, Dict

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import HTMLResponse, StreamingResponse
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
def index() -> str:
    return """<!doctype html>
<html>
  <head>
    <meta charset=\"utf-8\" />
    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\" />
    <title>PixelAgents Web (AISOC)</title>
    <style>
      body { font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto; margin: 24px; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
      .card { border: 1px solid #ddd; border-radius: 10px; padding: 12px; }
      .state { font-weight: 700; }
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas; font-size: 12px; white-space: pre-wrap; }
      .small { color: #666; font-size: 12px; }
    </style>
  </head>
  <body>
    <h1>PixelAgents Web (AISOC demo)</h1>
    <p class="small">Live view of agent activity. Event source: aisoc-runner → POST /events</p>

    <div style="display:flex; gap:16px; align-items:flex-start; flex-wrap:wrap">
      <canvas id="office" width="900" height="520" style="border:1px solid #ddd; border-radius:10px;"></canvas>
      <div style="flex:1; min-width:320px;">
        <h2>Agents</h2>
        <div id="agents" class="grid"></div>
        <h2>Recent events</h2>
        <div id="events" class="mono" style="max-height:360px; overflow:auto"></div>
      </div>
    </div>

    <script>
      const agentsEl = document.getElementById('agents');
      const eventsEl = document.getElementById('events');
      const canvas = document.getElementById('office');
      const ctx = canvas.getContext('2d');

      const agents = new Map();
      const events = [];

      // Simple "office" positions
      const seats = {
        triage: {x: 140, y: 180},
        investigator: {x: 420, y: 180},
        reporter: {x: 700, y: 180},
        unknown: {x: 420, y: 360}
      };

      const sprite = new Image();
      sprite.src = '/static/characters.png';

      function drawOffice() {
        ctx.clearRect(0,0,canvas.width,canvas.height);
        // background
        ctx.fillStyle = '#f7f7fb';
        ctx.fillRect(0,0,canvas.width,canvas.height);

        // desks
        for (const [name,pos] of Object.entries(seats)) {
          ctx.fillStyle = '#e0e0ea';
          ctx.fillRect(pos.x-70, pos.y-40, 140, 80);
          ctx.fillStyle = '#999';
          ctx.fillText(name, pos.x-20, pos.y-50);
        }

        // agents
        for (const a of agents.values()) {
          const id = a.agent || 'unknown';
          const pos = seats[id] || seats.unknown;
          // choose frame based on state
          // characters.png is a sheet; for now just draw the whole image scaled as a placeholder.
          // We'll refine to true sprite frames next.
          const size = 48;
          ctx.drawImage(sprite, 0, 0, 32, 32, pos.x - size/2, pos.y - size/2, size, size);

          // state bubble
          ctx.fillStyle = a.state === 'typing' ? '#2b6cb0' : (a.state === 'error' ? '#c53030' : '#4a5568');
          ctx.fillRect(pos.x-26, pos.y-60, 52, 16);
          ctx.fillStyle = '#fff';
          ctx.font = '12px ui-sans-serif, system-ui';
          ctx.fillText(a.state || 'idle', pos.x-22, pos.y-48);
        }
      }

      function render() {
        agentsEl.innerHTML = '';
        for (const a of agents.values()) {
          const div = document.createElement('div');
          div.className = 'card';
          div.innerHTML = `
            <div><strong>${a.agent}</strong></div>
            <div>State: <span class="state">${a.state}</span></div>
            <div class="small">Updated: ${new Date(a.updated_at * 1000).toISOString()}</div>
            <div class="small">Last tool: ${(a.last_event && a.last_event.tool_name) || '-'}</div>
          `;
          agentsEl.appendChild(div);
        }
        eventsEl.innerHTML = '';
        for (const e of events.slice(-80)) {
          const row = document.createElement('div');
          row.textContent = JSON.stringify(e);
          eventsEl.appendChild(row);
        }
        drawOffice();
      }

      const es = new EventSource('/events/stream');
      es.onmessage = (msg) => {
        let data;
        try { data = JSON.parse(msg.data); } catch (e) { console.error('Bad SSE JSON payload', msg.data); return; }
        if (data.type === 'snapshot') {
          agents.clear();
          for (const a of data.agents) agents.set(a.agent, a);
          events.splice(0, events.length, ...data.events);
          render();
          return;
        }
        if (data.type === 'event') {
          events.push(data.event);
          const agent = data.event.agent || 'unknown';
          agents.set(agent, {
            agent,
            state: data.event.state || (agents.get(agent)?.state ?? 'idle'),
            last_event: data.event,
            updated_at: data.event.ts || (Date.now()/1000)
          });
          render();
        }
      };

      sprite.onload = () => render();
    </script>
  </body>
</html>"""


def main() -> None:
    import uvicorn

    port = int(os.getenv("PORT", "8080"))
    uvicorn.run("app.server:app", host="0.0.0.0", port=port)
