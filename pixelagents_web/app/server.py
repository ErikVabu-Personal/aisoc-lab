from __future__ import annotations

import json
import os
import time
from collections import defaultdict, deque
from typing import Any, Deque, Dict

from fastapi import FastAPI, Header, HTTPException, Request

# `requests` and `azure-identity` are imported lazily inside the chat handler so
# the module stays import-safe in environments where the chat feature is unused.


def _slug_agent(name: str) -> str:
    import re

    s = (name or "").strip().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = re.sub(r"^-+", "", s)
    s = re.sub(r"-+$", "", s)
    return s or "unknown"

from fastapi.responses import HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

APP_TITLE = "pixelagents-web"

TOKEN_ENV = "PIXELAGENTS_TOKEN"

# In-memory state (demo-grade). For persistence, back with Redis/Cosmos.
AGENTS: Dict[str, Dict[str, Any]] = defaultdict(dict)
EVENTS: Deque[dict[str, Any]] = deque(maxlen=2000)

# Human-in-the-loop questions raised by agents via the runner's ask_human
# tool. Keyed by a server-generated UUID. Each record is:
#   { id, agent, question, asked_at, status: "pending"|"answered"|"cancelled",
#     answer, answered_at }
# The runner long-polls /api/hitl/wait/{id} until status is no longer
# "pending"; the UI reads /api/hitl/pending and submits via
# /api/hitl/answer/{id}. In-memory storage is fine for the demo — a restart
# of the container will drop any in-flight questions.
HITL_QUESTIONS: Dict[str, Dict[str, Any]] = {}

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


def _default_agent_roster() -> list[str]:
    # Comma-separated list of agents that should always exist in UI even before events.
    # Defaults to the classic trio + detection engineer.
    raw = os.getenv("PIXELAGENTS_AGENT_ROSTER", "triage,investigator,reporter,detection-engineer")
    names = [x.strip() for x in raw.split(",") if x.strip()]
    # De-dupe while preserving order
    out: list[str] = []
    for n in names:
        if n not in out:
            out.append(n)
    return out


@app.get("/api/agents/state")
def api_agents_state() -> dict[str, Any]:
    # Minimal adapter for Pixel Agents UI
    # Ensure a stable roster exists even before events
    now = time.time()
    for name in _default_agent_roster():
        AGENTS.setdefault(
            name,
            {
                "agent": name,
                "state": "idle",
                "last_event": None,
                "updated_at": now,
            },
        )

    # Activity window opens on any event that indicates the agent is
    # *starting* to do something (tool.call.start, chat, etc.). An explicit
    # tool.call.end does NOT refresh the window — semantically it means
    # "I'm done," which shouldn't keep the character animating. The
    # last_start_ts field is maintained by ingest_event below.
    cooldown = float(os.getenv("PIXELAGENTS_ACTIVE_COOLDOWN_SEC", "15"))

    def inferred_status(agent_record: dict[str, Any]) -> str:
        state = (agent_record.get("state") or "idle").lower()
        last_start_ts = float(agent_record.get("last_start_ts") or 0)

        if state in ("error", "failed"):
            return "error"

        if last_start_ts == 0:
            return "idle"  # agent has never been active

        age = now - last_start_ts
        return "reading" if age <= cooldown else "idle"

    # Return stable roster first, then any dynamically discovered agents.
    roster = _default_agent_roster()
    dynamic = sorted([k for k in AGENTS.keys() if k not in roster])

    agents = []
    for name in roster + dynamic:
        a = AGENTS.get(name, {})
        status = inferred_status(a)
        # Only surface the current tool while we're actually treating the
        # agent as active. Otherwise the stale name sticks around after the
        # cooldown/grace window and the adapter keeps dispatching chip
        # events for a finished call.
        tool_name = (
            (a.get("last_event") or {}).get("tool_name")
            if status in ("reading", "typing")
            else None
        )
        last_start_ts = float(a.get("last_start_ts") or 0)
        last_event_type = str((a.get("last_event") or {}).get("type") or "")
        agents.append(
            {
                "id": name,
                "status": status,
                "updated_at": a.get("updated_at"),
                "tool_name": tool_name,
                # Debug fields — help troubleshoot why an agent is
                # active / idle at any moment without needing to tail logs.
                "last_start_ts": last_start_ts,
                "age_since_start_sec": (now - last_start_ts) if last_start_ts else None,
                "last_event_type": last_event_type,
            }
        )

    return {"agents": agents, "ts": now, "cooldown_sec": cooldown, "roster": roster}


