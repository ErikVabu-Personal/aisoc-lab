from __future__ import annotations

import json
import os
import secrets
import time
from collections import defaultdict, deque
from typing import Any, Deque, Dict

from fastapi import FastAPI, Form, Header, HTTPException, Request, Response

# `requests` and `azure-identity` are imported lazily inside the chat handler so
# the module stays import-safe in environments where the chat feature is unused.


def _slug_agent(name: str) -> str:
    import re

    s = (name or "").strip().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = re.sub(r"^-+", "", s)
    s = re.sub(r"-+$", "", s)
    return s or "unknown"

from fastapi.responses import HTMLResponse, RedirectResponse, StreamingResponse
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

# Pending change proposals from agents (the Knowledge agent today;
# detection-engineer rule proposals are a planned follow-up). Each
# change requires explicit human Approve / Reject before it takes
# effect. Apply-on-approve lives in _apply_change(); approval is
# broadcast (any logged-in human can approve, first-wins).
#
# Shape of a record:
#   {
#     "id":          str,
#     "kind":        "knowledge-preamble",
#     "proposed_by": str (agent slug),
#     "proposed_at": float,
#     "title":       str (one-line summary for the queue row),
#     "rationale":   str (why the change matters),
#     "current":     str (snapshot at proposal time, for the diff view),
#     "proposed":    str (the new content, in full),
#     "status":      "pending" | "approved" | "rejected" | "applied" | "failed",
#     "reviewer":    str | None (email of the human who acted),
#     "reviewed_at": float | None,
#     "review_note": str (analyst rationale on approve/reject),
#     "applied_at":  float | None,
#     "applied_result": dict | None (per-target outcome of the apply step),
#     "apply_error": str | None,
#   }
CHANGES: Dict[str, Dict[str, Any]] = {}
CHANGES_CAP = 200  # trim oldest when we exceed this

# Per-user, per-agent ad-hoc chat history. Survives navigation + refresh
# (in-memory; restart clears it — same lifetime as AGENTS/HITL_QUESTIONS).
# Shape: CONVERSATIONS[user_key][agent_slug] -> list of message records.
# Each message record:
#   {
#     "id":          str (token_urlsafe(8)),
#     "role":        "user" | "assistant",
#     "text":        str,
#     "tool_calls":  list[{"name": str, "arguments": dict}],
#     "status":      "user" | "streaming" | "completed" | "failed",
#     "error":       str | None,
#     "started_at":  float (unix sec),
#     "ended_at":    float | None,
#   }
# Status semantics:
#   - "user"       — a user message; never changes after creation
#   - "streaming"  — assistant placeholder; background task is filling it
#   - "completed"  — assistant response finished
#   - "failed"     — assistant stream errored; .error has the reason
CONVERSATIONS: Dict[str, Dict[str, list[Dict[str, Any]]]] = defaultdict(
    lambda: defaultdict(list)
)
CONVERSATIONS_CAP = 100  # max messages per (user, agent); oldest get trimmed

# Per-incident cost accumulators. Keyed by str(incident_number); a special
# bucket "chat" aggregates ad-hoc chat-drawer calls that aren't tied to
# a specific incident. Each bucket:
#   {
#     "total_eur": float,
#     "total_input_tokens": int,
#     "total_output_tokens": int,
#     "records": [ {agent, phase, input_tokens, output_tokens, eur_cost, ts, ...}, ... ]
#   }
# Pinned-to-1-replica is already enforced in Terraform, so in-memory is
# fine for the demo. Records list is trimmed to keep memory bounded.
COSTS: Dict[str, Dict[str, Any]] = {}
_COST_RECORDS_CAP = 500


def _cost_bucket(key: str) -> Dict[str, Any]:
    """Get-or-init the cost bucket for a key (incident number or 'chat')."""
    bucket = COSTS.get(key)
    if bucket is None:
        bucket = {
            "total_eur": 0.0,
            "total_input_tokens": 0,
            "total_output_tokens": 0,
            "records": [],
        }
        COSTS[key] = bucket
    return bucket


def _price_eur_per_token(kind: str) -> float:
    """EUR-per-token unit price from env vars. Mirrors the orchestrator's
    helper — used by the chat endpoints that capture usage locally."""
    if kind == "input":
        raw = os.getenv("TOKEN_PRICE_EUR_PER_1M_INPUT", "0.35")
    else:
        raw = os.getenv("TOKEN_PRICE_EUR_PER_1M_OUTPUT", "1.40")
    try:
        return float(raw) / 1_000_000.0
    except Exception:
        return 0.0


def _record_usage_locally(
    *,
    incident_key: str,
    agent: str,
    phase: str,
    usage: Any,
) -> None:
    """Compute EUR from a Foundry-usage dict and append to the right bucket.

    Called by the chat endpoints — the orchestrator takes its own path via
    POST /api/cost/record below because it lives in a different process.
    """

    if not isinstance(usage, dict):
        return
    input_tokens = int(usage.get("input_tokens") or usage.get("prompt_tokens") or 0)
    output_tokens = int(usage.get("output_tokens") or usage.get("completion_tokens") or 0)
    if input_tokens == 0 and output_tokens == 0:
        return
    eur_cost = (
        input_tokens * _price_eur_per_token("input")
        + output_tokens * _price_eur_per_token("output")
    )
    bucket = _cost_bucket(incident_key)
    bucket["total_eur"] += eur_cost
    bucket["total_input_tokens"] += input_tokens
    bucket["total_output_tokens"] += output_tokens
    bucket["records"].append(
        {
            "agent": agent,
            "phase": phase,
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "eur_cost": round(eur_cost, 6),
            "ts": time.time(),
        }
    )
    if len(bucket["records"]) > _COST_RECORDS_CAP:
        bucket["records"] = bucket["records"][-_COST_RECORDS_CAP:]

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


# ── Demo-grade login (single hardcoded user, in-memory sessions) ─────
# This is a demo lab, not a hardened production stack. The user store
# is a literal dict; sessions live only in this process. PixelAgents
# Web is pinned to a single replica, so in-memory state survives
# between requests as long as the container doesn't restart. A
# container restart logs everyone out — acceptable for a demo.
def _load_users() -> dict[str, str]:
    """Build the demo's user roster.

    Order of precedence:

    1. AISOC_USERS_JSON env var — JSON object {email: password}. The
       intended path: Terraform stores this as a Container App secret
       and wires it through, so adding/removing users is a one-line
       tfvars change instead of a code change.
    2. Hardcoded fallback roster — used when AISOC_USERS_JSON is unset
       or unparseable. Lets the demo boot on first deploy without any
       config and gives a known-good identity if the env var ever
       breaks.

    Emails are case-folded; passwords are stored verbatim. This is a
    demo-grade store — for anything closer to production, hash the
    passwords (bcrypt / passlib) and gate them on a real identity
    provider.
    """

    raw = os.getenv("AISOC_USERS_JSON", "").strip()
    if raw:
        try:
            data = json.loads(raw)
        except Exception:
            data = None
        if isinstance(data, dict) and data:
            return {str(k).lower().strip(): str(v) for k, v in data.items()}

    return {
        "erik.vanbuggenhout@nviso.eu": "admin123",
        "jeroen.laureys@nviso.eu": "saleswarmachine",
    }


USERS: dict[str, str] = _load_users()
SESSIONS: dict[str, dict[str, Any]] = {}  # sid -> {"user": str, "created": float}
SESSION_COOKIE = "aisoc_session"
SESSION_TTL_SEC = 12 * 3600


def _new_session(user: str) -> str:
    sid = secrets.token_urlsafe(32)
    SESSIONS[sid] = {"user": user, "created": time.time()}
    return sid


def _session_user(request: Request) -> str | None:
    sid = request.cookies.get(SESSION_COOKIE)
    if not sid:
        return None
    s = SESSIONS.get(sid)
    if not s:
        return None
    if time.time() - s["created"] > SESSION_TTL_SEC:
        SESSIONS.pop(sid, None)
        return None
    return s["user"]


# ── Online-presence + human-to-human DM state ───────────────────────
# PRESENCE is bumped on every authenticated request that carries a
# real session cookie (so we know who's actively poking the UI).
# DM_MESSAGES stores per-pair conversation history. Both are in-memory
# and reset on container restart — same lifetime as the rest of the
# demo state.
PRESENCE: Dict[str, float] = {}  # email -> last_seen unix sec
ONLINE_WINDOW_SEC = 60.0          # last_seen within this = "online"

# Thread store keyed by a sorted tuple of the two participants' emails
# so the same thread is shared regardless of who initiated. Each
# message: {id, from, to, text, ts}.
DM_MESSAGES: Dict[tuple[str, str], list[Dict[str, Any]]] = defaultdict(list)
DM_MESSAGES_CAP = 200  # per pair


def _dm_key(a: str, b: str) -> tuple[str, str]:
    return tuple(sorted((a, b)))  # type: ignore[return-value]


def _dm_append(from_user: str, to_user: str, text: str) -> Dict[str, Any]:
    msg = {
        "id": secrets.token_urlsafe(8),
        "from": from_user,
        "to": to_user,
        "text": text,
        "ts": time.time(),
    }
    bucket = DM_MESSAGES[_dm_key(from_user, to_user)]
    bucket.append(msg)
    if len(bucket) > DM_MESSAGES_CAP:
        del bucket[: len(bucket) - DM_MESSAGES_CAP]
    return msg


def _dm_get(a: str, b: str) -> list[Dict[str, Any]]:
    return list(DM_MESSAGES.get(_dm_key(a, b), []))


def _bump_presence(email: str) -> None:
    """Mark `email` as last-seen=now. Cheap; called on every
    authenticated cookie-backed request."""
    if email:
        PRESENCE[email] = time.time()


def _require_auth(request: Request, x_pixelagents_token: str | None) -> None:
    """Browser session cookie OR x-pixelagents-token header — either works.

    Used by endpoints called from both the logged-in UI (cookie) and from
    server-to-server callers like the runner / orchestrator (token).

    Side-effect: if cookie auth resolves to a real user, bump that
    user's PRESENCE timestamp. Token-only callers (runner / orchestrator)
    don't have a user identity and don't appear in the online list.
    """
    user = _session_user(request)
    if user is not None:
        _bump_presence(user)
        return
    expected = os.getenv(TOKEN_ENV, "")
    if expected and x_pixelagents_token == expected:
        return
    raise HTTPException(status_code=401, detail="Authentication required")


# Login page — pure HTML, no JS framework. NVISO Cruiseways palette
# (cyan accent, white background) so it visually matches the gated UI
# behind it.
LOGIN_HTML = """\
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>NVISO Cruises — AISOC Demo · Sign in</title>
  <style>
    :root {
      --bg: #ffffff; --fg: #1f2937; --muted: #6b7280;
      --accent: #0099cc; --accent-bright: #33b0dd;
      --bg-dark: #f3f4f6; --border: #cbd5e1;
    }
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      background: var(--bg);
      color: var(--fg);
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
    }
    .card {
      width: 380px;
      max-width: calc(100vw - 32px);
      padding: 32px 28px;
      background: #ffffff;
      border: 1px solid var(--border);
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.06);
    }
    h1 {
      font-size: 20px;
      font-weight: 700;
      margin: 0 0 4px;
      color: var(--accent);
      letter-spacing: 0.02em;
    }
    .subtitle {
      margin: 0 0 24px;
      font-size: 14px;
      color: var(--muted);
    }
    label {
      display: block;
      font-size: 13px;
      font-weight: 600;
      margin: 14px 0 6px;
    }
    input[type="email"], input[type="password"] {
      width: 100%;
      padding: 9px 10px;
      border: 1px solid var(--border);
      border-radius: 4px;
      font: inherit;
      color: var(--fg);
      background: #ffffff;
    }
    input:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(0,153,204,0.18);
    }
    button {
      width: 100%;
      margin-top: 20px;
      padding: 10px;
      background: var(--accent);
      color: #ffffff;
      border: none;
      border-radius: 4px;
      font-weight: 700;
      font-size: 14px;
      cursor: pointer;
    }
    button:hover { background: var(--accent-bright); }
    .err {
      margin-top: 14px;
      padding: 8px 10px;
      background: rgba(239,68,68,0.1);
      border: 1px solid rgba(239,68,68,0.4);
      color: #991b1b;
      border-radius: 4px;
      font-size: 13px;
    }
    .footer {
      margin-top: 18px;
      font-size: 11px;
      color: var(--muted);
      text-align: center;
    }
  </style>
</head>
<body>
  <div class="card">
    <div style="display:flex; align-items:center; justify-content:center; gap:14px; margin-bottom:14px;">
      <span style="display:inline-flex; flex-direction:column; align-items:flex-start; line-height:1;">
        <img src="/static/nviso-logo.png" alt="NVISO" style="height:36px; display:block;">
        <span style="font-size:10px; font-weight:700; letter-spacing:0.40em; color:#0099CC; margin-top:5px; padding-left:2px;">CRUISES</span>
      </span>
      <svg viewBox="0 0 90 60" style="width:60px; height:42px;" aria-hidden="true">
        <polygon points="34,4 46,4 48,18 32,18" fill="#7DD9F2"/>
        <polygon points="22,18 60,18 56,28 26,28" fill="#33B0DD"/>
        <polygon points="14,28 70,28 66,40 18,40" fill="#0099CC"/>
        <polygon points="6,40 80,40 84,52 2,52" fill="#0F6BAA"/>
        <polygon points="2,52 84,52 76,64 10,64" fill="#0E5C8C"/>
        <path d="M-4 70 Q 6 66 16 70 T 36 70 T 56 70 T 76 70 T 90 70" stroke="#33B0DD" stroke-width="2.4" fill="none" stroke-linecap="round"/>
      </svg>
    </div>
    <p class="subtitle" style="text-align:center; margin-top:0;">
      Agentic SOC Demo — sign in to continue
    </p>
    <form method="post" action="/login">
      <label for="username">Email</label>
      <input id="username" name="username" type="email"
             autocomplete="username" required autofocus>
      <label for="password">Password</label>
      <input id="password" name="password" type="password"
             autocomplete="current-password" required>
      __ERROR__
      <button type="submit">Sign in</button>
    </form>
    <div class="footer">Demo environment — sessions expire after 12 hours.</div>
  </div>
</body>
</html>
"""


@app.get("/login", response_class=HTMLResponse)
def login_form(request: Request) -> Response:
    if _session_user(request):
        return RedirectResponse(url="/", status_code=303)
    return HTMLResponse(LOGIN_HTML.replace("__ERROR__", ""))


@app.post("/login")
def login_submit(
    request: Request,
    username: str = Form(...),
    password: str = Form(...),
) -> Response:
    user_key = username.lower().strip()
    expected_pw = USERS.get(user_key)
    if not expected_pw or expected_pw != password:
        err = '<div class="err">Invalid email or password</div>'
        return HTMLResponse(
            LOGIN_HTML.replace("__ERROR__", err),
            status_code=401,
        )
    sid = _new_session(user_key)
    response = RedirectResponse(url="/", status_code=303)
    response.set_cookie(
        SESSION_COOKIE,
        sid,
        httponly=True,
        samesite="lax",
        path="/",
        max_age=SESSION_TTL_SEC,
    )
    return response


@app.post("/logout")
@app.get("/logout")
def logout(request: Request) -> Response:
    sid = request.cookies.get(SESSION_COOKIE)
    if sid:
        SESSIONS.pop(sid, None)
    response = RedirectResponse(url="/login", status_code=303)
    response.delete_cookie(SESSION_COOKIE, path="/")
    return response


# ── Top-nav shell (used by /, /dashboard, /config) ───────────────────
# Server-side renders a sticky header with logo + 3 tabs +
# "signed in as / sign out". Every authenticated page wraps in this so
# the navigation experience is consistent.
NAV_CSS = """\
<style id="aisoc-nav-css">
  :root {
    --aisoc-nav-bg: #ffffff;
    --aisoc-nav-border: #e5e7eb;
    --aisoc-nav-text: #1f2937;
    --aisoc-nav-muted: #6b7280;
    --aisoc-nav-accent: #0099cc;
    --aisoc-nav-accent-bright: #33b0dd;
    --aisoc-nav-active-bg: #e0f2fe;
  }
  /*
    The vendored Pixel Agents bundle covers the entire viewport with a
    `position: fixed` canvas. To float above it we need (a) `position:
    fixed` on the nav so we share the same stacking context, (b) a
    z-index higher than anything the bundle uses, and (c) !important
    on the layout-critical properties so the bundle's reset styles
    can't shrink us back to invisibility.
  */
  #aisoc-nav {
    position: fixed !important;
    top: 0 !important; left: 0 !important; right: 0 !important;
    z-index: 2147483000 !important;
    background: var(--aisoc-nav-bg) !important;
    border-bottom: 1px solid var(--aisoc-nav-border) !important;
    padding: 8px 24px !important;
    display: flex !important;
    align-items: center !important;
    gap: 32px !important;
    height: 60px !important;
    box-sizing: border-box !important;
    font: 14px -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif !important;
    color: var(--aisoc-nav-text) !important;
  }
  /*
    The vendored Pixel Agents bundle has a global `* { font-family: 'FS
    Pixel Sans' }` rule. Our nav-level font: declaration above only sets
    the font on the nav itself, so the rule cascades down and re-pixels
    every child label. Force the system font on ALL nav descendants so
    the navigation reads as standard chrome, not as part of the game.
  */
  #aisoc-nav,
  #aisoc-nav * {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif !important;
  }
  #aisoc-nav .brand {
    display: flex !important;
    align-items: center !important;
    text-decoration: none !important;
    height: 44px !important;
    gap: 12px !important;
  }
  /* NVISO wordmark (PNG) + "CRUISES" subtitle stacked. */
  #aisoc-nav .brand-mark {
    display: inline-flex !important;
    flex-direction: column !important;
    align-items: flex-start !important;
    line-height: 1 !important;
  }
  #aisoc-nav .brand-mark img {
    height: 32px !important;
    width: auto !important;
    display: block !important;
  }
  #aisoc-nav .brand-mark .tag {
    font-size: 9px !important;
    font-weight: 700 !important;
    letter-spacing: 0.40em !important;
    color: var(--aisoc-nav-accent) !important;
    margin-top: 4px !important;
    padding-left: 2px !important;
  }
  /* Geometric cruise-ship icon to the right of the wordmark. */
  #aisoc-nav .brand-ship {
    display: inline-flex !important;
    align-items: center !important;
    height: 44px !important;
  }
  #aisoc-nav .brand-ship svg {
    width: 56px !important;
    height: 36px !important;
    display: block !important;
  }
  #aisoc-nav .tabs { display: flex !important; gap: 4px !important; }
  #aisoc-nav .tab {
    padding: 7px 14px !important;
    color: var(--aisoc-nav-muted) !important;
    text-decoration: none !important;
    border-radius: 4px !important;
    font-weight: 500 !important;
    font-size: 14px !important;
  }
  #aisoc-nav .tab:hover {
    background: #f3f4f6 !important;
    color: var(--aisoc-nav-text) !important;
  }
  #aisoc-nav .tab.active {
    color: var(--aisoc-nav-accent) !important;
    background: var(--aisoc-nav-active-bg) !important;
    font-weight: 700 !important;
  }
  #aisoc-nav .userbar {
    margin-left: auto !important;
    display: flex !important;
    align-items: center !important;
    gap: 14px !important;
    color: var(--aisoc-nav-muted) !important;
    font-size: 12px !important;
  }
  #aisoc-nav .userbar .signout {
    color: var(--aisoc-nav-accent) !important;
    text-decoration: none !important;
    font-weight: 600 !important;
  }
  #aisoc-nav .userbar .signout:hover {
    color: var(--aisoc-nav-accent-bright) !important;
    text-decoration: underline !important;
  }
</style>
"""


# Geometric cruise-ship icon, inlined so we don't need a second
# round-trip for the brand mark. Origami / triangulated facets in the
# NVISO blue palette — visually consistent with the NVISO bird mark
# but unmistakably a ship.
SHIP_SVG_INLINE = (
    '<svg viewBox="0 0 90 60" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">'
    '<polygon points="34,4 46,4 48,18 32,18" fill="#7DD9F2"/>'
    '<polygon points="22,18 60,18 56,28 26,28" fill="#33B0DD"/>'
    '<polygon points="14,28 70,28 66,40 18,40" fill="#0099CC"/>'
    '<polygon points="6,40 80,40 84,52 2,52" fill="#0F6BAA"/>'
    '<polygon points="2,52 84,52 76,64 10,64" fill="#0E5C8C"/>'
    '<path d="M-4 70 Q 6 66 16 70 T 36 70 T 56 70 T 76 70 T 90 70" '
    'stroke="#33B0DD" stroke-width="2.4" fill="none" stroke-linecap="round"/>'
    '</svg>'
)


def _render_nav(active: str, current_user: str) -> str:
    """Render the top-nav. ``active`` selects which tab gets highlighted.

    Brand mark is composed from the real NVISO wordmark PNG plus an
    inline SVG ship. The PNG must live at /static/nviso-logo.png; if
    it's missing the alt text "NVISO" shows in its place.
    """
    tabs = (
        ("live",      "/",          "Live Agent View"),
        ("dashboard", "/dashboard", "Dashboard"),
        ("config",    "/config",    "Configuration"),
    )
    items = []
    for key, href, label in tabs:
        cls = "tab active" if key == active else "tab"
        items.append(f'<a class="{cls}" href="{href}">{label}</a>')
    return (
        '<nav id="aisoc-nav">'
        '  <a href="/dashboard" class="brand">'
        '    <span class="brand-mark">'
        '      <img src="/static/nviso-logo.png" alt="NVISO">'
        '      <span class="tag">CRUISES</span>'
        '    </span>'
        f'    <span class="brand-ship">{SHIP_SVG_INLINE}</span>'
        '  </a>'
        '  <div class="tabs">' + "".join(items) + '</div>'
        '  <div class="userbar">'
        f'    <span>Signed in as <b>{current_user}</b></span>'
        '    <a href="/logout" class="signout">Sign out</a>'
        '  </div>'
        '</nav>'
    )


# Page chrome shared by /dashboard and /config (server-rendered, no
# React). The Live Agent View at / has its own chrome because it
# wraps the vendored Pixel Agents bundle.
SHELL_BASE_CSS = """\
<style id="aisoc-shell-base">
  body {
    margin: 0;
    /* Push body content below the fixed nav (60px tall). */
    padding-top: 60px;
    font: 14px -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    background: #ffffff;
    color: #1f2937;
  }
  main { max-width: 1280px; margin: 0 auto; padding: 24px 28px 64px; }
  h1 { font-size: 22px; font-weight: 700; margin: 0 0 4px; color: #1f2937; }
  h2 { font-size: 15px; font-weight: 700; margin: 28px 0 10px; color: #374151;
       letter-spacing: 0.02em; text-transform: uppercase; }
  .subtitle { color: #6b7280; margin: 0 0 28px; font-size: 14px; }
</style>
"""


def _render_shell(
    *,
    active: str,
    current_user: str,
    title: str,
    body_html: str,
    extra_head: str = "",
    scripts: list[str] | None = None,
) -> str:
    """Wrap a server-rendered page in our standard chrome (logo + nav + body)."""
    scripts = scripts or []
    script_tags = "".join(f'<script src="{s}" defer></script>' for s in scripts)
    return (
        f'<!DOCTYPE html><html lang="en"><head>'
        f'<meta charset="utf-8">'
        f'<title>{title}</title>'
        f'<link rel="icon" href="/static/nviso-cruises-logo.svg">'
        f'{SHELL_BASE_CSS}'
        f'{NAV_CSS}'
        f'{extra_head}'
        f'</head><body>'
        f'{_render_nav(active, current_user)}'
        f'<main>{body_html}</main>'
        f'{script_tags}'
        f'</body></html>'
    )


@app.get("/dashboard", response_class=HTMLResponse)
def dashboard_view(request: Request) -> Response:
    user = _session_user(request)
    if user is None:
        return RedirectResponse(url="/login", status_code=303)
    body = (
        '<h1>Agentic SOC Dashboard</h1>'
        '<p class="subtitle">'
        '  Microsoft Sentinel incidents seen in the lab + per-incident cost spent by the AI agents.'
        '  Right-click an incident to act, or use the inline button.'
        '</p>'
        '<div id="aisoc-dashboard-root"></div>'
    )
    return HTMLResponse(_render_shell(
        active="dashboard",
        current_user=user,
        title="NVISO Cruises · Dashboard",
        body_html=body,
        scripts=["/static/dashboard.js"],
    ))


@app.get("/config", response_class=HTMLResponse)
def config_view(request: Request) -> Response:
    user = _session_user(request)
    if user is None:
        return RedirectResponse(url="/login", status_code=303)
    body = (
        '<h1>Agentic SOC Configuration</h1>'
        '<p class="subtitle">'
        '  Live agent telemetry. Toggle the JSON switch on each card to see the raw'
        '  state PixelAgents Web has on file.'
        '</p>'
        '<div id="aisoc-auto-pickup-root"></div>'
        '<div id="aisoc-auto-close-root"></div>'
        '<div id="aisoc-generic-instructions-root"></div>'
        '<div id="aisoc-config-root"></div>'
    )
    return HTMLResponse(_render_shell(
        active="config",
        current_user=user,
        title="NVISO Cruises · Configuration",
        body_html=body,
        scripts=["/static/config.js"],
    ))


@app.get("/chat-popup", response_class=HTMLResponse)
def chat_popup_view(request: Request, kind: str = "", id: str = "") -> Response:
    """Standalone chat window. Opened by the Live Agent View sidebar
    via window.open() so analysts can keep multiple chats docked
    independently of the main page. Keeps the markup minimal — no
    nav, no canvas, just a chat surface — and ships chat_popup.js
    which mirrors the existing chat plumbing (SSE streaming for
    agents, regular POST for human DMs)."""

    user = _session_user(request)
    if user is None:
        return RedirectResponse(url="/login", status_code=303)

    kind = (kind or "").strip().lower()
    target_id = (id or "").strip()
    if kind not in ("agent", "human") or not target_id:
        return HTMLResponse(
            "<h1>Bad chat-popup request</h1>"
            "<p>Open this from the Live Agent View sidebar — direct visits aren't supported.</p>",
            status_code=400,
        )

    if kind == "agent":
        target_id = _slug_agent(target_id)
        title = f"{target_id.title()} · NVISO Cruises"
        header = target_id.title()
    else:
        target_id = target_id.lower()
        title = f"DM · {target_id} · NVISO Cruises"
        header = target_id

    token = os.getenv(TOKEN_ENV, "")
    cfg = json.dumps({
        "kind": kind,
        "id": target_id,
        "me": user,
        "token": token,
        "header": header,
    })

    html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>{title}</title>
  <link rel="icon" href="data:,">
  <style>
    html, body {{ height: 100%; margin: 0; padding: 0; }}
    body {{
      display: flex; flex-direction: column;
      font: 15px -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      color: #1f2937;
      background: #ffffff;
      overflow: hidden;
    }}
  </style>
</head>
<body>
  <script>window.__CHAT_POPUP_CONFIG = {cfg};</script>
  <script src="/static/chat_popup.js"></script>