def _ai_projects_token() -> str:
    """Acquire a bearer token for the Foundry Responses API."""

    from azure.identity import DefaultAzureCredential

    return DefaultAzureCredential().get_token("https://ai.azure.com/.default").token


def _emit_agent_start(agent_name: str, tool_name: str) -> None:
    """Record a synthetic tool.call.start for ``agent_name`` so the pixel
    character reacts immediately, without waiting on a downstream runner to
    emit the event.

    Mirrors the shape the runner emits so everything downstream treats it
    identically. Updates both the EVENTS deque (for the SSE stream) and the
    per-agent AGENTS record (for /api/agents/state inferred_status).
    """

    now = time.time()
    event = {
        "type": "tool.call.start",
        "agent": agent_name,
        "state": "reading",
        "tool_name": tool_name,
        "ts": now,
    }
    EVENTS.append(event)
    AGENTS[agent_name] = {
        **AGENTS.get(agent_name, {}),
        "agent": agent_name,
        "state": "reading",
        "last_event": event,
        "last_start_ts": now,
        "updated_at": now,
    }


def _emit_agent_end(agent_name: str, tool_name: str) -> None:
    """Record a synthetic tool.call.end — informational only; does NOT
    extend the activity window (that's what "end" means)."""

    now = time.time()
    event = {
        "type": "tool.call.end",
        "agent": agent_name,
        "state": "idle",
        "tool_name": tool_name,
        "ts": now,
    }
    EVENTS.append(event)
    prev = AGENTS.get(agent_name, {})
    AGENTS[agent_name] = {
        **prev,
        "agent": agent_name,
        "state": "idle",
        "last_event": event,
        # Intentionally leave last_start_ts alone.
        "last_start_ts": float(prev.get("last_start_ts") or 0),
        "updated_at": now,
    }


def _response_text(data: Any) -> str:
    """Extract output text from an OpenAI Responses-shaped payload.

    Mirrors the helper used in the orchestrator so behaviour is consistent
    between the two call paths.
    """

    if isinstance(data, dict):
        if isinstance(data.get("output_text"), str):
            return data["output_text"]
        out = data.get("output")
        if isinstance(out, list):
            texts: list[str] = []
            for item in out:
                if not isinstance(item, dict):
                    continue
                content = item.get("content")
                if not isinstance(content, list):
                    continue
                for block in content:
                    if isinstance(block, dict) and isinstance(block.get("text"), str):
                        texts.append(block["text"])
            if texts:
                return "\n".join(texts)
    return json.dumps(data)[:12000]


def _detect_tool_calls(raw: dict, tool_names: set[str] | None = None) -> list[dict]:
    """Return every tool invocation found in a Foundry Responses payload.

    If ``tool_names`` is provided, only invocations whose resolved name is in
    the set are returned. The shape of each item is {name, arguments}.
    """

    hits: list[dict] = []
    output = (raw or {}).get("output") or []
    for item in output:
        if not isinstance(item, dict):
            continue
        if item.get("type") not in ("openapi_call", "tool_call", "function_call"):
            continue
        args = item.get("arguments") or {}
        if isinstance(args, str):
            try:
                args = json.loads(args)
            except Exception:
                args = {}
        name = (
            (args.get("tool_name") if isinstance(args, dict) else None)
            or item.get("name")
            or (item.get("tool") or {}).get("name")
        )
        if name is None:
            continue
        if tool_names is not None and name not in tool_names:
            continue
        hits.append({"name": name, "arguments": args if isinstance(args, dict) else {}})
    return hits