</body>
</html>
"""
    return HTMLResponse(html)


# ── Current incident tracking ────────────────────────────────────────
# Set by the orchestrate proxy when a workflow run starts; cleared when
# it finishes (or errors). Lets the Live Agent View show "we're working
# on incident #N right now" without having to derive it from event logs.
CURRENT_INCIDENT: dict[str, Any] = {"incident_number": None, "started_at": None}

# Per-incident workflow run history. Keyed by incident_number (string),
# value is a list of run records (oldest -> newest, capped). Each record:
#   {run_id, started_at, ended_at, status, mode, error?, summary?}
#
# Lives in-process — single-replica deploy + acceptable for a demo. A
# container restart wipes history.
WORKFLOW_RUNS: dict[str, list[dict[str, Any]]] = {}
WORKFLOW_RUNS_CAP = 20


# ── View-level phase per incident ────────────────────────────────────
# Sentinel only knows New / Active / Closed. Our UI distinguishes a
# fourth axis on top of "Active": is the incident currently in the
# agents' hands, or has it been handed back to the human analyst?
#
# Keys: str(incident_number). Values:
#   { "phase": "agentic" | "human", "since": float, "reason": str }
#
# When a Sentinel incident is in "Active" and we have no recorded phase,
# we default to "human" — the safest interpretation for an incident the
# agents haven't touched. When Sentinel says "New" or "Closed", phase is
# ignored.
INCIDENT_PHASES: dict[str, dict[str, Any]] = {}


def _set_phase(incident_number: int, phase: str, reason: str) -> None:
    """Record the current view-level phase for an incident."""
    INCIDENT_PHASES[str(incident_number)] = {
        "phase": phase,
        "since": time.time(),
        "reason": reason,
    }


def _get_phase(incident_number: Any) -> str | None:
    rec = INCIDENT_PHASES.get(str(incident_number)) if incident_number is not None else None
    return (rec or {}).get("phase")


def _view_status(sentinel_status: str | None, phase: str | None) -> str:
    """Combine raw Sentinel status with our phase axis into the 4-way
    UI status. Returns one of: new, active-agentic, active-human, closed.

    - Sentinel.New      -> "new"          (phase ignored — not yet picked up)
    - Sentinel.Active   -> "active-agentic" if phase == "agentic" else "active-human"
    - Sentinel.Closed   -> "closed"       (phase ignored)
    """
    s = (sentinel_status or "").strip().lower()
    if s == "new":
        return "new"
    if s == "closed":
        return "closed"
    if s == "active":
        return "active-agentic" if phase == "agentic" else "active-human"
    return s or "unknown"


def _runs_bucket(incident_number: int) -> list[dict[str, Any]]:
    key = str(incident_number)
    bucket = WORKFLOW_RUNS.get(key)
    if bucket is None:
        bucket = []
        WORKFLOW_RUNS[key] = bucket
    return bucket


def _start_run(incident_number: int, mode: str) -> dict[str, Any]:
    """Append a 'running' record and return it (caller updates in place)."""
    bucket = _runs_bucket(incident_number)
    rec = {
        "run_id": secrets.token_urlsafe(8),
        "started_at": time.time(),
        "ended_at": None,
        "status": "running",
        "mode": mode,
        "error": None,
        "summary": None,
    }
    bucket.append(rec)
    if len(bucket) > WORKFLOW_RUNS_CAP:
        del bucket[: len(bucket) - WORKFLOW_RUNS_CAP]
    return rec


def _end_run(rec: dict[str, Any], status: str, *, error: str | None = None,
             summary: str | None = None) -> None:
    rec["ended_at"] = time.time()
    rec["status"] = status
    if error is not None:
        rec["error"] = error
    if summary is not None:
        rec["summary"] = summary


# ── Auto-pickup (continuous Sentinel monitoring) ─────────────────────
# When enabled, a background task polls Sentinel every AUTO_PICKUP_INTERVAL
# seconds. The first "New" incident we haven't seen before triggers the
# orchestration pipeline. If the run fails, we DO NOT retry — the incident
# is marked seen, and a human analyst takes over from the dashboard.
# State is in-memory; container restart resets the seen set, but we
# re-prime it from the current Sentinel listing on startup so we don't
# retroactively trigger on every existing "New" incident on every redeploy.
#
# The default has been ON since the dashboard's "Run workflow" button
# was retired — the model is now: auto-pickup handles the moment of
# discovery, humans / agents take it from there.
AUTO_PICKUP: dict[str, Any] = {
    "enabled": True,
    "seen_incidents": set(),  # set[int] — incident numbers already dispatched
    "last_check_ts": None,    # unix seconds, last poll completion
    "last_event": None,       # human-readable status string
    "last_event_ts": None,    # unix seconds
}
AUTO_PICKUP_INTERVAL_SEC = float(os.getenv("AUTO_PICKUP_INTERVAL_SEC", "15"))


def _auto_pickup_set_event(msg: str) -> None:
    AUTO_PICKUP["last_event"] = msg
    AUTO_PICKUP["last_event_ts"] = time.time()
    print(f"[auto-pickup] {msg}", flush=True)


async def _auto_pickup_tick() -> None:
    """One iteration of the background loop. Skips if disabled, if a
    run is already in flight, or if no fresh New incident exists."""

    import asyncio

    if not AUTO_PICKUP.get("enabled"):
        return

    # Don't start a new run while one is already executing — prevents
    # piling up overlapping pipelines if a run takes longer than the
    # poll interval.
    if CURRENT_INCIDENT.get("incident_number") is not None:
        return

    try:
        incidents = await asyncio.to_thread(_fetch_sentinel_incidents)
    except Exception as e:
        _auto_pickup_set_event(f"Sentinel poll failed: {e!r}")
        AUTO_PICKUP["last_check_ts"] = time.time()
        return

    AUTO_PICKUP["last_check_ts"] = time.time()

    # Find the oldest unseen "New" incident. Sentinel returns newest-first;
    # iterate reversed so we handle them in arrival order.
    seen: set = AUTO_PICKUP["seen_incidents"]
    candidate: dict[str, Any] | None = None
    for inc in reversed(incidents):
        num = inc.get("number")
        if not isinstance(num, int):
            continue
        status = (inc.get("status") or "").strip().lower()
        if status != "new":
            continue
        if num in seen:
            continue
        candidate = inc
        break

    if candidate is None:
        return

    num = int(candidate["number"])
    title = candidate.get("title") or f"Incident #{num}"

    # Mark seen BEFORE dispatch so a failure doesn't retry on the next
    # tick. The toggle is "if it fails, the human takes over."
    seen.add(num)

    _auto_pickup_set_event(f"Picked up new incident #{num}: {title}")
    try:
        await _orchestrate_one(num, mode="full", writeback=True, trigger="auto-pickup")
        _auto_pickup_set_event(f"Completed #{num}")
    except OrchestratorError as e:
        body_repr = ""
        try:
            body_repr = json.dumps(e.body)[:300] if e.body is not None else ""
        except Exception:
            body_repr = str(e.body)[:300]
        _auto_pickup_set_event(
            f"Failed #{num} (no retry — analyst takes over): "
            f"status={e.status} {body_repr}"
        )
    except Exception as e:
        _auto_pickup_set_event(f"Failed #{num} (no retry — analyst takes over): {e!r}")


async def _auto_pickup_loop() -> None:
    """Long-running background task. Started once at app startup; runs
    forever, regardless of toggle state — _auto_pickup_tick() is the
    one that respects the enabled flag."""

    import asyncio

    while True:
        try:
            await _auto_pickup_tick()
        except Exception as e:
            print(f"[auto-pickup] loop error: {e!r}", flush=True)
        await asyncio.sleep(AUTO_PICKUP_INTERVAL_SEC)


async def _prime_seen_incidents() -> None:
    """Mark every currently-known incident number as 'seen' so the
    auto-pickup loop only triggers on incidents that arrive AFTER
    startup. Without this, every container restart with auto-pickup
    enabled would replay all existing 'New' incidents through triage
    one-by-one — not what users expect when the toggle is on."""
    import asyncio

    try:
        incidents = await asyncio.to_thread(_fetch_sentinel_incidents)
    except Exception as e:
        _auto_pickup_set_event(f"Startup prime failed: {e!r}")
        return
    primed = 0
    for inc in incidents:
        num = inc.get("number")
        if isinstance(num, int):
            AUTO_PICKUP["seen_incidents"].add(num)
            primed += 1
    _auto_pickup_set_event(
        f"Startup primed — {primed} existing incident(s) marked seen; "
        f"only newly-arriving incidents will trigger workflows"
    )


@app.on_event("startup")
async def _start_auto_pickup() -> None:
    import asyncio

    # If auto-pickup is enabled at startup (the new default), prime
    # the seen set from the current Sentinel listing so existing
    # incidents aren't retroactively re-triaged. We run this BEFORE
    # the loop kicks off so the first tick has the primed set.
    if AUTO_PICKUP.get("enabled"):
        await _prime_seen_incidents()

    asyncio.create_task(_auto_pickup_loop())


# ── SOC Manager periodic review ──────────────────────────────────────
# Default interval: 1 hour. Set SOC_MANAGER_REVIEW_INTERVAL_SEC to 0
# to disable the loop entirely (manual /api/soc_manager/review still
# works). Keep this conservative — every tick spends Foundry tokens.
SOC_MANAGER_REVIEW_INTERVAL_SEC = float(os.getenv("SOC_MANAGER_REVIEW_INTERVAL_SEC", "3600"))
# Skip the review when there are fewer than this many runs to look at.
# A periodic review needs SOMETHING to look at, otherwise the SOC
# Manager has nothing useful to say.
SOC_MANAGER_REVIEW_MIN_RUNS = int(os.getenv("SOC_MANAGER_REVIEW_MIN_RUNS", "3"))


def _build_soc_manager_review_summary(max_runs: int = 20) -> str:
    """Build a text summary of recent workflow runs for the SOC
    Manager to review. Returns empty string when there's nothing
    meaningful to chew on (no runs yet, or all runs are too thin to
    learn anything from)."""

    flat: list[tuple[float, str, dict[str, Any]]] = []
    for inc_num_str, runs in WORKFLOW_RUNS.items():
        for r in runs or []:
            ts = r.get("started_at") or 0
            flat.append((ts, str(inc_num_str), r))
    if len(flat) < SOC_MANAGER_REVIEW_MIN_RUNS:
        return ""
    flat.sort(key=lambda t: t[0], reverse=True)

    lines: list[str] = []
    for _, inc_num, r in flat[:max_runs]:
        line = f"- Incident #{inc_num}: {r.get('status')} (mode={r.get('mode')!r}"
        dur = None
        if r.get("started_at") and r.get("ended_at"):
            dur = max(0, int(r["ended_at"] - r["started_at"]))
        if dur is not None:
            line += f", duration={dur}s"
        if r.get("error"):
            line += f", error={str(r['error'])[:200]!r}"
        if r.get("summary"):
            line += f", summary={str(r['summary'])[:200]!r}"
        line += ")"
        lines.append(line)

    return "\n".join(lines)


def _soc_manager_review_tick_blocking() -> dict[str, Any]:
    """One review tick. Sync because requests.post is sync; called
    from the async loop via asyncio.to_thread."""

    summary = _build_soc_manager_review_summary()
    if not summary:
        return {"skipped": "not enough runs to review"}

    project_endpoint = os.getenv("AZURE_AI_FOUNDRY_PROJECT_ENDPOINT", "")
    if not project_endpoint:
        return {"error": "AZURE_AI_FOUNDRY_PROJECT_ENDPOINT not set"}

    try:
        from azure.identity import DefaultAzureCredential
        token = DefaultAzureCredential().get_token("https://ai.azure.com/.default").token
    except Exception as e:
        return {"error": f"could not get bearer: {e!r}"}

    user_text = (
        "You are doing a periodic SOC review. Below are the most recent "
        "incident triage / investigation / reporting outcomes from this "
        "lab. Look for patterns: false positives, missed nuances, "
        "recurring confusion. If you spot something the common preamble "
        "or a specific agent's instructions could fix, propose the change "
        "via your tools. Do NOT propose for the sake of proposing — if "
        "everything looks fine, output a single line saying so and stop.\n\n"
        f"RECENT_RUNS:\n{summary}\n"
    )

    import requests as _requests

    url = project_endpoint.rstrip("/") + "/openai/v1/responses"
    payload = {
        "input": user_text,
        "agent_reference": {"name": "soc-manager", "type": "agent_reference"},
    }
    try:
        r = _requests.post(
            url,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            json=payload,
            timeout=240,
        )
    except Exception as e:
        print(f"[soc-manager] review invoke raised: {e!r}", flush=True)
        return {"error": f"invoke raised: {e!r}"}

    if r.status_code >= 400:
        print(
            f"[soc-manager] review invoke failed: {r.status_code} {r.text[:500]}",
            flush=True,
        )
        return {"error": f"{r.status_code}: {r.text[:500]}"}

    print(f"[soc-manager] review tick completed; runs_summarized={summary.count(chr(10))+1}", flush=True)
    return {"ok": True, "runs_summarized": summary.count("\n") + 1}


async def _soc_manager_review_loop() -> None:
    import asyncio as _asyncio

    while True:
        try:
            await _asyncio.to_thread(_soc_manager_review_tick_blocking)
        except Exception as e:
            print(f"[soc-manager] review loop error: {e!r}", flush=True)
        await _asyncio.sleep(SOC_MANAGER_REVIEW_INTERVAL_SEC)


@app.on_event("startup")
async def _start_soc_manager_review() -> None:
    import asyncio as _asyncio

    if SOC_MANAGER_REVIEW_INTERVAL_SEC <= 0:
        print("[soc-manager] periodic review disabled (interval <= 0)", flush=True)
        return
    _asyncio.create_task(_soc_manager_review_loop())


@app.post("/api/soc_manager/review")
async def api_soc_manager_review(
    request: Request,
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> dict[str, Any]:
    """Manually trigger a SOC Manager review tick. Useful for the
    demo (the periodic interval defaults to an hour) and for
    operators who want to nudge the agent after a notable incident
    without waiting for the next scheduled tick."""
    _require_auth(request, x_pixelagents_token)
    import asyncio as _asyncio
    result = await _asyncio.to_thread(_soc_manager_review_tick_blocking)
    return {"ok": True, "result": result}


def _auto_pickup_public_state() -> dict[str, Any]:
    """Snapshot suitable for the JSON API (sets aren't JSON-serializable)."""
    return {
        "enabled": bool(AUTO_PICKUP.get("enabled")),
        "interval_sec": AUTO_PICKUP_INTERVAL_SEC,
        "last_check_ts": AUTO_PICKUP.get("last_check_ts"),
        "last_event": AUTO_PICKUP.get("last_event"),
        "last_event_ts": AUTO_PICKUP.get("last_event_ts"),
        "seen_count": len(AUTO_PICKUP.get("seen_incidents") or ()),
    }


@app.get("/api/auto_pickup")
def api_auto_pickup_get(
    request: Request,
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> dict[str, Any]:
    _require_auth(request, x_pixelagents_token)
    return _auto_pickup_public_state()


# ── Auto-close (let the reporter close incidents in Sentinel) ────────
# When enabled, the orchestrator request body includes auto_close=True
# and the reporter agent is permitted to close the Sentinel incident
# directly when its analysis is conclusive. When disabled (the default),
# every successful run hands back to the human analyst for review and
# closure. Decoupled from auto-pickup: an analyst can run automation on
# pickup without giving up final closure authority.
AUTO_CLOSE: dict[str, Any] = {
    "enabled": False,
    "last_event": None,
    "last_event_ts": None,
}


def _auto_close_set_event(msg: str) -> None:
    AUTO_CLOSE["last_event"] = msg
    AUTO_CLOSE["last_event_ts"] = time.time()
    print(f"[auto-close] {msg}", flush=True)


def _auto_close_public_state() -> dict[str, Any]:
    return {
        "enabled": bool(AUTO_CLOSE.get("enabled")),
        "last_event": AUTO_CLOSE.get("last_event"),
        "last_event_ts": AUTO_CLOSE.get("last_event_ts"),
    }


@app.get("/api/auto_close")
def api_auto_close_get(
    request: Request,
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> dict[str, Any]:
    _require_auth(request, x_pixelagents_token)
    return _auto_close_public_state()


@app.post("/api/auto_close")
async def api_auto_close_set(
    req: Request,
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> dict[str, Any]:
    _require_auth(req, x_pixelagents_token)
    try:
        body = await req.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    new_val = bool(body.get("enabled"))
    prev = bool(AUTO_CLOSE.get("enabled"))
    AUTO_CLOSE["enabled"] = new_val
    if new_val and not prev:
        _auto_close_set_event("Enabled — reporter may close confident incidents")
    elif (not new_val) and prev:
        _auto_close_set_event("Disabled — every run hands back to analyst")
    return _auto_close_public_state()


@app.post("/api/auto_pickup")
async def api_auto_pickup_set(
    req: Request,
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> dict[str, Any]:
    _require_auth(req, x_pixelagents_token)
    try:
        body = await req.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}
    new_val = bool(body.get("enabled"))
    prev = bool(AUTO_PICKUP.get("enabled"))
    AUTO_PICKUP["enabled"] = new_val

    # When flipping ON, prime the seen set with the currently-listed
    # incidents so we don't retroactively pick up stale "New" entries
    # that the user has been ignoring all morning. From this moment on,
    # only incidents that appear *after* the toggle was flipped will
    # trigger the workflow.
    if new_val and not prev:
        import asyncio

        try:
            incidents = await asyncio.to_thread(_fetch_sentinel_incidents)
            primed = 0
            for inc in incidents:
                num = inc.get("number")
                if isinstance(num, int):
                    AUTO_PICKUP["seen_incidents"].add(num)
                    primed += 1
            _auto_pickup_set_event(f"Enabled — primed {primed} existing incident(s) as seen")
        except Exception as e:
            _auto_pickup_set_event(f"Enabled — could not prime seen set: {e!r}")
    elif (not new_val) and prev:
        _auto_pickup_set_event("Disabled by user")

    return _auto_pickup_public_state()


@app.get("/api/current_incident")
def api_current_incident(
    request: Request,
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> dict[str, Any]:
    """Snapshot of the in-flight workflow run, if any.

    The base shape is `{"incident_number": int|None, "started_at":
    float|None}`. When an incident is in flight we enrich the response
    with `title`, `view_status`, and `phase` pulled from the cached
    incidents listing — saves the sidebar a separate fetch round-trip
    per poll just to render the banner.
    """

    _require_auth(request, x_pixelagents_token)
    snapshot: dict[str, Any] = dict(CURRENT_INCIDENT)
    num = snapshot.get("incident_number")
    if num is not None:
        cached = _INCIDENTS_CACHE.get("payload")
        if isinstance(cached, dict):
            for inc in (cached.get("incidents") or []):
                if inc.get("number") == num:
                    snapshot["title"] = inc.get("title")
                    snapshot["view_status"] = inc.get("view_status")
                    snapshot["severity"] = inc.get("severity")
                    break
        # Phase tracking from INCIDENT_PHASES (set by _orchestrate_one).
        phase_rec = INCIDENT_PHASES.get(str(num)) or {}
        if phase_rec:
            snapshot["phase"] = phase_rec.get("phase")
    return snapshot


@app.get("/api/sentinel/incidents/{incident_number}/runs")
def api_incident_runs(
    incident_number: int,
    request: Request,
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> dict[str, Any]:
    """Per-incident workflow run history, newest first."""
    _require_auth(request, x_pixelagents_token)
    bucket = WORKFLOW_RUNS.get(str(incident_number)) or []
    return {
        "incident_number": incident_number,
        "runs": list(reversed(bucket)),
    }


@app.get("/api/sentinel/incidents/runs")
def api_all_incident_runs(
    request: Request,
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> dict[str, Any]:
    """Aggregate run summary so the dashboard can render badges on every
    row in a single poll. Per-incident: total + most-recent status."""
    _require_auth(request, x_pixelagents_token)
    out: dict[str, Any] = {}
    for key, bucket in WORKFLOW_RUNS.items():
        if not bucket:
            continue
        last = bucket[-1]
        out[key] = {
            "count": len(bucket),
            "last_status": last.get("status"),
            "last_started_at": last.get("started_at"),
            "last_ended_at": last.get("ended_at"),
        }
    return {"runs": out, "ts": time.time()}


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"ok": "true"}


def _default_agent_roster() -> list[str]:
    # Comma-separated list of agents that should always exist in UI even before events.
    # Defaults to the classic trio + detection engineer + SOC manager.
    raw = os.getenv("PIXELAGENTS_AGENT_ROSTER", "triage,investigator,reporter,detection-engineer,soc-manager")
    names = [x.strip() for x in raw.split(",") if x.strip()]
    # De-dupe while preserving order
    out: list[str] = []
    for n in names:
        if n not in out:
            out.append(n)
    return out


@app.get("/api/agents/state")
def api_agents_state(
    request: Request,
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> dict[str, Any]:
    _require_auth(request, x_pixelagents_token)
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

    # Return only the stable roster. Earlier versions also surfaced
    # any dynamically discovered agent slug from the AGENTS dict, which
    # made it easy for an upstream bug (e.g. an orchestrator helper
    # tagging a runner call with an unrecognised slug) to spawn a
    # phantom character in the Live View — and the ghost would persist
    # in memory until the container restarted. The roster is the
    # contract: anything not in it is treated as noise. To add a new
    # agent, extend PIXELAGENTS_AGENT_ROSTER (env var) rather than
    # relying on dynamic discovery.
    roster = _default_agent_roster()

    agents = []
    for name in roster:
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


# ── Foundry agent instructions (read-only) ───────────────────────────
# Pulls each agent's current `instructions` blob from Foundry via the
# AI Projects SDK (same SDK the Phase-2 deploy script uses to write).
# Splits the shared preamble (common.md content, identical across all
# four agents) from the role-specific tail. Cached briefly so polling
# the /config page doesn't hammer Foundry.
_FOUNDRY_INSTRUCTIONS_CACHE: Dict[str, Any] = {"ts": 0.0, "payload": None}
_FOUNDRY_INSTRUCTIONS_TTL_SEC = 30.0


def _extract_instructions_from_result(result: Any) -> str:
    """Probe a Foundry agents-API result shape for an instructions
    string. Walks specific named fields rather than iterating a dict's
    keys — earlier version had a bug where iterating a metadata dict
    returned a key name (e.g. "blueprint_reference") as if it were the
    instructions content."""

    if result is None:
        return ""
    if isinstance(result, str):
        return result

    # Dict path — only look at named fields, never iterate keys.
    if isinstance(result, dict):
        instr = result.get("instructions")
        if isinstance(instr, str) and instr:
            return instr
        for accessor in ("definition", "_definition", "properties"):
            obj = result.get(accessor)
            if obj is not None:
                nested = _extract_instructions_from_result(obj)
                if nested:
                    return nested
        return ""

    # Object path — attribute lookup.
    instr = getattr(result, "instructions", None)
    if isinstance(instr, str) and instr:
        return instr
    for accessor in ("definition", "_definition", "properties"):
        obj = getattr(result, accessor, None)
        if obj is not None:
            nested = _extract_instructions_from_result(obj)
            if nested:
                return nested

    # Iterables (lists, ItemPaged) — but NOT dicts/strings/bytes.
    if (
        hasattr(result, "__iter__")
        and not isinstance(result, (str, bytes, bytearray, dict))
    ):
        try:
            items = list(result)
        except Exception:
            items = []
        for item in reversed(items):
            nested = _extract_instructions_from_result(item)
            if nested:
                return nested

    return ""


_FOUNDRY_LAST_AVAILABLE_METHODS: list[str] = []


def _fetch_foundry_agent_instructions() -> dict[str, dict[str, Any]]:
    """Return {agent_slug: {"instructions": str, "_debug": list[str]}}
    for each agent in the configured roster.

    Strategy: bypass the SDK entirely. The b11 SDK's `client.agents`
    surface is OpenAI Assistants-shaped (list_agents/get_agent), and
    that registry is empty — our agents were created via the newer
    SDK's create_version() and live in a different Foundry namespace.
    The orchestrator has the same problem and solves it by calling
    /openai/v1/responses with `agent_reference: {name, type}` directly.
    We use the same auth (DefaultAzureCredential -> ai.azure.com
    bearer) and probe a few plausible REST paths for the agent's
    instructions field. Whichever one returns 200 + a parseable
    instructions wins; the others get logged into _debug.

    Raises RuntimeError only on missing project endpoint or token
    failure; per-agent / per-URL probe failures fall through to "" and
    are recorded in _debug so we can iterate from the browser.
    """

    project_endpoint = os.getenv("AZURE_AI_FOUNDRY_PROJECT_ENDPOINT", "")
    if not project_endpoint:
        raise RuntimeError("AZURE_AI_FOUNDRY_PROJECT_ENDPOINT not set")

    try:
        from azure.identity import DefaultAzureCredential
    except Exception as e:
        raise RuntimeError(f"azure-identity not available: {e!r}") from e

    try:
        token = DefaultAzureCredential().get_token("https://ai.azure.com/.default").token
    except Exception as e:
        raise RuntimeError(f"could not get bearer token: {e!r}") from e

    base = project_endpoint.rstrip("/")

    # URL templates to probe per agent. Most-likely-to-work first; the
    # first one that returns 200 + parseable instructions wins. The
    # `agents/{slug}/versions/latest` shape mirrors the SDK's
    # create_version write path, with various plausible api-versions.
    url_templates = [
        f"{base}/agents/{{slug}}/versions/latest?api-version=2025-05-15-preview",
        f"{base}/agents/{{slug}}/versions/latest?api-version=2025-05-01",
        f"{base}/agents/{{slug}}/versions/latest?api-version=2024-12-01-preview",
        f"{base}/agents/{{slug}}?api-version=2025-05-15-preview",
        f"{base}/agents/{{slug}}?api-version=2024-12-01-preview",
        f"{base}/openai/v1/agents/{{slug}}/versions/latest",
        f"{base}/openai/v1/agents/{{slug}}",
    ]

    # Surface the URL list once at the top so the response includes it
    # for diagnostic purposes, regardless of which one (if any) wins.
    global _FOUNDRY_LAST_AVAILABLE_METHODS
    _FOUNDRY_LAST_AVAILABLE_METHODS = [t.replace("{slug}", "<slug>") for t in url_templates]

    import requests as _requests

    def _do_get(url: str) -> tuple[int, Any, str | None]:
        """GET helper. Returns (status, body, error_str). body is dict or text."""
        try:
            r = _requests.get(
                url,
                headers={"Authorization": f"Bearer {token}"},
                timeout=15,
            )
        except Exception as e:
            return (0, None, f"{type(e).__name__}: {str(e)[:120]}")
        try:
            body = r.json()
        except Exception:
            body = r.text[:300] if r.text else ""
        return (r.status_code, body, None)

    # Field names to probe on a metadata response for the latest
    # version number — covers the camelCase / snake_case / dotted
    # variants we've seen across Azure AI Foundry API revisions.
    VERSION_FIELDS = (
        "latest_version_number", "latestVersionNumber",
        "latest_version", "latestVersion",
        "current_version_number", "currentVersionNumber",
        "current_version", "currentVersion",
        "version_number", "versionNumber",
        "version",
    )

    def _find_version(body: dict) -> tuple[str | None, str, dict | None]:
        """Returns (version_str, debug_note, embedded_object).

        Foundry returns `versions: {"latest": {...full version obj...}}`
        in this project — so we both pull a version *number* AND
        return the embedded version dict itself, in case the caller
        can extract instructions from it without another HTTP call.
        """

        versions = body.get("versions")

        # Dict shape: {"latest": {...}}
        if isinstance(versions, dict):
            latest = versions.get("latest")
            if isinstance(latest, dict):
                for f in ("version", "version_number", "versionNumber"):
                    v = latest.get(f)
                    if isinstance(v, (int, str)) and str(v):
                        return (str(v), f"versions.latest.{f}", latest)
                # Fall back: look at id like "triage:1" and split.
                vid = latest.get("id")
                if isinstance(vid, str) and ":" in vid:
                    return (vid.split(":")[-1], "versions.latest.id (split)", latest)

        # List shape: [{...}, {...}] — newest one usually last.
        if isinstance(versions, list) and versions:
            candidates: list[tuple[str, dict | None]] = []
            for v in versions:
                if isinstance(v, (int, str)) and str(v):
                    candidates.append((str(v), None))
                elif isinstance(v, dict):
                    for f in ("version", "id", "name", "version_number", "versionNumber"):
                        sub = v.get(f)
                        if isinstance(sub, (int, str)) and str(sub):
                            sub_s = str(sub)
                            if ":" in sub_s:
                                sub_s = sub_s.split(":")[-1]
                            candidates.append((sub_s, v))
                            break
            if candidates:
                try:
                    sorted_c = sorted(candidates, key=lambda t: int(t[0]), reverse=True)
                    return (sorted_c[0][0], f"versions[] (numeric, {len(candidates)})", sorted_c[0][1])
                except Exception:
                    sorted_c = sorted(candidates, key=lambda t: t[0], reverse=True)
                    return (sorted_c[0][0], f"versions[] (lex, {len(candidates)})", sorted_c[0][1])

        for f in VERSION_FIELDS:
            v = body.get(f)
            if isinstance(v, (int, str)) and str(v):
                return (str(v), f"field {f!r}", None)

        for nest_key in ("properties", "latest"):
            sub = body.get(nest_key)
            if isinstance(sub, dict):
                v, note, embedded = _find_version(sub)
                if v:
                    return (v, f"{nest_key}.{note}", embedded)
            elif isinstance(sub, (int, str)) and str(sub) and nest_key == "latest":
                return (str(sub), f"field {nest_key!r}", None)

        return (None, "no version field found", None)

    out: dict[str, dict[str, Any]] = {}
    for slug in _default_agent_roster():
        instructions = ""
        debug: list[str] = []

        for tmpl in url_templates:
            url = tmpl.format(slug=slug)
            status, body, err = _do_get(url)
            if err is not None:
                debug.append(f"GET {tmpl}: {err}")
                continue

            if not (200 <= status < 300):
                err_str = (
                    json.dumps(body)[:200] if isinstance(body, dict)
                    else str(body)[:200]
                )
                debug.append(f"GET {tmpl}: {status} - {err_str}")
                continue

            if not isinstance(body, dict):
                debug.append(
                    f"GET {tmpl}: 200 but body type {type(body).__name__}"
                )
                continue

            keys = list(body.keys())[:14]

            # First, try direct extraction — works if the response
            # already includes the full instructions blob.
            extracted = _extract_instructions_from_result(body)
            # Defensive: 'blueprint_reference' is a Foundry agent TYPE
            # marker that legacy code ended up returning by mistake;
            # treat it as a non-result and keep probing.
            if extracted and extracted != "blueprint_reference":
                debug.append(
                    f"GET {tmpl}: 200, {len(extracted)} chars (keys={keys})"
                )
                instructions = extracted
                break

            # Metadata-only response. Look for a version number, plus
            # any embedded version object (Foundry sometimes inlines
            # the full version under versions.latest).
            version, version_note, embedded = _find_version(body)
            if not version:
                versions_repr = repr(body.get("versions"))[:200]
                debug.append(
                    f"GET {tmpl}: 200, no instructions ({version_note}); "
                    f"keys={keys}; versions={versions_repr}"
                )
                continue

            # Try the embedded object first — saves a round-trip if
            # Foundry already inlined the full instructions.
            if embedded is not None:
                em_extracted = _extract_instructions_from_result(embedded)
                if em_extracted and em_extracted != "blueprint_reference":
                    debug.append(
                        f"GET {tmpl}: 200, {len(em_extracted)} chars "
                        f"(inline {version_note})"
                    )
                    instructions = em_extracted
                    break
                em_keys = list(embedded.keys())[:14]
                debug.append(
                    f"GET {tmpl}: inline {version_note} no instructions; "
                    f"em_keys={em_keys}"
                )

            # Build the version-specific URL by inserting /versions/{N}
            # before the query string. e.g. /agents/triage?api-version
            # -> /agents/triage/versions/3?api-version
            if "?" in url:
                path, _, qs = url.partition("?")
                version_url = f"{path}/versions/{version}?{qs}"
            else:
                version_url = f"{url}/versions/{version}"

            v_status, v_body, v_err = _do_get(version_url)
            if v_err is not None:
                debug.append(
                    f"GET {tmpl}: 200 ({version_note} -> {version}), "
                    f"version GET err: {v_err}"
                )
                continue
            if not (200 <= v_status < 300):
                v_err_str = (
                    json.dumps(v_body)[:200] if isinstance(v_body, dict)
                    else str(v_body)[:200]
                )
                debug.append(
                    f"GET {tmpl}: 200 ({version_note} -> {version}), "
                    f"version GET {v_status} - {v_err_str}"
                )
                continue

            v_extracted = _extract_instructions_from_result(v_body)
            if v_extracted and v_extracted != "blueprint_reference":
                debug.append(
                    f"GET {tmpl} -> /versions/{version}: 200, "
                    f"{len(v_extracted)} chars ({version_note})"
                )
                instructions = v_extracted
                break
            else:
                v_keys = list(v_body.keys())[:14] if isinstance(v_body, dict) else []
                debug.append(
                    f"GET {tmpl} -> /versions/{version}: 200, no "
                    f"instructions; keys={v_keys}"
                )

        if not instructions:
            print(
                f"[foundry-instr] {slug}: no instructions extracted; debug={debug}",
                flush=True,
            )

        out[slug] = {"instructions": instructions, "_debug": debug}
    return out


def _split_common_and_role(
    full_by_slug: dict[str, str],
) -> tuple[str, dict[str, str]]:
    """Find the longest common prefix across all agents' instructions
    (truncated to a paragraph boundary so we don't split mid-sentence)
    and return (common_preamble, {slug: role_specific_tail}).

    Falls back gracefully when an agent's instructions are missing or
    the prefix is degenerate — those agents get their full instructions
    back as the role tail.
    """
    populated = {k: v for k, v in full_by_slug.items() if isinstance(v, str) and v.strip()}
    if len(populated) < 2:
        # Need at least two strings to compute a meaningful common
        # prefix. Surface whatever we have as role-only.
        return "", dict(full_by_slug)

    texts = list(populated.values())
    common = texts[0]
    for t in texts[1:]:
        n = min(len(common), len(t))
        i = 0
        while i < n and common[i] == t[i]:
            i += 1
        common = common[:i]

    # Truncate to the last paragraph boundary so the split lands cleanly
    # between two markdown blocks rather than mid-line.
    sep_idx = common.rfind("\n\n")
    common = common[:sep_idx] if sep_idx > 0 else ""
    common_clean = common.rstrip("\n")

    roles: dict[str, str] = {}
    for slug, full in full_by_slug.items():
        if common and isinstance(full, str) and full.startswith(common):
            roles[slug] = full[len(common):].lstrip("\n")
        else:
            roles[slug] = full or ""
    return common_clean, roles


@app.get("/api/foundry/agents/instructions")
def api_foundry_agent_instructions(
    request: Request,
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> dict[str, Any]:
    """Read-only view of each Foundry agent's current `instructions`
    field, with the shared common preamble extracted into its own
    block. Used by /config to render the "Generic instructions /
    context" card and the per-agent instruction expanders.
    """

    _require_auth(request, x_pixelagents_token)

    now = time.time()
    cached = _FOUNDRY_INSTRUCTIONS_CACHE.get("payload")
    if cached is not None and (now - float(_FOUNDRY_INSTRUCTIONS_CACHE.get("ts") or 0)) < _FOUNDRY_INSTRUCTIONS_TTL_SEC:
        return cached

    try:
        rich = _fetch_foundry_agent_instructions()
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    full_by_slug = {slug: (rec.get("instructions") or "") for slug, rec in rich.items()}
    common, roles = _split_common_and_role(full_by_slug)
    payload = {
        "common": common,
        "agents": [
            {
                "slug": slug,
                "instructions": roles.get(slug, ""),
                # Per-agent diagnostic — empty list when extraction
                # succeeded; populated with method probes + errors
                # when nothing worked. Useful for debugging SDK
                # version skew without needing log access.
                "_debug": rich.get(slug, {}).get("_debug", []),
            }
            for slug in _default_agent_roster()
        ],
        # Top-level diagnostic: every callable method available on
        # client.agents in the running SDK. When the per-agent _debug
        # shows "not on client.agents" for everything, this tells me
        # what to call instead.
        "_available_methods": list(_FOUNDRY_LAST_AVAILABLE_METHODS),
        "ts": now,
    }
    _FOUNDRY_INSTRUCTIONS_CACHE["payload"] = payload
    _FOUNDRY_INSTRUCTIONS_CACHE["ts"] = now
    return payload


def _foundry_post_new_version(
    slug: str,
    new_instructions: str,
) -> dict[str, Any]:
    """Create a new version of `slug`'s Foundry agent with the given
    instructions, preserving model + tools from the current version.

    Steps:
      1. GET /agents/{slug}?api-version=... to find the latest version
         (Foundry inlines the full version body under versions.latest
         in this project's API surface).
      2. Use that body as a template; swap in the new instructions.
      3. POST /agents/{slug}/versions?api-version=... to create the
         new version (which becomes the implicit "latest" for future
         agent_reference invocations).

    Returns a dict with at least {"ok": bool, "_debug": [...]} and on
    success {"new_version": <str>}. On failure raises HTTPException
    (so FastAPI surfaces a sensible status code to the UI).
    """

    project_endpoint = os.getenv("AZURE_AI_FOUNDRY_PROJECT_ENDPOINT", "")
    if not project_endpoint:
        raise HTTPException(status_code=500, detail="AZURE_AI_FOUNDRY_PROJECT_ENDPOINT not set")

    try:
        from azure.identity import DefaultAzureCredential
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"azure-identity not available: {e!r}")

    try:
        token = DefaultAzureCredential().get_token("https://ai.azure.com/.default").token
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"could not get bearer token: {e!r}")

    base = project_endpoint.rstrip("/")
    api_ver = "2025-05-15-preview"
    debug: list[str] = []

    import requests as _requests
    import time as _time

    def _get_with_retry(url: str, *, attempts: int = 3) -> Any:
        """GET helper that retries on transient 5xx (Foundry's metadata
        endpoint flakes occasionally — observed as 500 'Internal server
        error' with an activityId). Short exponential backoff so a
        retry storm doesn't pile up; non-5xx and 4xx return immediately."""
        last_resp = None
        for i in range(attempts):
            try:
                resp = _requests.get(
                    url,
                    headers={"Authorization": f"Bearer {token}"},
                    timeout=15,
                )
            except Exception as e:
                debug.append(f"GET {url} attempt {i+1}: {type(e).__name__}: {e!r}")
                if i + 1 == attempts:
                    raise
                _time.sleep(0.5 * (i + 1))
                continue
            last_resp = resp
            if 500 <= resp.status_code < 600 and i + 1 < attempts:
                debug.append(
                    f"GET {url} attempt {i+1}: {resp.status_code} (retrying)"
                )
                _time.sleep(0.5 * (i + 1))
                continue
            return resp
        return last_resp  # all attempts were 5xx; let caller handle

    # 1. Fetch metadata + inline latest version body.
    meta_url = f"{base}/agents/{slug}?api-version={api_ver}"
    try:
        r = _get_with_retry(meta_url)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"agent metadata GET raised: {e!r}")
    debug.append(f"GET {meta_url}: {r.status_code}")
    if r.status_code >= 400:
        raise HTTPException(
            status_code=502,
            detail=f"metadata fetch returned {r.status_code}: {r.text[:1000]}",
        )

    try:
        meta = r.json()
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"metadata not JSON: {e!r}")

    versions_obj = meta.get("versions") if isinstance(meta, dict) else None
    latest = versions_obj.get("latest") if isinstance(versions_obj, dict) else None
    if not isinstance(latest, dict):
        raise HTTPException(
            status_code=502,
            detail=f"agent metadata has no versions.latest dict; keys={list(meta.keys()) if isinstance(meta, dict) else None}",
        )

    # If `latest` is summary-only, fetch the full version body
    # explicitly. Heuristic: if neither instructions nor definition
    # is present, do the round trip.
    needs_full_fetch = (
        "instructions" not in latest
        and "definition" not in latest
        and "model" not in latest
    )
    if needs_full_fetch:
        v_num = latest.get("version") or (
            latest.get("id", "").split(":")[-1] if isinstance(latest.get("id"), str) else None
        )
        if not v_num:
            raise HTTPException(
                status_code=502,
                detail=f"could not determine version number from versions.latest: {list(latest.keys())}",
            )
        v_url = f"{base}/agents/{slug}/versions/{v_num}?api-version={api_ver}"
        debug.append(f"versions.latest summary-only; fetching {v_url}")
        try:
            r2 = _get_with_retry(v_url)
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"version GET raised: {e!r}")
        debug.append(f"GET {v_url}: {r2.status_code}")
        if r2.status_code >= 400:
            raise HTTPException(
                status_code=502,
                detail=f"version fetch returned {r2.status_code}: {r2.text[:1000]}",
            )
        try:
            full_version = r2.json()
        except Exception as e:
            raise HTTPException(status_code=502, detail=f"version body not JSON: {e!r}")
    else:
        full_version = latest

    # 2. Build the new version body. Prefer the {definition: {...}}
    # nesting if it's there (matches the SDK's PromptAgentDefinition
    # shape); otherwise spread top-level fields. Either way, swap in
    # new instructions and drop fields that the API generates server-
    # side (id, version, created_at, etc.).
    READ_ONLY_FIELDS = {
        "id", "object", "version", "created_at", "createdAt",
        "updated_at", "updatedAt", "name", "agent_endpoint",
        "instance_identity", "metadata",
    }

    if isinstance(full_version.get("definition"), dict):
        new_definition = {
            k: v for k, v in full_version["definition"].items()
            if k not in READ_ONLY_FIELDS
        }
        new_definition["instructions"] = new_instructions
        new_body: dict[str, Any] = {"definition": new_definition}
        if "description" in full_version:
            new_body["description"] = full_version["description"]
    else:
        # Flat shape — copy top-level fields except read-only ones,
        # swap in the new instructions.
        new_body = {
            k: v for k, v in full_version.items()
            if k not in READ_ONLY_FIELDS
        }
        new_body["instructions"] = new_instructions

    # 3. POST the new version.
    create_url = f"{base}/agents/{slug}/versions?api-version={api_ver}"
    try:
        r3 = _requests.post(
            create_url,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            json=new_body,
            timeout=30,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"create_version raised: {e!r}")
    debug.append(f"POST {create_url}: {r3.status_code}")
    if r3.status_code >= 400:
        # Most likely 403 (RBAC) or 400 (body shape). Surface the
        # response body verbatim — the UI shows it directly so we can
        # iterate without log access.
        raise HTTPException(
            status_code=502,
            detail={
                "error": f"create_version returned {r3.status_code}",
                "body": r3.text[:2000],
                "_debug": debug,
            },
        )

    try:
        created = r3.json()
    except Exception:
        created = {}

    # Bust the read cache so the next GET reflects the new content.
    _FOUNDRY_INSTRUCTIONS_CACHE["payload"] = None
    _FOUNDRY_INSTRUCTIONS_CACHE["ts"] = 0.0

    return {
        "ok": True,
        "agent": slug,
        "new_version": created.get("version") or created.get("id"),
        "_debug": debug,
    }


@app.post("/api/foundry/agents/{agent_id}/instructions")
async def api_foundry_agent_instructions_set(
    agent_id: str,
    req: Request,
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> dict[str, Any]:
    """Update a single Foundry agent's instructions. Body shape:

        {"instructions": "<full new instructions blob>"}

    The frontend sends the FULL instructions string (common preamble
    + role-specific tail) so the server doesn't have to do any
    splitting — it just creates a new version on Foundry with this
    text, preserving model + tools from the current version.
    """

    _require_auth(req, x_pixelagents_token)

    try:
        body = await req.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    new_instructions = body.get("instructions")
    if not isinstance(new_instructions, str) or not new_instructions.strip():
        raise HTTPException(status_code=400, detail="Missing 'instructions' (non-empty string)")

    slug = _slug_agent(agent_id)
    if not slug or slug == "unknown":
        raise HTTPException(status_code=400, detail="Invalid agent id")

    # Belt-and-braces: only accept slugs that are part of the
    # configured roster, so a mistyped agent_id can't accidentally
    # create a brand-new agent on Foundry.
    if slug not in set(_default_agent_roster()):
        raise HTTPException(
            status_code=400,
            detail=f"agent {slug!r} is not in the configured roster",
        )

    return _foundry_post_new_version(slug, new_instructions)


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

    Accepts either a logged-in browser session (cookie) or the
    ``x-pixelagents-token`` header so it can also be exercised by curl.

    Note: this does not enforce read-only scoping. Whatever tools the named
    agent has attached in Foundry, it can call — including write tools if
    the user's message convinces it to. Layer a scoping mechanism on top
    before exposing broadly.
    """

    _require_auth(req, x_pixelagents_token)

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

    # Chat-drawer calls aren't tied to a specific incident, so they land
    # in the "chat" cost bucket. Still worth capturing for total-spend
    # reporting.
    _record_usage_locally(
        incident_key="chat",
        agent=agent_name,
        phase="chat",
        usage=raw.get("usage"),
    )

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


def _fetch_sentinel_incidents() -> list[dict[str, Any]]:
    """Fetch + parse the Sentinel incidents list. Used by both the
    public list_sentinel_incidents endpoint (with caching wrapper) and
    the auto-pickup background loop (no caching). Raises RuntimeError
    on misconfiguration or ARM failure."""

    sub = os.getenv("AZURE_SUBSCRIPTION_ID", "")
    rg = os.getenv("AZURE_RESOURCE_GROUP", "")
    ws = os.getenv("SENTINEL_WORKSPACE_NAME", "")
    missing = [n for n, v in (
        ("AZURE_SUBSCRIPTION_ID", sub),
        ("AZURE_RESOURCE_GROUP", rg),
        ("SENTINEL_WORKSPACE_NAME", ws),
    ) if not v]
    if missing:
        raise RuntimeError(f"Missing env vars for Sentinel incidents query: {missing}")

    import requests as _requests

    token = _arm_token()
    url = (
        f"https://management.azure.com/subscriptions/{sub}/resourceGroups/{rg}"
        f"/providers/Microsoft.OperationalInsights/workspaces/{ws}"
        f"/providers/Microsoft.SecurityInsights/incidents"
        f"?api-version=2024-03-01&$top=50&$orderby=properties/lastModifiedTimeUtc desc"
    )
    r = _requests.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=30)
    if r.status_code >= 400:
        raise RuntimeError(f"ARM returned {r.status_code}: {r.text[:1000]}")

    data = r.json()
    incidents: list[dict[str, Any]] = []
    for item in (data.get("value") or []):
        props = item.get("properties") or {}
        owner = props.get("owner") or {}
        owner_display = (
            (owner.get("assignedTo") if isinstance(owner, dict) else None)
            or (owner.get("email") if isinstance(owner, dict) else None)
            or (owner.get("userPrincipalName") if isinstance(owner, dict) else None)
            or ""
        )
        sentinel_status = props.get("status")
        number = props.get("incidentNumber")
        phase = _get_phase(number)
        incidents.append({
            "id": item.get("name"),
            "arm_id": item.get("id"),
            "number": number,
            "title": props.get("title"),
            "severity": props.get("severity"),
            "status": sentinel_status,
            # View-level state combining Sentinel.status + our phase
            # tracking. Used by the dashboard table to show one of:
            # "new" | "active-agentic" | "active-human" | "closed".
            "view_status": _view_status(sentinel_status, phase),
            "phase": phase,
            "owner": owner_display,
            "created": props.get("createdTimeUtc"),
            "last_modified": props.get("lastModifiedTimeUtc"),
        })
    return incidents


@app.get("/api/sentinel/incidents")
def list_sentinel_incidents(
    request: Request,
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

    _require_auth(request, x_pixelagents_token)

    now = time.time()
    cached = _INCIDENTS_CACHE.get("payload")
    if cached is not None and (now - float(_INCIDENTS_CACHE.get("ts") or 0)) < _INCIDENTS_CACHE_TTL_SEC:
        return cached

    try:
        incidents = _fetch_sentinel_incidents()
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    payload = {"incidents": incidents, "count": len(incidents), "ts": now}
    _INCIDENTS_CACHE["payload"] = payload
    _INCIDENTS_CACHE["ts"] = now
    return payload


class OrchestratorError(RuntimeError):
    """Raised by _orchestrate_one() when the upstream pipeline fails.

    Carries the orchestrator's HTTP status + parsed error body when
    available so the public API handler can re-raise as HTTPException
    with the same shape, and the auto-pickup loop can log it.
    """

    def __init__(self, message: str, *, status: int | None = None, body: Any = None):
        super().__init__(message)
        self.status = status
        self.body = body


async def _orchestrate_one(
    incident_number: int,
    mode: str,
    writeback: bool,
    *,
    trigger: str = "manual",
    triggering_user: str | None = None,
) -> dict[str, Any]:
    """Run the orchestrator for a specific incident.

    Sets CURRENT_INCIDENT for the duration of the call, appends a run
    record to WORKFLOW_RUNS, transitions the view-level phase between
    "agentic" (run in flight) and "human" (run completed or failed —
    handed back to the analyst), dispatches to the Orchestrator
    Function App, and returns its JSON response. Raises
    OrchestratorError on misconfiguration or upstream failure. Used by
    both the public /orchestrate endpoint and the auto-pickup loop.

    The `trigger` argument is recorded as the phase-transition reason
    (typically "manual" from the dashboard or "auto-pickup" from the
    background loop) — it doesn't affect orchestrator behavior.

    The reporter's permission to close the Sentinel incident is driven
    by AUTO_CLOSE["enabled"], which is forwarded as `auto_close` in the
    orchestrator request body. The orchestrator/reporter side must
    honor that flag.
    """

    orch_base = os.getenv("ORCHESTRATOR_URL", "")
    orch_key = os.getenv("ORCHESTRATOR_FUNCTION_KEY", "")
    if not orch_base or not orch_key:
        raise OrchestratorError(
            "Orchestrator not configured (ORCHESTRATOR_URL / ORCHESTRATOR_FUNCTION_KEY missing).",
        )

    import asyncio
    import requests as _requests

    auto_close_flag = bool(AUTO_CLOSE.get("enabled"))

    CURRENT_INCIDENT["incident_number"] = incident_number
    CURRENT_INCIDENT["started_at"] = time.time()
    # As soon as we kick off, the view phase is "agentic" — this drives
    # the dashboard pill to flip to "Active - Agentic Analysis" even
    # before the first phase event from the orchestrator arrives.
    _set_phase(incident_number, "agentic", reason=trigger)
    run_rec = _start_run(incident_number, mode)

    url = f"{orch_base.rstrip('/')}/incident/pipeline?code={orch_key}"
    try:
        r = await asyncio.to_thread(
            _requests.post,
            url,
            json={
                "incidentNumber": incident_number,
                "mode": mode,
                "writeback": bool(writeback),
                # Tell the reporter whether it's allowed to close the
                # Sentinel incident on its own. The orchestrator must
                # respect this — when False, every run hands back to
                # the human analyst regardless of reporter confidence.
                "auto_close": auto_close_flag,
                # Identity of the human who kicked off this run (None
                # for auto-pickup). The orchestrator uses this two
                # ways: (a) injects it into the reporter's user_text
                # so ask_human can target the same human; (b) on
                # handoff (success without close OR failure), assigns
                # the Sentinel incident's owner to this user instead
                # of leaving it on the last agent.
                "triggering_user": triggering_user or "",
            },
            timeout=600,
        )
    except Exception as e:
        CURRENT_INCIDENT["incident_number"] = None
        CURRENT_INCIDENT["started_at"] = None
        _set_phase(incident_number, "human", reason="failure")
        _end_run(run_rec, "failed", error=f"Orchestrator call failed: {e!r}")
        raise OrchestratorError(f"Orchestrator call failed: {e!r}") from e

    if r.status_code >= 400:
        CURRENT_INCIDENT["incident_number"] = None
        CURRENT_INCIDENT["started_at"] = None
        _set_phase(incident_number, "human", reason="failure")
        try:
            detail = r.json()
        except Exception:
            detail = r.text[:4000]
        err_text = json.dumps({"orchestrator_status": r.status_code, "body": detail})[:8000]
        _end_run(run_rec, "failed", error=err_text)
        raise OrchestratorError(err_text, status=r.status_code, body=detail)

    CURRENT_INCIDENT["incident_number"] = None
    CURRENT_INCIDENT["started_at"] = None
    try:
        result = r.json()
    except Exception:
        result = {"raw": r.text[:4000]}

    # On success, hand back to the human. If the reporter actually
    # closed the Sentinel incident (only possible when auto_close was
    # True), the next /api/sentinel/incidents poll will surface
    # status="Closed" and the view pill flips to "Closed" — phase is
    # ignored when Sentinel says Closed.
    _set_phase(incident_number, "human", reason="run-complete")

    # Invalidate the cached incidents list so the dashboard sees the
    # post-run Sentinel status (New→Active, or Active→Closed) without
    # waiting up to 10s for the cache TTL to expire.
    _INCIDENTS_CACHE["payload"] = None
    _INCIDENTS_CACHE["ts"] = 0.0

    summary = None
    try:
        if isinstance(result, dict):
            phases = result.get("phases") or {}
            if isinstance(phases, dict):
                done = [k for k, v in phases.items() if isinstance(v, dict) and v.get("status") == "ok"]
                if done:
                    summary = f"Completed: {', '.join(done)}"
    except Exception:
        pass
    _end_run(run_rec, "completed", summary=summary)
    return result


@app.post("/api/sentinel/incidents/{incident_number}/orchestrate")
async def orchestrate_incident(
    incident_number: int,
    req: Request,
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> dict[str, Any]:
    """Public orchestrate endpoint — auth + body parsing, delegates the
    actual run to _orchestrate_one()."""

    _require_auth(req, x_pixelagents_token)

    # Resolve the calling human's identity (if cookie auth). Token-only
    # callers — there shouldn't be any on this endpoint, but be
    # defensive — get None and the orchestrator treats the run like an
    # auto-pickup (no human attribution on handoff).
    triggering_user = _session_user(req)

    try:
        body = await req.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}

    mode = body.get("mode") or "full"
    writeback = body["writeback"] if "writeback" in body else True

    try:
        return await _orchestrate_one(
            incident_number,
            mode,
            bool(writeback),
            trigger="manual",
            triggering_user=triggering_user,
        )
    except OrchestratorError as e:
        if e.status is not None:
            raise HTTPException(
                status_code=502,
                detail={"orchestrator_status": e.status, "body": e.body},
            ) from e
        raise HTTPException(status_code=500, detail=str(e)) from e


# ── Inline owner / status edits from the dashboard ───────────────────
# These two endpoints power the click-to-edit cells in the incidents
# table. Both proxy through the runner's update_incident tool so the
# Gateway's MI does the actual ARM write — no need to thread an extra
# token through the browser. Auth: cookie session (so the user must
# be logged in; we record their identity for orchestrator handoff).


def _is_triage_assignment(value: str) -> bool:
    """Recognise a few human-friendly variants of "trigger triage"
    on an owner-edit. Lets the UI send 'Triage Agent', 'triage',
    'TRIAGE', or 'triage-agent' — they all mean the same thing here."""
    s = (value or "").strip().lower()
    return s in {"triage", "triage agent", "triage-agent", "triageagent"}


async def _trigger_triage_only(incident_number: int, triggering_user: str | None) -> dict[str, Any]:
    """Kick off a triage_only orchestrator run for the given incident.
    The orchestrator's _set_incident_status will move the incident
    from New → Active during the run, and its _assign_incident_owner
    will set owner.assignedTo to "Triage Agent" for the duration.
    No investigator / reporter / closure happens — just triage."""

    try:
        return await _orchestrate_one(
            incident_number,
            mode="triage_only",
            writeback=True,
            trigger="manual-triage",
            triggering_user=triggering_user,
        )
    except OrchestratorError as e:
        if e.status is not None:
            raise HTTPException(
                status_code=502,
                detail={"orchestrator_status": e.status, "body": e.body},
            ) from e
        raise HTTPException(status_code=500, detail=str(e)) from e


async def _orchestrator_set_owner_or_status(
    incident_number: int,
    *,
    owner: str | None = None,
    status: str | None = None,
) -> dict[str, Any]:
    """Proxy through the orchestrator's /incident/assign route to do
    a plain owner / status writeback on a Sentinel incident — no
    workflow, just the ARM update via the runner's update_incident.

    pixelagents_web doesn't have its own runner credentials in
    Terraform today; the orchestrator does (it pulls the bearer from
    Key Vault). Routing through it is one less env var to wire."""

    orch_base = os.getenv("ORCHESTRATOR_URL", "").strip()
    orch_key = os.getenv("ORCHESTRATOR_FUNCTION_KEY", "").strip()
    if not orch_base or not orch_key:
        raise HTTPException(
            status_code=500,
            detail="Orchestrator not configured (ORCHESTRATOR_URL / ORCHESTRATOR_FUNCTION_KEY missing)",
        )

    payload: dict[str, Any] = {"incidentNumber": incident_number}
    if owner is not None:
        payload["owner"] = owner
    if status is not None:
        payload["status"] = status

    import asyncio
    import requests as _requests

    url = f"{orch_base.rstrip('/')}/incident/assign?code={orch_key}"
    try:
        r = await asyncio.to_thread(
            _requests.post,
            url,
            json=payload,
            timeout=30,
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Orchestrator call failed: {e!r}") from e

    if r.status_code >= 400:
        try:
            body = r.json()
        except Exception:
            body = r.text[:1000]
        raise HTTPException(
            status_code=502,
            detail={"orchestrator_status": r.status_code, "body": body},
        )

    # Bust the incidents cache so the dashboard sees the change on
    # the next poll without waiting up to 10s for the cache TTL.
    _INCIDENTS_CACHE["payload"] = None
    _INCIDENTS_CACHE["ts"] = 0.0

    try:
        return r.json()
    except Exception:
        return {}


@app.post("/api/sentinel/incidents/{incident_number}/owner")
async def api_incident_set_owner(
    incident_number: int,
    req: Request,
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> dict[str, Any]:
    """Reassign an incident's owner. Body: {"owner": "<value>"}.

    Two paths depending on the value:
      - "Triage Agent" / "triage" (case-insensitive) — kicks off a
        triage-only orchestrator run. The orchestrator's existing
        per-phase owner-assignment will set the owner to "Triage
        Agent" during the run; the run only does triage (no
        investigator / reporter / close).
      - Anything else (typically an email) — written verbatim to
        Sentinel's owner.assignedTo via the runner. No workflow.

    To avoid creating bogus owners, we only accept either the special
    triage value or an email that's in the configured user roster.
    """

    _require_auth(req, x_pixelagents_token)
    triggering_user = _session_user(req)

    try:
        body = await req.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}

    owner = body.get("owner")
    if not isinstance(owner, str) or not owner.strip():
        raise HTTPException(status_code=400, detail="Missing 'owner' (string)")
    owner = owner.strip()

    if _is_triage_assignment(owner):
        # Triage path — fire the workflow.
        result = await _trigger_triage_only(incident_number, triggering_user)
        return {
            "ok": True,
            "action": "triage-triggered",
            "incident_number": incident_number,
            "orchestrator_result": result,
        }

    # Human path — must be a configured user.
    if owner.lower() not in {e.lower() for e in USERS.keys()}:
        raise HTTPException(
            status_code=400,
            detail=f"Owner '{owner}' is not in the configured user roster",
        )

    await _orchestrator_set_owner_or_status(incident_number, owner=owner)
    return {
        "ok": True,
        "action": "owner-set",
        "incident_number": incident_number,
        "owner": owner,
    }


@app.post("/api/sentinel/incidents/{incident_number}/status")
async def api_incident_set_status(
    incident_number: int,
    req: Request,
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> dict[str, Any]:
    """Set an incident's Sentinel status. Body: {"status": "New" | "Active"}.

    Setting "New" forces a fresh triage workflow (the orchestrator
    will move it back to Active during the run; this is by design —
    the user picks "New" to mean "re-triage this"). Setting "Active"
    just writes the status. Setting "Closed" is intentionally
    rejected — closure must happen in Sentinel itself.
    """

    _require_auth(req, x_pixelagents_token)
    triggering_user = _session_user(req)

    try:
        body = await req.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        body = {}

    status = body.get("status")
    if not isinstance(status, str) or not status.strip():
        raise HTTPException(status_code=400, detail="Missing 'status' (string)")
    status = status.strip().capitalize()  # "new" -> "New"

    if status == "Closed":
        raise HTTPException(
            status_code=400,
            detail="Closing an incident must happen in Microsoft Sentinel",
        )

    if status not in {"New", "Active"}:
        raise HTTPException(
            status_code=400,
            detail=f"Status '{status}' not supported (allowed: New, Active)",
        )

    if status == "New":
        # Trigger a fresh triage. The run moves the status to Active
        # as it kicks off — that's expected behaviour, the user's
        # intent was "re-triage this" rather than "literally store
        # 'New' in Sentinel."
        result = await _trigger_triage_only(incident_number, triggering_user)
        return {
            "ok": True,
            "action": "re-triage-triggered",
            "incident_number": incident_number,
            "orchestrator_result": result,
        }

    # status == "Active" — just write the status, no workflow.
    await _orchestrator_set_owner_or_status(incident_number, status=status)
    return {
        "ok": True,
        "action": "status-set",
        "incident_number": incident_number,
        "status": status,
    }


# ─── Cost tracking ────────────────────────────────────────────────────────


@app.post("/api/cost/record")
async def record_cost(
    req: Request,
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> dict[str, Any]:
    """Accept a per-call cost record from the orchestrator (or any other
    server-side component). Records are aggregated in-memory by incident.

    Body:
      {
        "incident_number": int | null,
        "incident_id": str | null,
        "agent": str,
        "phase": str,
        "input_tokens": int,
        "output_tokens": int,
        "eur_cost": float,
        "workflow_run_id": str | null,
        "ts": float (unix seconds),
      }
    """

    _require_token(x_pixelagents_token)

    try:
        body = await req.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    input_tokens = int(body.get("input_tokens") or 0)
    output_tokens = int(body.get("output_tokens") or 0)
    eur = float(body.get("eur_cost") or 0.0)
    if input_tokens == 0 and output_tokens == 0 and eur == 0.0:
        # Empty record — accept but don't bother storing.
        return {"ok": True, "stored": False}

    incident_number = body.get("incident_number")
    key = str(incident_number) if incident_number is not None else "unattributed"
    bucket = _cost_bucket(key)
    bucket["total_eur"] += eur
    bucket["total_input_tokens"] += input_tokens
    bucket["total_output_tokens"] += output_tokens
    record = {
        "agent": body.get("agent"),
        "phase": body.get("phase"),
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "eur_cost": eur,
        "workflow_run_id": body.get("workflow_run_id"),
        "ts": float(body.get("ts") or time.time()),
    }
    bucket["records"].append(record)
    if len(bucket["records"]) > _COST_RECORDS_CAP:
        bucket["records"] = bucket["records"][-_COST_RECORDS_CAP:]
    return {"ok": True, "stored": True, "bucket": key}


@app.get("/api/sentinel/incidents/{incident_number}/cost")
def get_incident_cost(
    incident_number: int,
    request: Request,
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> dict[str, Any]:
    """Per-incident cost summary for the incidents panel."""

    _require_auth(request, x_pixelagents_token)
    bucket = COSTS.get(str(incident_number)) or {
        "total_eur": 0.0,
        "total_input_tokens": 0,
        "total_output_tokens": 0,
        "records": [],
    }
    return {
        "incident_number": incident_number,
        "total_eur": round(bucket["total_eur"], 6),
        "total_input_tokens": bucket["total_input_tokens"],
        "total_output_tokens": bucket["total_output_tokens"],
        "record_count": len(bucket["records"]),
    }


@app.get("/api/sentinel/incidents/costs")
def get_all_incident_costs(
    request: Request,
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> dict[str, Any]:
    """Aggregate cost map so the incidents panel can render a Cost column
    in a single poll rather than N per-incident requests."""

    _require_auth(request, x_pixelagents_token)
    out: dict[str, Any] = {}
    for key, bucket in COSTS.items():
        if not key.isdigit():
            continue  # skip "chat" / "unattributed" buckets — UI is per-incident
        records = bucket.get("records") or []
        last = records[-1] if records else None
        out[key] = {
            "total_eur": round(bucket["total_eur"], 6),
            "total_input_tokens": bucket["total_input_tokens"],
            "total_output_tokens": bucket["total_output_tokens"],
            # The most-recent cost record carries the phase + agent the
            # orchestrator was on when it last reported. Useful for the
            # dashboard's "currently running phase X" indicator.
            "last_phase":     (last or {}).get("phase"),
            "last_agent":     (last or {}).get("agent"),
            "last_update_ts": (last or {}).get("ts"),
        }
    return {"costs": out, "ts": time.time()}


# ─── Human-in-the-loop (HITL) ────────────────────────────────────────────
#
# The runner exposes an `ask_human` tool that agents can call when they
# need clarification. When invoked, the runner POSTs the question to
# /api/hitl/questions below, gets back a UUID, and long-polls
# /api/hitl/wait/{id} until a human answers (or a short timeout). The UI
# reads /api/hitl/pending and submits via /api/hitl/answer/{id}.
#
# Auto-routing: when a question arrives without an explicit target
# (typically auto-pickup runs where no specific human kicked off the
# workflow), we route it to an "available" human — online AND not
# currently the owner of any non-Closed Sentinel incident. If the pool
# is empty, the question is appended to HITL_QUEUE and drained as
# humans become available.

# Ordered list of question ids waiting for an available human. Drained
# by the background _hitl_queue_drain_loop on a 5s tick.
HITL_QUEUE: list[str] = []
_HITL_QUEUE_DRAIN_INTERVAL_SEC = 5.0


def _hitl_busy_users() -> set[str]:
    """Configured users who currently own at least one non-Closed
    Sentinel incident. Source: the cached incidents listing the
    dashboard already keeps fresh — we don't add another ARM call.
    Owner string matching is case-insensitive against USERS keys, so
    Sentinel storing the email in mixed case doesn't break the
    lookup."""
    busy: set[str] = set()
    cached = _INCIDENTS_CACHE.get("payload")
    if not isinstance(cached, dict):
        return busy
    user_emails = {e.lower() for e in USERS.keys()}
    for inc in (cached.get("incidents") or []):
        sentinel_status = (inc.get("status") or "").strip().lower()
        if sentinel_status == "closed":
            continue
        owner = (inc.get("owner") or "").strip().lower()
        if owner in user_emails:
            busy.add(owner)
    return busy


def _hitl_online_users() -> set[str]:
    """Configured users with last_seen inside ONLINE_WINDOW_SEC."""
    now = time.time()
    cfg = {e.lower() for e in USERS.keys()}
    return {
        email for email, last_seen in PRESENCE.items()
        if email in cfg and (now - last_seen) <= ONLINE_WINDOW_SEC
    }


def _hitl_pick_available() -> str | None:
    """Pick one available human (online AND not busy). Sorted alpha
    so the choice is deterministic across calls — fairness can be
    refined later (e.g., least-recently-routed) but for the demo
    deterministic > random."""
    pool = sorted(_hitl_online_users() - _hitl_busy_users())
    return pool[0] if pool else None


def _hitl_route_or_queue(qid: str) -> None:
    """Try to assign the question to an available human; queue if
    nobody fits the bill right now. Mutates HITL_QUESTIONS[qid] to
    record the routing decision."""
    rec = HITL_QUESTIONS.get(qid)
    if rec is None:
        return
    target = _hitl_pick_available()
    if target:
        rec["target"] = target
        rec["routed_at"] = time.time()
        rec["routed_method"] = "auto"
        print(
            f"[hitl] auto-routed qid={qid} -> {target}",
            flush=True,
        )
        return
    HITL_QUEUE.append(qid)
    rec["routed_method"] = "queued"
    print(
        f"[hitl] queued qid={qid} (no available humans; queue size={len(HITL_QUEUE)})",
        flush=True,
    )


async def _hitl_queue_drain_tick() -> None:
    """Pop entries from HITL_QUEUE and assign them to available
    humans. Each available human gets at most one question per tick
    so we don't pile six questions on one analyst the second they
    come online."""
    if not HITL_QUEUE:
        return
    available = sorted(_hitl_online_users() - _hitl_busy_users())
    if not available:
        return

    drained: list[tuple[str, str]] = []
    keep: list[str] = []
    while HITL_QUEUE:
        qid = HITL_QUEUE.pop(0)
        rec = HITL_QUESTIONS.get(qid)
        if rec is None:
            continue  # vanished — drop from queue silently
        if rec.get("status") != "pending":
            # Question was answered or cancelled while it sat in the
            # queue — drop it.
            continue
        if not available:
            # Out of available humans this tick — re-queue this and
            # any remaining ids for the next pass.
            keep.append(qid)
            continue
        target = available.pop(0)
        rec["target"] = target
        rec["routed_at"] = time.time()
        rec["routed_method"] = "auto-drain"
        drained.append((qid, target))
    # Re-queue anything we couldn't place this tick (preserves order).
    HITL_QUEUE[:0] = keep
    for qid, t in drained:
        print(f"[hitl] drained queue: qid={qid} -> {t}", flush=True)


async def _hitl_queue_drain_loop() -> None:
    import asyncio

    while True:
        try:
            await _hitl_queue_drain_tick()
        except Exception as e:
            print(f"[hitl] drain loop error: {e!r}", flush=True)
        await asyncio.sleep(_HITL_QUEUE_DRAIN_INTERVAL_SEC)


@app.on_event("startup")
async def _start_hitl_queue_drain() -> None:
    import asyncio

    asyncio.create_task(_hitl_queue_drain_loop())


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
        # Empty string / None = broadcast (anyone with the HITL panel
        # open sees it). A specific email = targeted question; only
        # that user sees it in /api/hitl/pending.
        "target": q.get("target") or "",
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

    # Optional targeting — when set to a specific email, only that
    # user sees the question in their HITL panel. Unset / empty =
    # broadcast (anyone with the panel open sees it; current behavior).
    target = body.get("target")
    if isinstance(target, str):
        target = target.strip().lower()
    else:
        target = ""

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
        "target": target,
        "routed_method": ("explicit-target" if target else None),
    }
    HITL_QUESTIONS[qid] = record

    # If the agent didn't pick a specific human (auto-pickup runs),
    # route to the first available analyst — online AND not currently
    # the owner of any non-Closed Sentinel incident. If none fit, the
    # question lands in HITL_QUEUE and gets assigned by the drain
    # loop as humans free up.
    if not target:
        _hitl_route_or_queue(qid)

    return _hitl_public(record)


@app.get("/api/hitl/pending")
def hitl_list_pending(
    request: Request,
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> dict[str, Any]:
    """UI reads this to show currently-pending questions.

    Filters by `target`: questions with no target (broadcast) are
    visible to everyone; questions with a target are only visible to
    that specific user. Token-only callers (no session cookie) only
    see broadcast questions — they have no identity to match against.
    """

    _require_auth(request, x_pixelagents_token)
    me = (_session_user(request) or "").strip().lower()

    def _visible(q: dict[str, Any]) -> bool:
        if q.get("status") != "pending":
            return False
        target = (q.get("target") or "").strip().lower()
        if not target:
            return True  # broadcast
        return target == me

    pending = [_hitl_public(q) for q in HITL_QUESTIONS.values() if _visible(q)]
    pending.sort(key=lambda q: q.get("asked_at") or 0)
    return {"questions": pending, "ts": time.time()}


@app.post("/api/hitl/answer/{qid}")
async def hitl_submit_answer(
    qid: str,
    req: Request,
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> dict[str, Any]:
    """UI submits a human answer for a given question id."""

    _require_auth(req, x_pixelagents_token)

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


# ── Pending changes (Knowledge agent + future detection-engineer) ────


def _change_public(c: dict[str, Any]) -> dict[str, Any]:
    """Strip nothing for now — we WANT the analyst to see all the
    fields so they can read the rationale, current snapshot, and
    proposed content side-by-side."""
    out = dict(c)
    return out


def _split_common_from_full(full_instructions: str, common_text: str) -> str:
    """Given an agent's full instructions blob (common + role tail)
    and the existing common text, return just the role tail. Falls
    back to the full string if the prefix doesn't match — better to
    keep the agent's role intact on a near-miss than wipe it."""
    if common_text and full_instructions.startswith(common_text):
        return full_instructions[len(common_text):].lstrip("\n")
    return full_instructions


def _apply_agent_instructions_change(record: dict[str, Any]) -> dict[str, Any]:
    """Update one specific agent's role-specific tail. The Foundry
    agent's full instructions are common-preamble + role-tail; we
    fetch the current preamble + the new tail and write the
    combined blob via the existing _foundry_post_new_version helper.
    """
    target = (record.get("target") or "").strip()
    new_role_tail = record.get("proposed") or ""
    if not target:
        raise HTTPException(status_code=400, detail="agent-instructions change has no target")
    if not isinstance(new_role_tail, str) or not new_role_tail.strip():
        raise HTTPException(status_code=400, detail="agent-instructions 'proposed' is empty")

    rich = _fetch_foundry_agent_instructions()
    full_by_slug = {s: (r.get("instructions") or "") for s, r in rich.items()}
    common, _ = _split_common_and_role(full_by_slug)

    new_full = f"{common}\n\n{new_role_tail}" if common else new_role_tail
    try:
        _foundry_post_new_version(target, new_full)
        return {target: "ok"}
    except HTTPException as e:
        return {target: f"failed: {e.detail!s}"[:300]}
    except Exception as e:
        return {target: f"failed: {e!r}"[:300]}


def _apply_detection_rule_change(record: dict[str, Any]) -> dict[str, Any]:
    """Create a Sentinel analytic rule via the orchestrator's new
    /sentinel/create-rule route. Same pattern owner/status edits use
    — pixelagents_web doesn't have its own runner credentials, so we
    proxy through the orchestrator (which already has them in KV)."""
    proposed = record.get("proposed") or {}
    if not isinstance(proposed, dict):
        raise HTTPException(status_code=400, detail="detection-rule proposed is not a dict")

    orch_base = os.getenv("ORCHESTRATOR_URL", "").strip()
    orch_key = os.getenv("ORCHESTRATOR_FUNCTION_KEY", "").strip()
    if not orch_base or not orch_key:
        raise HTTPException(
            status_code=500,
            detail="Orchestrator not configured (ORCHESTRATOR_URL / ORCHESTRATOR_FUNCTION_KEY missing)",
        )

    import requests as _requests

    url = f"{orch_base.rstrip('/')}/sentinel/create-rule?code={orch_key}"
    try:
        r = _requests.post(url, json=proposed, timeout=60)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"create_rule call failed: {e!r}") from e
    if r.status_code >= 400:
        try:
            body = r.json()
        except Exception:
            body = r.text[:1000]
        raise HTTPException(
            status_code=502,
            detail={"orchestrator_status": r.status_code, "body": body},
        )

    try:
        body = r.json()
    except Exception:
        body = {"raw": r.text[:1000]}

    rule_id = (
        (body.get("runner_result") or {}).get("ruleId")
        or proposed.get("displayName")
        or "(unknown)"
    )
    return {str(rule_id): "ok"}


def _apply_knowledge_preamble_change(record: dict[str, Any]) -> dict[str, Any]:
    """Fan out the new common preamble to every roster agent on
    Foundry. Each agent's new instructions = new_common + "\n\n" +
    that agent's existing role tail. Reuses the read path
    (_fetch_foundry_agent_instructions / _split_common_and_role) and
    the write helper (_foundry_post_new_version) we already have.

    Returns a per-agent outcome dict: {agent_slug: "ok" | error_str}.
    Raises only on configuration-level failures; per-agent failures
    are recorded and the function still returns (so the analyst sees
    'X of N succeeded')."""

    new_common = (record.get("proposed") or "").strip()
    if not new_common:
        raise HTTPException(status_code=400, detail="Proposed preamble is empty")

    rich = _fetch_foundry_agent_instructions()
    full_by_slug = {slug: (r.get("instructions") or "") for slug, r in rich.items()}
    current_common, role_tails = _split_common_and_role(full_by_slug)

    out: dict[str, str] = {}
    for slug in _default_agent_roster():
        if slug == "soc-manager":
            # SOC Manager doesn't need the common preamble baked
            # into its own instructions — its role IS preamble +
            # role-tail curation. Skip to avoid recursive updates.
            out[slug] = "skipped (soc-manager)"
            continue
        role_tail = role_tails.get(slug) or ""
        new_full = f"{new_common}\n\n{role_tail}" if role_tail else new_common
        try:
            _foundry_post_new_version(slug, new_full)
            out[slug] = "ok"
        except HTTPException as e:
            out[slug] = f"failed: {e.detail!s}"[:300]
        except Exception as e:
            out[slug] = f"failed: {e!r}"[:300]
    return out


@app.post("/api/changes")
async def api_changes_create(
    req: Request,
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> dict[str, Any]:
    """Called by the runner when an agent proposes a change. Body:
        {
          "agent": str,            # who's proposing (slug)
          "kind": str,             # "knowledge-preamble" (only kind in v1)
          "title": str | None,
          "rationale": str,
          "proposed": str,         # the new content, in full
        }
    Server fetches the current state (so the queue can show a diff)
    and stores the record in pending state."""

    _require_token(x_pixelagents_token)

    import uuid as _uuid

    try:
        body = await req.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Invalid JSON body")

    agent = _slug_agent(str(body.get("agent") or "unknown"))
    kind = (body.get("kind") or "").strip()
    target = (body.get("target") or "").strip()
    title = (body.get("title") or "").strip()
    rationale = (body.get("rationale") or "").strip()
    proposed = body.get("proposed")

    if kind not in ("knowledge-preamble", "agent-instructions", "detection-rule"):
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported change kind: {kind!r}",
        )
    if proposed is None:
        raise HTTPException(status_code=400, detail="Missing 'proposed'")
    if isinstance(proposed, str) and not proposed.strip():
        raise HTTPException(status_code=400, detail="'proposed' is empty")
    if not rationale:
        raise HTTPException(status_code=400, detail="Missing 'rationale' (string)")

    # Per-kind validation + current-state snapshot for the diff view.
    current_snapshot: Any = ""
    proposed_normalized: Any = proposed

    if kind == "knowledge-preamble":
        if not isinstance(proposed, str):
            raise HTTPException(status_code=400, detail="'proposed' must be a string for knowledge-preamble")
        try:
            rich = _fetch_foundry_agent_instructions()
            full_by_slug = {s: (r.get("instructions") or "") for s, r in rich.items()}
            current_snapshot, _ = _split_common_and_role(full_by_slug)
        except Exception as e:
            current_snapshot = f"(could not read current preamble: {e!r})"

    elif kind == "agent-instructions":
        if not isinstance(proposed, str):
            raise HTTPException(status_code=400, detail="'proposed' must be a string for agent-instructions")
        # Target must be a configured agent (and not the SOC Manager
        # itself — soc-manager.md is operator-managed, not agent-
        # editable).
        if not target:
            raise HTTPException(status_code=400, detail="Missing 'target' (agent slug) for agent-instructions")
        if target == "soc-manager":
            raise HTTPException(
                status_code=400,
                detail="The SOC Manager's instructions are operator-managed; not agent-editable.",
            )
        if target not in set(_default_agent_roster()):
            raise HTTPException(
                status_code=400,
                detail=f"Target agent {target!r} is not in the configured roster",
            )
        try:
            rich = _fetch_foundry_agent_instructions()
            full_by_slug = {s: (r.get("instructions") or "") for s, r in rich.items()}
            _, role_tails = _split_common_and_role(full_by_slug)
            current_snapshot = role_tails.get(target, "")
        except Exception as e:
            current_snapshot = f"(could not read current role tail: {e!r})"

    elif kind == "detection-rule":
        # `proposed` is the full rule definition. Accept either a
        # JSON object (preferred — typed) or a JSON-formatted string
        # (when the agent stringified it). Normalise to dict for
        # storage; we'll re-serialise on apply.
        if isinstance(proposed, str):
            try:
                proposed_normalized = json.loads(proposed)
            except Exception as e:
                raise HTTPException(
                    status_code=400,
                    detail=f"detection-rule 'proposed' string is not valid JSON: {e!s}",
                )
        elif isinstance(proposed, dict):
            proposed_normalized = proposed
        else:
            raise HTTPException(
                status_code=400,
                detail="'proposed' must be a JSON object (or JSON string) for detection-rule",
            )
        if not isinstance(proposed_normalized.get("displayName"), str) \
           or not isinstance(proposed_normalized.get("query"), str):
            raise HTTPException(
                status_code=400,
                detail="detection-rule must include displayName and query (KQL)",
            )
        # New rules don't have a "current" — they're net-new.
        current_snapshot = ""
        if not target:
            target = proposed_normalized.get("displayName") or ""

    cid = str(_uuid.uuid4())
    record = {
        "id": cid,
        "kind": kind,
        "target": target,
        "proposed_by": agent,
        "proposed_at": time.time(),
        "title": title or "(untitled change)",
        "rationale": rationale,
        "current": current_snapshot,
        "proposed": proposed_normalized,
        "status": "pending",
        "reviewer": None,
        "reviewed_at": None,
        "review_note": "",
        "applied_at": None,
        "applied_result": None,
        "apply_error": None,
    }
    CHANGES[cid] = record

    # Trim oldest if we're over the cap. Keep pending ones regardless
    # of age — we don't want to drop something a human still owes a
    # decision on.
    if len(CHANGES) > CHANGES_CAP:
        ordered = sorted(CHANGES.items(), key=lambda kv: kv[1].get("proposed_at") or 0)
        for k, v in ordered:
            if len(CHANGES) <= CHANGES_CAP:
                break
            if v.get("status") != "pending":
                CHANGES.pop(k, None)

    print(
        f"[changes] proposed kind={kind} by={agent} id={cid} "
        f"title={title!r}",
        flush=True,
    )
    return _change_public(record)


@app.get("/api/changes/pending")
def api_changes_pending(
    request: Request,
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> dict[str, Any]:
    """List pending changes. Broadcast for now — every logged-in
    human sees them; the first to approve / reject wins."""

    _require_auth(request, x_pixelagents_token)
    pending = [
        _change_public(c) for c in CHANGES.values() if c.get("status") == "pending"
    ]
    pending.sort(key=lambda c: c.get("proposed_at") or 0)
    return {"changes": pending, "ts": time.time()}


@app.get("/api/changes/{change_id}")
def api_changes_get(
    change_id: str,
    request: Request,
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> dict[str, Any]:
    _require_auth(request, x_pixelagents_token)
    c = CHANGES.get(change_id)
    if not c:
        raise HTTPException(status_code=404, detail="Unknown change id")
    return _change_public(c)


@app.post("/api/changes/{change_id}/approve")
async def api_changes_approve(
    change_id: str,
    req: Request,
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> dict[str, Any]:
    """Approve a pending change AND apply it. Apply outcome lives on
    the record so the queue can show 'Applied to N of M agents' / a
    failure cause if it didn't fully take."""

    _require_auth(req, x_pixelagents_token)
    me = _session_user(req) or ""

    try:
        body = await req.json()
    except Exception:
        body = {}
    note = ""
    if isinstance(body, dict):
        n = body.get("note")
        if isinstance(n, str):
            note = n.strip()

    record = CHANGES.get(change_id)
    if not record:
        raise HTTPException(status_code=404, detail="Unknown change id")
    if record.get("status") != "pending":
        raise HTTPException(
            status_code=409,
            detail=f"Change is no longer pending (status={record.get('status')!r})",
        )

    # Mark approved BEFORE applying so a concurrent approve from
    # another tab races to no-op rather than fanning out twice.
    record["status"] = "approved"
    record["reviewer"] = me
    record["reviewed_at"] = time.time()
    record["review_note"] = note

    try:
        import asyncio as _asyncio
        if record["kind"] == "knowledge-preamble":
            applied = await _asyncio.to_thread(_apply_knowledge_preamble_change, record)
        elif record["kind"] == "agent-instructions":
            applied = await _asyncio.to_thread(_apply_agent_instructions_change, record)
        elif record["kind"] == "detection-rule":
            applied = await _asyncio.to_thread(_apply_detection_rule_change, record)
        else:
            applied = {"_error": f"unsupported kind: {record['kind']}"}
        record["applied_at"] = time.time()
        record["applied_result"] = applied
        any_failed = any(str(v).startswith("failed") for v in applied.values())
        record["status"] = "failed" if any_failed else "applied"
    except HTTPException as e:
        record["status"] = "failed"
        record["apply_error"] = str(e.detail)[:1000]
    except Exception as e:
        record["status"] = "failed"
        record["apply_error"] = f"{type(e).__name__}: {e!r}"[:1000]

    print(
        f"[changes] {record['status']} change_id={change_id} kind={record['kind']} "
        f"reviewer={me!r}",
        flush=True,
    )
    return _change_public(record)


@app.post("/api/changes/{change_id}/reject")
async def api_changes_reject(
    change_id: str,
    req: Request,
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> dict[str, Any]:
    _require_auth(req, x_pixelagents_token)
    me = _session_user(req) or ""

    try:
        body = await req.json()
    except Exception:
        body = {}
    note = ""
    if isinstance(body, dict):
        n = body.get("note")
        if isinstance(n, str):
            note = n.strip()

    record = CHANGES.get(change_id)
    if not record:
        raise HTTPException(status_code=404, detail="Unknown change id")
    if record.get("status") != "pending":
        raise HTTPException(
            status_code=409,
            detail=f"Change is no longer pending (status={record.get('status')!r})",
        )

    record["status"] = "rejected"
    record["reviewer"] = me
    record["reviewed_at"] = time.time()
    record["review_note"] = note
    print(
        f"[changes] rejected change_id={change_id} kind={record['kind']} "
        f"reviewer={me!r}",
        flush=True,
    )
    return _change_public(record)


# ── Conversation persistence helpers ─────────────────────────────────


def _conv_user_key(req: Request) -> str:
    """Stable owner identity for keying CONVERSATIONS. Uses session
    email when available, falls back to a generic anon bucket."""
    user = _session_user(req)
    return user or "_anon"


def _conv_append(user: str, agent: str, msg: Dict[str, Any]) -> Dict[str, Any]:
    """Append a message record and trim the bucket to CONVERSATIONS_CAP."""
    bucket = CONVERSATIONS[user][agent]
    bucket.append(msg)
    if len(bucket) > CONVERSATIONS_CAP:
        del bucket[: len(bucket) - CONVERSATIONS_CAP]
    return msg


def _conv_find(user: str, agent: str, message_id: str) -> Dict[str, Any] | None:
    """Locate a message record by id within a bucket."""
    for m in CONVERSATIONS.get(user, {}).get(agent, []):
        if m.get("id") == message_id:
            return m
    return None


def _run_chat_blocking(
    user: str,
    agent_name: str,
    message_id: str,
    message_text: str,
    project_endpoint: str,
    token: str,
) -> None:
    """Synchronously run the Foundry SSE chat call and accumulate the
    response into the message record identified by message_id.

    Designed to run in a threadpool via asyncio.to_thread so it survives
    client disconnection: the request handler that started us can be
    cancelled (e.g. browser navigation kills the SSE connection) and we
    keep going regardless. The follow_generator below tails the same
    record to surface the streaming view to whoever's connected at the
    time.
    """

    msg = _conv_find(user, agent_name, message_id)
    if msg is None:
        return  # gone before we got here (capped out)

    import requests as _requests

    url = project_endpoint.rstrip("/") + "/openai/v1/responses"
    payload = {
        "input": message_text,
        "agent_reference": {"name": agent_name, "type": "agent_reference"},
        "stream": True,
    }

    upstream = None
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
        msg["status"] = "failed"
        msg["error"] = f"connection failed: {e!r}"
        msg["ended_at"] = time.time()
        return

    try:
        if upstream.status_code >= 400:
            try:
                detail = upstream.json()
            except Exception:
                detail = upstream.text[:4000]
            msg["status"] = "failed"
            msg["error"] = json.dumps({"status": upstream.status_code, "body": detail})[:8000]
            msg["ended_at"] = time.time()
            return

        current_event: str | None = None
        data_lines: list[str] = []
        total_text_emitted = 0

        def _text_from_message_item(item: dict) -> str:
            parts: list[str] = []
            content = item.get("content") or []
            if isinstance(content, list):
                for block in content:
                    if isinstance(block, dict) and isinstance(block.get("text"), str):
                        parts.append(block["text"])
            return "".join(parts)

        for line in upstream.iter_lines(decode_unicode=True):
            if line is None:
                continue
            if line == "":
                if current_event and data_lines:
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
                            msg["text"] = (msg.get("text") or "") + delta

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
                                tools = msg.setdefault("tool_calls", [])
                                tools.append(entry)
                        elif item_type == "message":
                            # Some agents emit messages as a single completed
                            # item rather than per-token deltas — fall back
                            # to the full text when no deltas were seen.
                            if total_text_emitted == 0:
                                txt = _text_from_message_item(item)
                                if txt:
                                    total_text_emitted += len(txt)
                                    msg["text"] = (msg.get("text") or "") + txt

                    elif (
                        current_event == "response.completed"
                        and isinstance(ev_data, dict)
                    ):
                        response = ev_data.get("response") or {}
                        usage = response.get("usage") if isinstance(response, dict) else None
                        if usage:
                            try:
                                _record_usage_locally(
                                    incident_key="chat",
                                    agent=agent_name,
                                    phase="chat-stream",
                                    usage=usage,
                                )
                            except Exception:
                                pass
                        if total_text_emitted == 0:
                            output = response.get("output") or []
                            if isinstance(output, list):
                                collected = "".join(
                                    _text_from_message_item(it)
                                    for it in output
                                    if isinstance(it, dict) and it.get("type") == "message"
                                )
                                if collected:
                                    total_text_emitted += len(collected)
                                    msg["text"] = (msg.get("text") or "") + collected

                    elif current_event in ("response.failed", "response.incomplete"):
                        resp = (
                            ev_data.get("response")
                            if isinstance(ev_data, dict)
                            else None
                        ) or {}
                        err = resp.get("error") if isinstance(resp, dict) else None
                        msg["status"] = "failed"
                        msg["error"] = json.dumps(err or resp or ev_data or {"reason": current_event})[:4000]
                        msg["ended_at"] = time.time()
                        return

                    elif current_event == "error" and isinstance(ev_data, dict):
                        msg["status"] = "failed"
                        msg["error"] = json.dumps(ev_data)[:4000]
                        msg["ended_at"] = time.time()
                        return

                current_event = None
                data_lines = []
            elif line.startswith(":"):
                continue
            elif line.startswith("event:"):
                current_event = line[len("event:"):].strip()
            elif line.startswith("data:"):
                chunk = line[len("data:"):]
                if chunk.startswith(" "):
                    chunk = chunk[1:]
                data_lines.append(chunk)

        # Stream ended cleanly. Mark completed if not already failed.
        if msg.get("status") == "streaming":
            msg["status"] = "completed"
            msg["ended_at"] = time.time()

    except Exception as e:
        msg["status"] = "failed"
        msg["error"] = f"stream error: {e!r}"
        msg["ended_at"] = time.time()
    finally:
        if upstream is not None:
            try:
                upstream.close()
            except Exception:
                pass
        try:
            _emit_agent_end(agent_name, "adhoc_chat")
        except Exception:
            pass


# ── Online presence + DMs ────────────────────────────────────────────


def _require_real_user(request: Request) -> str:
    """Variant of _require_auth that demands a cookie-backed identity
    (token-only callers can't participate in DMs / presence)."""
    user = _session_user(request)
    if user is None:
        raise HTTPException(
            status_code=401,
            detail="DM / presence endpoints require a logged-in browser session",
        )
    _bump_presence(user)
    return user


@app.get("/api/sessions/online")
def api_sessions_online(
    request: Request,
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> Dict[str, Any]:
    """Return every CONFIGURED human (from the AISOC_USERS_JSON roster
    / USERS dict) with their current online status. The caller's own
    email is NOT in the list — UI uses `me` separately.

    Each user record:
      {
        "email":     str,
        "online":    bool,           # last_seen within ONLINE_WINDOW_SEC
        "last_seen": float | None,   # unix sec, or None if never seen
        "ago_sec":   int  | None,    # seconds since last_seen
      }
    """

    _require_auth(request, x_pixelagents_token)
    me = _session_user(request) or ""
    now = time.time()
    users: list[Dict[str, Any]] = []
    for email in USERS.keys():
        is_self = (email == me)
        last_seen = PRESENCE.get(email)
        if is_self:
            # Caller is by definition online (their request just got
            # us here). Show them at the top of the list with a
            # marker so the UI can render the row distinctively.
            users.append({
                "email": email,
                "online": True,
                "is_self": True,
                "last_seen": now,
                "ago_sec": 0,
            })
            continue
        if last_seen is None:
            users.append({
                "email": email,
                "online": False,
                "is_self": False,
                "last_seen": None,
                "ago_sec": None,
            })
            continue
        ago = now - last_seen
        users.append({
            "email": email,
            "online": ago <= ONLINE_WINDOW_SEC,
            "is_self": False,
            "last_seen": last_seen,
            "ago_sec": int(ago),
        })
    # Sort: self first, then online, then offline; alpha within each.
    users.sort(key=lambda u: (
        0 if u.get("is_self") else (1 if u["online"] else 2),
        u["email"],
    ))
    return {
        "users": users,
        "me": me,
        "window_sec": ONLINE_WINDOW_SEC,
        "ts": now,
    }


@app.get("/api/messages/threads")
def api_messages_threads(
    request: Request,
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> Dict[str, Any]:
    """List DM threads involving the calling user, with last-message
    preview so the UI can show "X said: ..." next to each peer."""

    me = _require_real_user(request)
    _ = x_pixelagents_token  # cookie-only path; token unused
    threads: list[Dict[str, Any]] = []
    for (a, b), msgs in DM_MESSAGES.items():
        if me not in (a, b) or not msgs:
            continue
        peer = b if a == me else a
        last = msgs[-1]
        threads.append({
            "peer": peer,
            "message_count": len(msgs),
            "last_message": {
                "from": last.get("from"),
                "text": last.get("text"),
                "ts": last.get("ts"),
            },
        })
    # Sort newest-first by last_message.ts so the list is naturally
    # ordered by "most-recent activity at the top".
    threads.sort(key=lambda t: t.get("last_message", {}).get("ts") or 0, reverse=True)
    return {"threads": threads, "me": me, "ts": time.time()}


@app.get("/api/messages/{peer_email}")
def api_messages_get(
    peer_email: str,
    request: Request,
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> Dict[str, Any]:
    """Return the full conversation between the calling user and `peer_email`."""

    me = _require_real_user(request)
    _ = x_pixelagents_token
    peer = (peer_email or "").strip().lower()
    if not peer:
        raise HTTPException(status_code=400, detail="Missing peer email")
    return {
        "me": me,
        "peer": peer,
        "messages": _dm_get(me, peer),
        "ts": time.time(),
    }


@app.post("/api/messages/{peer_email}")
async def api_messages_post(
    peer_email: str,
    req: Request,
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> Dict[str, Any]:
    """Send a DM from the calling user to `peer_email`. Returns the
    persisted message record (id, ts, ...).

    Demo-grade: doesn't validate that `peer_email` is a known user —
    sending a message to a typo'd address just creates a thread that
    nobody can read on the receiving side. The UI only ever lets the
    user click an existing online human, so this is fine in practice.
    """

    me = _require_real_user(req)
    _ = x_pixelagents_token
    peer = (peer_email or "").strip().lower()
    if not peer:
        raise HTTPException(status_code=400, detail="Missing peer email")
    if peer == me:
        raise HTTPException(status_code=400, detail="Cannot DM yourself")

    try:
        body = await req.json()
    except Exception:
        body = {}
    if not isinstance(body, dict):
        raise HTTPException(status_code=400, detail="Invalid JSON body")
    text = body.get("text")
    if not isinstance(text, str) or not text.strip():
        raise HTTPException(status_code=400, detail="Missing 'text' (non-empty string)")

    msg = _dm_append(me, peer, text.strip())
    return {"ok": True, "message": msg}


@app.get("/api/agents/{agent_id}/messages")
def list_agent_messages(
    agent_id: str,
    request: Request,
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> Dict[str, Any]:
    """Return the calling user's chat history with a specific agent.
    Used by the sidebar to hydrate STATE.conversations on page load /
    navigation, so the user's question and the agent's response survive
    a refresh."""

    _require_auth(request, x_pixelagents_token)
    user = _conv_user_key(request)
    agent_name = _slug_agent(agent_id)
    bucket = CONVERSATIONS.get(user, {}).get(agent_name, [])
    # Return a shallow copy so the caller sees a stable snapshot — the
    # background task may still be mutating individual records.
    return {
        "agent": agent_name,
        "messages": [dict(m) for m in bucket],
        "ts": time.time(),
    }


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

    The actual Foundry call runs as a detached background task that
    accumulates into a CONVERSATIONS record — this endpoint just tails
    that record and emits SSE events. Net effect: closing the browser
    tab mid-response (or navigating away) does NOT cancel the Foundry
    call; the response keeps accumulating server-side and is visible
    when the user comes back via GET /api/agents/{agent}/messages.
    """

    _require_auth(req, x_pixelagents_token)

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

    user = _conv_user_key(req)

    # 1. Persist the user message in CONVERSATIONS so it survives a
    #    refresh / navigation regardless of what happens to the stream.
    user_msg = {
        "id": secrets.token_urlsafe(8),
        "role": "user",
        "text": message.strip(),
        "tool_calls": [],
        "status": "user",
        "error": None,
        "started_at": time.time(),
        "ended_at": time.time(),
    }
    _conv_append(user, agent_name, user_msg)

    # 2. Create the assistant placeholder in "streaming" state. The
    #    background task fills it in. The follow generator below tails
    #    its growth and emits SSE events.
    asst_msg = {
        "id": secrets.token_urlsafe(8),
        "role": "assistant",
        "text": "",
        "tool_calls": [],
        "status": "streaming",
        "error": None,
        "started_at": time.time(),
        "ended_at": None,
    }
    _conv_append(user, agent_name, asst_msg)
    asst_id = asst_msg["id"]

    # 3. Spawn the actual Foundry call as a detached background task.
    #    Critical: runs on the asyncio event loop, NOT inside the
    #    request lifecycle — so a client disconnect (browser navigate,
    #    refresh) does NOT cancel the upstream connection. The response
    #    keeps accumulating into asst_msg either way.
    import asyncio

    asyncio.create_task(
        asyncio.to_thread(
            _run_chat_blocking,
            user,
            agent_name,
            asst_id,
            message.strip(),
            project_endpoint,
            token,
        )
    )

    def generate():
        """Blocking generator — tails asst_msg's growth and emits SSE
        events. Cancellation here only stops the live view; the
        background task above keeps the record current.
        """

        # Resume from a fresh tail: fewer surprises if the request
        # somehow re-attaches to the same record (currently only a
        # single follower per send, but cheap to make safe).
        last_text_len = 0
        last_tool_count = 0
        # 30s grace beyond the upstream's 240s read timeout; if the
        # background task is alive after this we abandon the live tail
        # but the user can still see the eventual answer via GET
        # /messages on next poll.
        deadline = time.time() + 270
        # Yield-loop polling interval. Small enough to feel
        # near-real-time, large enough to avoid burning a thread.
        TICK_SEC = 0.05

        while True:
            m = _conv_find(user, agent_name, asst_id)
            if m is None:
                yield _sse_event("error", {"status": 0, "body": "message gone"})
                yield _sse_event("done", {"tool_calls": []})
                return

            cur_text = m.get("text") or ""
            if len(cur_text) > last_text_len:
                yield _sse_event(
                    "delta", {"text": cur_text[last_text_len:]}
                )
                last_text_len = len(cur_text)

            tools = m.get("tool_calls") or []
            while last_tool_count < len(tools):
                yield _sse_event("tool_call", tools[last_tool_count])
                last_tool_count += 1

            status = m.get("status")
            if status == "completed":
                yield _sse_event(
                    "done",
                    {
                        "tool_calls": tools,
                        "text_chars": len(cur_text),
                    },
                )
                return
            if status == "failed":
                err = m.get("error") or "stream failed"
                # Try to surface a structured body so the UI can render
                # it like a normal error from the old endpoint.
                try:
                    body_payload = json.loads(err) if isinstance(err, str) else err
                except Exception:
                    body_payload = err
                yield _sse_event("error", {"status": 0, "body": body_payload})
                yield _sse_event("done", {"tool_calls": tools})
                return

            if time.time() > deadline:
                # Background task is alive but we've waited a long time
                # — release the connection. The record is still
                # mutating; clients that re-poll will get the final
                # answer when it's ready.
                yield _sse_event(
                    "error",
                    {
                        "status": 0,
                        "body": "live tail timed out — response may still be in flight",
                    },
                )
                yield _sse_event("done", {"tool_calls": tools})
                return

            time.sleep(TICK_SEC)

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
async def sse_stream(
    request: Request,
    x_pixelagents_token: str | None = Header(default=None, alias="x-pixelagents-token"),
) -> StreamingResponse:
    _require_auth(request, x_pixelagents_token)
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
def index(request: Request) -> Response:
    """Serve the Pixel Agents UI, with the AISOC chat drawer injected.

    We don't touch the vendored ui_dist/index.html on disk — instead we read it
    at request time, inject the chat drawer config + script tag before
    ``</body>``, and return the modified HTML. Keeps ui_dist/ a pure vendor
    artifact that can be updated from upstream without merge conflicts.
    """

    # Gate on session cookie — anonymous visitors get redirected to /login.
    current_user = _session_user(request)
    if current_user is None:
        return RedirectResponse(url="/login", status_code=303)

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
    show_cost = os.getenv("SHOW_COST", "1").lower() in ("1", "true", "yes", "on")
    show_cost_js = json.dumps(show_cost)
    # NVISO Cruiseways brand palette override. Re-defines the vendored
    # Pixel Agents CSS variables at :root so the page chrome (buttons,
    # panels, headers) takes a light + blue palette instead of the
    # default dark + purple. The pixel-art office canvas itself is
    # rendered from baked sprites and stays as-is — frames nicely as a
    # focal point against the lighter chrome.
    nviso_theme = (
        '<style id="nviso-theme">'
        ':root {'
        '  --color-bg: #ffffff;'
        '  --color-bg-dark: #f3f4f6;'
        '  --color-bg-thumb: #e5e7eb;'
        '  --color-border: #cbd5e1;'
        '  --color-accent: #0099cc;'
        '  --color-accent-bright: #33b0dd;'
        '  --color-text: #1f2937;'
        '  --color-text-muted: #6b7280;'
        '  --color-btn-bg: #f3f4f6;'
        '  --color-btn-hover: #e5e7eb;'
        '  --color-active-bg: #e0f2fe;'
        '  --shadow-pixel: 2px 2px 0 #cbd5e1;'
        '  --aisoc-sidebar-width: 380px;'
        '}'
        'html, body, #root { background: #ffffff !important; color: #1f2937; }'
        # Reserve room at the top of the vendored canvas for the
        # sticky nav we inject above it.
        'body { padding-top: 60px !important; }'
        # Constrain the bundle's full-viewport canvas so a right
        # sidebar (the Agent Communication panel) fits cleanly.
        '#root { right: var(--aisoc-sidebar-width) !important; }'
        '</style>'
    )
    nav_html = _render_nav("live", current_user)
    injection = (
        f'{NAV_CSS}'
        f'{nviso_theme}'
        f'{nav_html}'
        f'<script>window.__PIXELAGENTS_CHAT = {{ token: {token_js}, show_cost: {show_cost_js} }};</script>'
        # Unified Agent Communication sidebar — replaces the floating
        # chat drawer + HITL pop-up with one panel.
        f'<script src="/static/agent_comm.js" defer></script>'
        f'<script src="/static/agent_activity.js" defer></script>'
        # The standalone live_incident_banner above the office canvas
        # was retired — the same information lives in the Control
        # Panel sidebar's "Incident in flight" card on the right, and
        # showing it twice was just visual noise.
        f'<script src="/static/default_zoom.js" defer></script>'
        f'<script src="/static/bottom_bar_layout.js" defer></script>'
        f'<script src="/static/auto_pickup_badge.js" defer></script>'
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