@app.post("/api/agents/{agent_id}/message")
async def send_message_to_agent(
    agent_id: str,
    req: Request,
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> dict[str, Any]:
    """Send an ad-hoc user message to a Foundry agent and return its response.

    Backend-only MVP for interactive PixelAgents: gated by the existing
    ``x-pixelagents-token`` so it can be exercised by curl without a UI yet.
    A proper user-auth story (e.g. ACA Easy Auth with Entra) should land
    before this endpoint is surfaced to a browser.

    Note: this does not enforce read-only scoping. Whatever tools the named
    agent has attached in Foundry, it can call — including write tools if
    the user's message convinces it to. Layer a scoping mechanism on top
    before exposing broadly.
    """

    _require_token(x_pixelagents_token)

    body: dict[str, Any]
    try:
        body = await req.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    message = body.get("message")
    if not isinstance(message, str) or not message.strip():
        raise HTTPException(status_code=400, detail="Missing arguments.message (string)")

    # Normalise agent id to the same slug form used elsewhere so "Triage",
    # "triage", and "triage-agent" don't split into separate cache buckets.
    agent_name = _slug_agent(agent_id)
    if not agent_name or agent_name == "unknown":
        raise HTTPException(status_code=400, detail="Invalid agent id")

    # Flash the pixel character active *now*, before we block on Foundry,
    # so the user sees the agent react immediately to their message.
    _emit_agent_start(agent_name, "adhoc_chat")

    project_endpoint = os.getenv("AZURE_AI_FOUNDRY_PROJECT_ENDPOINT", "")
    if not project_endpoint:
        raise HTTPException(status_code=500, detail="Missing AZURE_AI_FOUNDRY_PROJECT_ENDPOINT")

    import requests as _requests

    url = project_endpoint.rstrip("/") + "/openai/v1/responses"
    payload = {
        "input": message.strip(),
        "agent_reference": {"name": agent_name, "type": "agent_reference"},
    }

    try:
        token = _ai_projects_token()
    except Exception as e:  # credential acquisition failed (MI not assigned, etc.)
        raise HTTPException(status_code=500, detail=f"Foundry auth failed: {e!r}") from e

    r = _requests.post(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        json=payload,
        timeout=240,
    )

    # Pass Foundry's status through as a 502 so the caller can tell the
    # difference between "this service failed" and "the upstream agent failed".
    if r.status_code >= 400:
        detail: Any
        try:
            detail = r.json()
        except Exception:
            detail = r.text[:4000]
        raise HTTPException(status_code=502, detail={"foundry_status": r.status_code, "body": detail})

    raw = r.json() if isinstance(r.json(), dict) else {}
    text = _response_text(raw)
    tool_calls = _detect_tool_calls(raw)

    # Record a synthetic end event — informational; the start at the top
    # of the handler is what opened the activity window.
    _emit_agent_end(agent_name, "adhoc_chat")

    return {
        "ok": True,
        "agent": agent_name,
        "text": text,
        "tool_calls": tool_calls,
    }


def _sse_event(event_name: str, data: dict) -> str:
    """Format a single SSE event block (event: X\\ndata: {...}\\n\\n)."""

    return f"event: {event_name}\ndata: {json.dumps(data)}\n\n"


# ─── Sentinel incidents table (read-only, proxied via managed identity) ───
_INCIDENTS_CACHE: Dict[str, Any] = {"ts": 0.0, "payload": None}
_INCIDENTS_CACHE_TTL_SEC = 10.0


def _arm_token() -> str:
    """Acquire a bearer token for Azure Resource Manager."""

    from azure.identity import DefaultAzureCredential

    return DefaultAzureCredential().get_token("https://management.azure.com/.default").token


@app.get("/api/sentinel/incidents")
def list_sentinel_incidents(
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> dict[str, Any]:
    """Return a summary list of Sentinel incidents for the lab workspace.

    Queries ARM directly with the Container App's managed identity so we
    don't have to thread the runner bearer token through. The MI must have
    `Microsoft Sentinel Reader` (or higher) on the workspace — that's wired
    up in terraform/3-deploy-pixelagents-web/main.tf.

    The response is cached in-process for a short TTL so the UI can poll
    without hammering ARM.
    """

    _require_token(x_pixelagents_token)

    now = time.time()
    cached = _INCIDENTS_CACHE.get("payload")
    if cached is not None and (now - float(_INCIDENTS_CACHE.get("ts") or 0)) < _INCIDENTS_CACHE_TTL_SEC:
        return cached

    sub = os.getenv("AZURE_SUBSCRIPTION_ID", "")
    rg = os.getenv("AZURE_RESOURCE_GROUP", "")
    ws = os.getenv("SENTINEL_WORKSPACE_NAME", "")
    missing = [n for n, v in (("AZURE_SUBSCRIPTION_ID", sub), ("AZURE_RESOURCE_GROUP", rg), ("SENTINEL_WORKSPACE_NAME", ws)) if not v]
    if missing:
        raise HTTPException(
            status_code=500,
            detail=f"Missing env vars for Sentinel incidents query: {missing}",
        )

    try:
        token = _arm_token()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"ARM auth failed: {e!r}") from e

    import requests as _requests

    url = (
        f"https://management.azure.com/subscriptions/{sub}/resourceGroups/{rg}"
        f"/providers/Microsoft.OperationalInsights/workspaces/{ws}"
        f"/providers/Microsoft.SecurityInsights/incidents"
        f"?api-version=2024-03-01&$top=50&$orderby=properties/lastModifiedTimeUtc desc"
    )

    r = _requests.get(
        url,
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    if r.status_code >= 400:
        detail: Any
        try:
            detail = r.json()
        except Exception:
            detail = r.text[:4000]
        raise HTTPException(
            status_code=502,
            detail={"arm_status": r.status_code, "body": detail},
        )

    try:
        data = r.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"ARM returned non-JSON body: {e!r}") from e

    incidents: list[dict[str, Any]] = []
    for item in (data.get("value") or []):
        props = item.get("properties") or {}
        incidents.append(
            {
                "id": item.get("name"),  # incident GUID
                "arm_id": item.get("id"),
                "number": props.get("incidentNumber"),
                "title": props.get("title"),
                "severity": props.get("severity"),
                "status": props.get("status"),
                "created": props.get("createdTimeUtc"),
                "last_modified": props.get("lastModifiedTimeUtc"),
            }
        )

    payload = {
        "incidents": incidents,
        "count": len(incidents),
        "ts": now,
    }
    _INCIDENTS_CACHE["payload"] = payload
    _INCIDENTS_CACHE["ts"] = now
    return payload


@app.post("/api/sentinel/incidents/{incident_number}/orchestrate")
async def orchestrate_incident(
    incident_number: int,
    req: Request,
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> dict[str, Any]:
    """Kick off the AISOC Orchestrator pipeline for a specific incident.

    Proxies to the Orchestrator Function App (see terraform/2-deploy-aisoc/
    orchestrator.tf). The orchestrator itself runs triage → investigator →
    reporter in sequence; this is a blocking call that returns the
    orchestrator's JSON result once the pipeline completes.

    Body (all optional):
      {
        "mode": "full" | "triage_only"  (default: "full")
        "writeback": bool               (default: true — reporter adds Sentinel comment)
      }
    """

    _require_token(x_pixelagents_token)

    orch_base = os.getenv("ORCHESTRATOR_URL", "")
    orch_key = os.getenv("ORCHESTRATOR_FUNCTION_KEY", "")
    if not orch_base or not orch_key:
        raise HTTPException(
            status_code=500,
            detail="Orchestrator not configured (ORCHESTRATOR_URL / ORCHESTRATOR_FUNCTION_KEY missing).",
        )

    try:
        body = await req.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}

    mode = body.get("mode") or "full"
    writeback = body["writeback"] if "writeback" in body else True

    import requests as _requests

    url = f"{orch_base.rstrip('/')}/incident/pipeline?code={orch_key}"
    try:
        r = _requests.post(
            url,
            json={
                "incidentNumber": incident_number,
                "mode": mode,
                "writeback": bool(writeback),
            },
            # Orchestrator pipeline runs three agents in sequence and can take
            # 1-3 minutes for tool-heavy incidents. Generous client timeout.
            timeout=600,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Orchestrator call failed: {e!r}") from e

    if r.status_code >= 400:
        detail: Any
        try:
            detail = r.json()
        except Exception:
            detail = r.text[:4000]
        raise HTTPException(
            status_code=502,
            detail={"orchestrator_status": r.status_code, "body": detail},
        )

    try:
        return r.json()
    except Exception:
        return {"raw": r.text[:4000]}


# ─── Human-in-the-loop (HITL) ────────────────────────────────────────────
#
# The runner exposes an `ask_human` tool that agents can call when they
# need clarification. When invoked, the runner POSTs the question to
# /api/hitl/questions below, gets back a UUID, and long-polls
# /api/hitl/wait/{id} until a human answers (or a short timeout). The UI
# reads /api/hitl/pending and submits via /api/hitl/answer/{id}.


def _hitl_public(q: dict[str, Any]) -> dict[str, Any]:
    """Strip internals before sending a question record to the UI/runner."""

    return {
        "id": q.get("id"),
        "agent": q.get("agent"),
        "agent_display": q.get("agent_display"),
        "question": q.get("question"),
        "asked_at": q.get("asked_at"),
        "status": q.get("status"),
        "answer": q.get("answer"),
        "answered_at": q.get("answered_at"),
    }


@app.post("/api/hitl/questions")
async def hitl_create_question(
    req: Request,
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> dict[str, Any]:
    """Called by the runner when an agent invokes ask_human."""

    _require_token(x_pixelagents_token)

    import uuid as _uuid

    try:
        body = await req.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    agent_raw = body.get("agent") or "unknown"
    question = body.get("question")
    if not isinstance(question, str) or not question.strip():
        raise HTTPException(status_code=400, detail="Missing question")

    qid = str(_uuid.uuid4())
    record = {
        "id": qid,
        "agent": _slug_agent(str(agent_raw)),
        "agent_display": str(agent_raw),
        "question": question.strip(),
        "asked_at": time.time(),
        "status": "pending",
        "answer": None,
        "answered_at": None,
    }
    HITL_QUESTIONS[qid] = record
    return _hitl_public(record)


@app.get("/api/hitl/pending")
def hitl_list_pending(
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> dict[str, Any]:
    """UI reads this to show currently-pending questions."""

    _require_token(x_pixelagents_token)
    pending = [
        _hitl_public(q) for q in HITL_QUESTIONS.values() if q.get("status") == "pending"
    ]
    pending.sort(key=lambda q: q.get("asked_at") or 0)
    return {"questions": pending, "ts": time.time()}


@app.post("/api/hitl/answer/{qid}")
async def hitl_submit_answer(
    qid: str,
    req: Request,
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> dict[str, Any]:
    """UI submits a human answer for a given question id."""

    _require_token(x_pixelagents_token)

    q = HITL_QUESTIONS.get(qid)
    if not q:
        raise HTTPException(status_code=404, detail="Unknown question id")
    if q.get("status") != "pending":
        raise HTTPException(status_code=409, detail=f"Question already {q.get('status')}")

    try:
        body = await req.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    answer = body.get("answer")
    if not isinstance(answer, str):
        raise HTTPException(status_code=400, detail="Missing answer (string)")

    q["answer"] = answer
    q["answered_at"] = time.time()
    q["status"] = "answered"
    return _hitl_public(q)


@app.get("/api/hitl/wait/{qid}")
async def hitl_wait(
    qid: str,
    timeout: int = 30,
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> dict[str, Any]:
    """Long-poll variant for the runner.

    Holds the connection open for up to `timeout` seconds, returning as
    soon as the question transitions out of "pending". The runner can
    call this repeatedly to wait for longer than a single HTTP timeout.
    Safe to call with timeout=0 for a cheap non-blocking poll.
    """

    import asyncio as _asyncio

    _require_token(x_pixelagents_token)

    q = HITL_QUESTIONS.get(qid)
    if not q:
        raise HTTPException(status_code=404, detail="Unknown question id")

    # Clamp so a misconfigured runner can't park us forever.
    timeout = max(0, min(int(timeout), 60))

    deadline = time.time() + timeout
    while True:
        q = HITL_QUESTIONS.get(qid) or {}
        if q.get("status") != "pending":
            return _hitl_public(q)
        if time.time() >= deadline:
            return _hitl_public(q)
        await _asyncio.sleep(1.0)


@app.post("/api/agents/{agent_id}/message/stream")
async def stream_message_to_agent(
    agent_id: str,
    req: Request,
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> StreamingResponse:
    """Streaming variant of the ad-hoc chat endpoint.

    Opens a streaming POST to Foundry's Responses API and relays the events
    to the browser as Server-Sent Events. We translate Foundry's event
    vocabulary into a smaller, stable shape so the UI doesn't have to care
    about upstream API versioning:

      - event: delta,     data: {"text": "<chunk>"}
      - event: tool_call, data: {"name": "<tool_name>", "arguments": {...}}
      - event: done,      data: {"tool_calls": [...]}
      - event: error,     data: {"status": <int>, "body": <string|object>}

    See send_message_to_agent above for the request-body contract and caveats.
    """

    _require_token(x_pixelagents_token)

    try:
        body = await req.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    message = body.get("message")
    if not isinstance(message, str) or not message.strip():
        raise HTTPException(status_code=400, detail="Missing arguments.message (string)")

    agent_name = _slug_agent(agent_id)
    if not agent_name or agent_name == "unknown":
        raise HTTPException(status_code=400, detail="Invalid agent id")

    # Flash the pixel character active *now* so the user sees immediate
    # feedback instead of waiting for the first streamed delta.
    _emit_agent_start(agent_name, "adhoc_chat")

    project_endpoint = os.getenv("AZURE_AI_FOUNDRY_PROJECT_ENDPOINT", "")
    if not project_endpoint:
        raise HTTPException(status_code=500, detail="Missing AZURE_AI_FOUNDRY_PROJECT_ENDPOINT")

    try:
        token = _ai_projects_token()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Foundry auth failed: {e!r}") from e

    import requests as _requests

    url = project_endpoint.rstrip("/") + "/openai/v1/responses"
    payload = {
        "input": message.strip(),
        "agent_reference": {"name": agent_name, "type": "agent_reference"},
        "stream": True,
    }

    def generate():
        """Blocking generator — FastAPI runs it in a threadpool."""

        tool_calls_observed: list[dict] = []

        # Open the upstream streaming request inside the generator so any
        # connection failures surface as an SSE error rather than a 5xx.
        try:
            upstream = _requests.post(
                url,
                headers={
                    "Authorization": f"Bearer {token}",
                    "Content-Type": "application/json",
                    "Accept": "text/event-stream",
                },
                json=payload,
                stream=True,
                timeout=240,
            )
        except Exception as e:
            yield _sse_event("error", {"status": 0, "body": f"connection failed: {e!r}"})
            yield _sse_event("done", {"tool_calls": []})
            return

        try:
            if upstream.status_code >= 400:
                detail: Any
                try:
                    detail = upstream.json()
                except Exception:
                    detail = upstream.text[:4000]
                yield _sse_event("error", {"status": upstream.status_code, "body": detail})
                return

            current_event: str | None = None
            data_lines: list[str] = []

            # Track whether we've actually streamed any text out to the
            # client. Some agents / Foundry flows don't emit per-token
            # deltas and instead deliver text as a completed message item;
            # in that case we extract text from output_item.done or, as
            # a last resort, from response.completed.
            total_text_emitted = 0
            # Diagnostic: count each distinct upstream event type we saw
            # so the frontend can surface "the agent emitted X item.done
            # events but no text" when things look weird.
            event_type_counts: Dict[str, int] = {}

            def _text_from_message_item(item: dict) -> str:
                parts: list[str] = []
                content = item.get("content") or []
                if isinstance(content, list):
                    for block in content:
                        if isinstance(block, dict) and isinstance(block.get("text"), str):
                            parts.append(block["text"])
                return "".join(parts)

            # Foundry streams SSE: lines are either "event: X", "data: {...}",
            # comments starting with ':', or blank (event terminator).
            for line in upstream.iter_lines(decode_unicode=True):
                if line is None:
                    continue
                if line == "":
                    # Flush accumulated event
                    if current_event and data_lines:
                        event_type_counts[current_event] = (
                            event_type_counts.get(current_event, 0) + 1
                        )
                        data_str = "".join(data_lines)
                        try:
                            ev_data = json.loads(data_str)
                        except Exception:
                            ev_data = None

                        if (
                            current_event == "response.output_text.delta"
                            and isinstance(ev_data, dict)
                        ):
                            delta = ev_data.get("delta")
                            if isinstance(delta, str) and delta:
                                total_text_emitted += len(delta)
                                yield _sse_event("delta", {"text": delta})

                        elif (
                            current_event == "response.output_item.done"
                            and isinstance(ev_data, dict)
                        ):
                            item = ev_data.get("item") or {}
                            if not isinstance(item, dict):
                                item = {}
                            item_type = item.get("type")
                            if item_type in ("openapi_call", "tool_call", "function_call"):
                                args = item.get("arguments") or {}
                                if isinstance(args, str):
                                    try:
                                        args = json.loads(args)
                                    except Exception:
                                        args = {}
                                name = (
                                    (args.get("tool_name") if isinstance(args, dict) else None)
                                    or item.get("name")
                                    or (item.get("tool") or {}).get("name")
                                )
                                if name:
                                    entry = {
                                        "name": name,
                                        "arguments": args if isinstance(args, dict) else {},
                                    }
                                    tool_calls_observed.append(entry)
                                    yield _sse_event("tool_call", entry)
                            elif item_type == "message":
                                # Some agents emit messages as a single
                                # completed item rather than per-token
                                # deltas. If we haven't streamed any text
                                # yet, surface the whole thing now so the
                                # UI at least shows the response.
                                if total_text_emitted == 0:
                                    txt = _text_from_message_item(item)
                                    if txt:
                                        total_text_emitted += len(txt)
                                        yield _sse_event("delta", {"text": txt})

                        elif (
                            current_event == "response.completed"
                            and isinstance(ev_data, dict)
                            and total_text_emitted == 0
                        ):
                            # Last-resort fallback: walk the final response's
                            # output array and extract text from any message
                            # items we may have missed.
                            response = ev_data.get("response") or {}
                            output = response.get("output") or []
                            if isinstance(output, list):
                                collected = "".join(
                                    _text_from_message_item(it)
                                    for it in output
                                    if isinstance(it, dict) and it.get("type") == "message"
                                )
                                if collected:
                                    total_text_emitted += len(collected)
                                    yield _sse_event("delta", {"text": collected})

                    current_event = None
                    data_lines = []
                elif line.startswith(":"):
                    # SSE comment / heartbeat — ignore.
                    continue
                elif line.startswith("event:"):
                    current_event = line[len("event:"):].strip()
                elif line.startswith("data:"):
                    # Per SSE spec, trim exactly one leading space if present.
                    chunk = line[len("data:"):]
                    if chunk.startswith(" "):
                        chunk = chunk[1:]
                    data_lines.append(chunk)
                # other field types (id:, retry:) ignored
        finally:
            try:
                upstream.close()
            except Exception:
                pass

            # Synthetic end for the chat — informational only, doesn't
            # extend the activity window (the start at the top of the
            # handler already opened it).
            _emit_agent_end(agent_name, "adhoc_chat")

            yield _sse_event(
                "done",
                {
                    "tool_calls": tool_calls_observed,
                    "text_chars": total_text_emitted,
                    "event_counts": event_type_counts,
                },
            )

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={
            # Disable proxy buffering so chunks reach the browser promptly.
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


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

    agent_raw = body.get("agent") or "unknown"
    agent = _slug_agent(str(agent_raw))

    event_type = str(body.get("type") or "").lower()
    is_end_event = event_type == "tool.call.end"

    prev = AGENTS[agent]
    prev_last_start_ts = float(prev.get("last_start_ts") or 0)
    # tool.call.end updates the last_event record (so tool_name / UI is
    # current) but does not reset the activity window — that's what
    # "end" means. Anything else is treated as an activity-inducing
    # event and refreshes last_start_ts.
    new_last_start_ts = prev_last_start_ts if is_end_event else body["ts"]

    AGENTS[agent] = {
        "agent": agent,
        "agent_display": str(agent_raw),
        "state": body.get("state") or prev.get("state") or "idle",
        "last_event": body,
        "last_start_ts": new_last_start_ts,
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
def index() -> HTMLResponse:
    """Serve the Pixel Agents UI, with the AISOC chat drawer injected.

    We don't touch the vendored ui_dist/index.html on disk — instead we read it
    at request time, inject the chat drawer config + script tag before
    ``</body>``, and return the modified HTML. Keeps ui_dist/ a pure vendor
    artifact that can be updated from upstream without merge conflicts.
    """

    dist_index = os.path.join(os.path.dirname(__file__), "ui_dist", "index.html")
    if not os.path.exists(dist_index):
        return HTMLResponse("PixelAgents UI not built yet. Run the build and redeploy.")

    with open(dist_index, "r", encoding="utf-8") as f:
        html = f.read()

    token = os.getenv(TOKEN_ENV, "")
    # The token is injected into the served HTML so the browser-side chat drawer
    # can authenticate to POST /api/agents/{id}/message. Anyone with the page
    # URL can see it — same threat surface as the already-public /api/agents/state.
    # Gate the URL itself (e.g. ACA Easy Auth) before trusting this in production.
    token_js = json.dumps(token)
    injection = (
        f'<script>window.__PIXELAGENTS_CHAT = {{ token: {token_js} }};</script>'
        f'<script src="/static/chat_drawer.js" defer></script>'
        f'<script src="/static/incidents_panel.js" defer></script>'
        f'<script src="/static/hitl_panel.js" defer></script>'
        f'<script src="/static/agent_activity.js" defer></script>'
    )

    if "</body>" in html:
        html = html.replace("</body>", injection + "</body>", 1)
    else:
        html = html + injection

    return HTMLResponse(html)


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
