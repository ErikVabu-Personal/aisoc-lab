// agent_comm.js
// ────────────────────────────────────────────────────────────────────
// Right-side "Agent Communication" sidebar for the Live Agent View.
// Replaces the floating chat drawer + HITL pop-up. Hosts:
//
//   - HITL notifications (questions agents have asked the human)
//   - Per-agent chat threads (human-initiated conversations)
//
// Both surface as collapsible items in a single list. Multiple items
// can be expanded simultaneously, and the list is sorted with HITL
// notifications first (they need attention).

(function () {
  'use strict';

  const ROOT_ID = 'aisoc-comm-root';
  const SIDEBAR_WIDTH = 380; // keep in sync with the index handler's CSS
  const POLL_HITL_MS = 2000;
  const POLL_AGENTS_MS = 4000;
  const POLL_ONLINE_MS = 4000;
  const POLL_DM_MS = 3000; // refresh open DM threads
  const POLL_INCIDENT_MS = 1500; // current_incident — fast so the elapsed timer ticks
  const POLL_QUEUE_MS = 8000; // /api/sentinel/incidents — match dashboard cadence
  const STREAM_PATH = (agent) => `/api/agents/${encodeURIComponent(agent)}/message/stream`;

  // ── Styles ──────────────────────────────────────────────────────────
  const css = `
    #${ROOT_ID} {
      position: fixed !important;
      top: 60px !important;
      right: 0 !important;
      bottom: 0 !important;
      width: ${SIDEBAR_WIDTH}px !important;
      background: var(--color-bg, #ffffff);
      border-left: 1px solid var(--color-border, #cbd5e1);
      box-shadow: -2px 0 12px rgba(0,0,0,0.04);
      z-index: 9999;
      display: flex;
      flex-direction: column;
      font: 15px -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      color: var(--color-text, #1f2937);
    }
    /*
      The vendored Pixel Agents bundle has a global "all-elements"
      font-family rule (FS Pixel Sans) that cascades into every
      descendant of the sidebar — chat bubbles, headers, buttons,
      placeholders all flip back to the pixel font once the bundle's
      stylesheet loads. Force the system stack on every descendant of
      the sidebar with !important so the vendor rule loses the
      cascade. Same pattern as #aisoc-nav.
    */
    #${ROOT_ID},
    #${ROOT_ID} * {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif !important;
    }
    #${ROOT_ID} > header {
      flex-shrink: 0;
      padding: 12px 18px;
      background: var(--color-accent, #0099cc);
      color: #ffffff;
      font-weight: 700;
      font-size: 15px;
      letter-spacing: 0.02em;
      border-bottom: 1px solid var(--color-border, #cbd5e1);
    }
    #${ROOT_ID} .sub {
      font-size: 11px; font-weight: 500; opacity: 0.85;
      margin-top: 2px;
    }
    #${ROOT_ID} .body {
      flex: 1; min-height: 0;
      overflow-y: auto;
      padding: 8px;
    }
    #${ROOT_ID} .item {
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 6px;
      margin-bottom: 8px;
      overflow: hidden;
    }
    #${ROOT_ID} .item.notif { border: 2px solid #facc15; }
    #${ROOT_ID} .item.notif.urgent {
      animation: aisoc-comm-pulse 2.4s ease-in-out infinite;
    }
    @keyframes aisoc-comm-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(250,204,21,0.0); }
      50%      { box-shadow: 0 0 0 4px rgba(250,204,21,0.30); }
    }
    #${ROOT_ID} .item .head {
      padding: 10px 12px;
      cursor: pointer;
      display: flex; align-items: center; gap: 8px;
      user-select: none;
    }
    #${ROOT_ID} .item.notif .head { background: rgba(250,204,21,0.18); color: #713f12; }
    #${ROOT_ID} .item .head .name { flex: 1; font-weight: 700; text-transform: capitalize; }
    #${ROOT_ID} .item .head .preview {
      flex: 1; color: #6b7280; font-size: 12px; font-weight: 500;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    #${ROOT_ID} .item .head .badge {
      background: #facc15; color: #1f2937;
      font-size: 11px; font-weight: 700;
      padding: 2px 8px; border-radius: 999px;
      letter-spacing: 0.05em; text-transform: uppercase;
    }
    #${ROOT_ID} .item .head .chev { color: #9ca3af; flex-shrink: 0; }
    #${ROOT_ID} .item .head .dot {
      width: 8px; height: 8px; border-radius: 50%; background: #9ca3af;
      flex-shrink: 0;
    }
    /* Agent status dots — coherent with the human dots:
         .idle    = online but not actively working   -> solid green
         .reading = actively working / tool call open -> pulsing blue
         .error   = something went wrong              -> red (steady)
       Humans use .dot.online (pulsing green) for online and bare
       .dot (steady grey) for offline. Errors stay red across the
       board. */
    #${ROOT_ID} .item .head .dot.idle    { background: #10b981; }
    #${ROOT_ID} .item .head .dot.reading {
      background: #0099cc;
      box-shadow: 0 0 0 0 rgba(0,153,204,0.55);
      animation: aisoc-comm-active-pulse 1.6s ease-out infinite;
    }
    @keyframes aisoc-comm-active-pulse {
      0%   { box-shadow: 0 0 0 0 rgba(0,153,204,0.55); }
      70%  { box-shadow: 0 0 0 6px rgba(0,153,204,0);  }
      100% { box-shadow: 0 0 0 0 rgba(0,153,204,0);  }
    }
    #${ROOT_ID} .item .head .dot.error   { background: #ef4444; }

    #${ROOT_ID} .item .body-content {
      border-top: 1px solid #f3f4f6;
      padding: 10px 12px;
      max-height: 50vh;
      overflow-y: auto;
    }

    /* HITL question content */
    #${ROOT_ID} .question {
      white-space: pre-wrap; word-wrap: break-word;
      font-size: 13px; color: #1f2937;
      margin: 0 0 10px;
    }
    #${ROOT_ID} .answer-form {
      display: flex; flex-direction: column; gap: 8px;
    }
    #${ROOT_ID} .answer-form textarea {
      resize: vertical; min-height: 56px; max-height: 200px;
      width: 100%;
      padding: 8px 10px;
      border: 1px solid #cbd5e1; border-radius: 4px;
      font: inherit;
      box-sizing: border-box;
    }
    #${ROOT_ID} .answer-form textarea:focus {
      outline: none; border-color: #0099cc;
      box-shadow: 0 0 0 3px rgba(0,153,204,0.18);
    }
    #${ROOT_ID} .answer-form .actions {
      display: flex; gap: 6px; flex-wrap: wrap;
    }
    #${ROOT_ID} .answer-form button {
      padding: 6px 14px; border-radius: 4px;
      border: 1px solid #cbd5e1; background: #f9fafb;
      font: inherit; font-weight: 600; font-size: 13px;
      cursor: pointer; color: #1f2937;
    }
    #${ROOT_ID} .answer-form button:hover { background: #e5e7eb; }
    #${ROOT_ID} .answer-form button.approve {
      background: #facc15; border-color: #ca8a04; color: #1f2937;
    }
    #${ROOT_ID} .answer-form button.approve:hover { background: #eab308; }
    #${ROOT_ID} .answer-form button.reject  { color: #991b1b; }
    #${ROOT_ID} .answer-form button.reject:hover { background: rgba(239,68,68,0.10); }
    #${ROOT_ID} .answer-form button:disabled { opacity: 0.5; cursor: not-allowed; }

    /* Chat thread content */
    #${ROOT_ID} .messages {
      display: flex; flex-direction: column; gap: 6px;
      margin-bottom: 8px;
    }
    #${ROOT_ID} .msg {
      max-width: 92%;
      padding: 8px 12px;
      border-radius: 8px;
      white-space: pre-wrap; word-wrap: break-word;
      font-size: 15px;
      line-height: 1.45;
    }
    #${ROOT_ID} .msg.user      { align-self: flex-end;   background: #e0f2fe; border: 1px solid #0099cc; }
    #${ROOT_ID} .msg.assistant { align-self: flex-start; background: #f3f4f6; border: 1px solid #cbd5e1; }
    #${ROOT_ID} .msg.error     { align-self: flex-start; background: rgba(239,68,68,0.10); border: 1px solid rgba(239,68,68,0.5); color: #991b1b; }

    /* Typing indicator — shown inside an assistant bubble while we're
       streaming but haven't received the first delta yet. Three dots
       fade in/out in sequence, like iMessage / Slack. */
    #${ROOT_ID} .msg.assistant.typing {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 10px 12px;
      min-height: 18px;
    }
    #${ROOT_ID} .msg.assistant.typing .dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: #6b7280;
      opacity: 0.35;
      animation: aisoc-comm-typing 1.2s ease-in-out infinite;
    }
    #${ROOT_ID} .msg.assistant.typing .dot:nth-child(2) { animation-delay: 0.15s; }
    #${ROOT_ID} .msg.assistant.typing .dot:nth-child(3) { animation-delay: 0.30s; }
    @keyframes aisoc-comm-typing {
      0%, 80%, 100% { opacity: 0.35; transform: translateY(0); }
      40%           { opacity: 1;    transform: translateY(-2px); }
    }
    #${ROOT_ID} .compose {
      display: flex; gap: 6px;
    }
    #${ROOT_ID} .compose textarea {
      flex: 1; resize: none;
      padding: 7px 9px;
      border: 1px solid #cbd5e1; border-radius: 4px;
      font: inherit; min-height: 38px; max-height: 120px;
      box-sizing: border-box;
    }
    #${ROOT_ID} .compose textarea:focus {
      outline: none; border-color: #0099cc;
      box-shadow: 0 0 0 3px rgba(0,153,204,0.18);
    }
    #${ROOT_ID} .compose button {
      padding: 0 14px; border: none; border-radius: 4px;
      background: #0099cc; color: #ffffff; font-weight: 700;
      cursor: pointer;
    }
    #${ROOT_ID} .compose button:hover:not(:disabled) { background: #33b0dd; }
    #${ROOT_ID} .compose button:disabled { opacity: 0.5; cursor: not-allowed; }

    #${ROOT_ID} .err-line {
      margin: 6px 0 0;
      padding: 6px 8px;
      background: rgba(239,68,68,0.10);
      color: #991b1b;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      border-radius: 4px;
    }
    #${ROOT_ID} .empty-line {
      padding: 18px;
      text-align: center;
      color: #6b7280;
      font-style: italic;
      font-size: 13px;
    }
    #${ROOT_ID} h2.section {
      font-size: 11px; font-weight: 700; letter-spacing: 0.08em;
      text-transform: uppercase;
      color: #6b7280;
      margin: 12px 12px 6px;
    }
    /* Active-incident banner at the very top of the sidebar body.
       Shown only when /api/current_incident reports a non-null
       incident_number. Click → /dashboard. */
    #${ROOT_ID} .active-banner {
      display: block;
      margin: 8px 8px 12px;
      padding: 10px 12px;
      background: rgba(0,153,204,0.10);
      border: 1px solid rgba(0,153,204,0.45);
      border-radius: 6px;
      cursor: pointer;
      text-decoration: none !important;  /* it's an <a>, kill default underline */
      color: inherit;
      transition: background 0.15s ease;
    }
    #${ROOT_ID} .active-banner:hover {
      background: rgba(0,153,204,0.16);
    }
    #${ROOT_ID} .active-banner .ab-line1 {
      display: flex; align-items: center; gap: 8px;
      font-weight: 700;
      font-size: 13px;
      color: #1e3a8a;
    }
    #${ROOT_ID} .active-banner .ab-line1 .num {
      font-variant-numeric: tabular-nums;
    }
    #${ROOT_ID} .active-banner .ab-line2 {
      font-size: 12px;
      color: #1f2937;
      margin-top: 4px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #${ROOT_ID} .active-banner .ab-line3 {
      font-size: 11px;
      color: #6b7280;
      margin-top: 4px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    /* Per-agent / per-human "owns #N" pill — blue ribbon next to the
       row name to mark who's currently holding the incident. */
    #${ROOT_ID} .item .head .owns-pill {
      flex-shrink: 0;
      padding: 1px 8px;
      border-radius: 999px;
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      background: rgba(0,153,204,0.16);
      color: #1e3a8a;
      font-variant-numeric: tabular-nums;
    }
    /* Highlight ring on the row currently owning the active incident
       — subtle so it doesn't fight with the dot pulse, but enough
       that you can scan to the right row at a glance. */
    #${ROOT_ID} .item.owns-active {
      box-shadow: 0 0 0 2px rgba(0,153,204,0.45) inset;
    }
    /* "My queue" rows — incidents currently owned by the signed-in
       user. Each row is a clickable navigation link to the
       dashboard, NOT a collapsible thread, so it gets its own
       look — flatter than .item, no chev, severity pill on the
       right. */
    #${ROOT_ID} .queue-item {
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 6px;
      margin-bottom: 8px;
      overflow: hidden;
    }
    #${ROOT_ID} .queue-item a {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      text-decoration: none !important;
      color: inherit;
    }
    #${ROOT_ID} .queue-item a:hover {
      background: #f9fafb;
    }
    #${ROOT_ID} .queue-item .qnum {
      font-weight: 700;
      color: #0e2a47;
      font-variant-numeric: tabular-nums;
      flex-shrink: 0;
    }
    #${ROOT_ID} .queue-item .qtitle {
      flex: 1;
      font-size: 13px;
      color: #1f2937;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #${ROOT_ID} .queue-item .qsev {
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      padding: 2px 8px;
      border-radius: 999px;
      flex-shrink: 0;
      border: 1px solid transparent;
    }
    #${ROOT_ID} .queue-item .qsev.high          { color: #991b1b; background: rgba(239,68,68,0.12);  border-color: rgba(239,68,68,0.4); }
    #${ROOT_ID} .queue-item .qsev.medium        { color: #92400e; background: rgba(245,158,11,0.12); border-color: rgba(245,158,11,0.4); }
    #${ROOT_ID} .queue-item .qsev.low           { color: #166534; background: rgba(34,197,94,0.12);  border-color: rgba(34,197,94,0.4); }
    #${ROOT_ID} .queue-item .qsev.informational { color: #1e40af; background: rgba(0,153,204,0.12);  border-color: rgba(0,153,204,0.4); }
    /* Online-presence pulse — green dot on each online human's row. */
    #${ROOT_ID} .item .head .dot.online {
      background: #10b981;
      box-shadow: 0 0 0 0 rgba(16,185,129,0.5);
      animation: aisoc-comm-online-pulse 2.4s ease-out infinite;
    }
    @keyframes aisoc-comm-online-pulse {
      0%   { box-shadow: 0 0 0 0 rgba(16,185,129,0.55); }
      70%  { box-shadow: 0 0 0 6px rgba(16,185,129,0);  }
      100% { box-shadow: 0 0 0 0 rgba(16,185,129,0);  }
    }
    #${ROOT_ID} .item .head .name.email {
      /* Don't title-case email addresses, and let them ellipsis when
         the display name is too long for the row. */
      text-transform: none;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ── State ───────────────────────────────────────────────────────────
  const STATE = {
    hitl: [],                    // [{id, agent, question, asked_at}]
    agents: [],                  // [{agent, state, ...}]
    users: [],                   // [{email, online, last_seen, ago_sec}] — full roster minus me
    me: '',                      // my email (from /api/sessions/online)
    currentIncident: null,       // {incident_number, started_at, title?, view_status?, phase?} or null
    incidents: [],               // [{number, title, severity, status, owner, view_status, ...}] — full Sentinel listing
    expanded: new Set(),         // ids 'hitl-{qid}' or 'chat-{agent}' or 'dm-{email}'
    conversations: {},           // agent -> [{role, text, toolCalls?, streaming?, error?}]
    dmThreads: {},               // peer_email -> [{id, from, to, text, ts}]
    dmThreadsLoaded: new Set(),  // peers whose history we've fetched at least once
    drafts: { hitl: {}, chat: {}, dm: {} },
    sending: new Set(),          // ids currently sending
    chatErrors: {},              // agent -> string
    dmErrors: {},                // peer_email -> string
    historyLoaded: new Set(),    // agents whose history we've fetched at least once
    historyPolling: new Set(),   // agents we're actively re-polling (in-flight on server)
  };

  // ── Helpers ─────────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function capitalize(s) {
    return String(s || '').replace(/^./, (c) => c.toUpperCase());
  }

  function token() {
    return (window.__PIXELAGENTS_CHAT && window.__PIXELAGENTS_CHAT.token) || '';
  }

  function authHeaders() {
    // Cookie auth covers it; the token is a defence-in-depth fallback if
    // the cookie isn't set yet.
    const t = token();
    return t ? { 'x-pixelagents-token': t } : {};
  }

  function lastMessagePreview(agent) {
    const conv = STATE.conversations[agent] || [];
    const last = conv[conv.length - 1];
    if (!last) return 'Click to start a conversation';
    const text = (last.text || '').replace(/\s+/g, ' ').trim();
    return text || (last.role === 'assistant' ? 'Agent is thinking…' : '…');
  }

  // /api/agents/state returns each agent as {id, status, tool_name, ...} —
  // wrap so the rest of this file can keep reading `agent` / `status`.
  function agentName(a) { return (a && (a.id || a.agent)) || ''; }
  function agentStatus(a) { return (a && a.status) || 'idle'; }

  // Returns the agent slug that currently "owns" the active incident
  // (i.e., is in reading state while a workflow is in flight) or
  // null. Heuristic: there's at most one CURRENT_INCIDENT, and during
  // an in-flight run exactly one agent is in the reading state.
  function activeOwnerAgent() {
    if (!STATE.currentIncident || STATE.currentIncident.incident_number == null) {
      return null;
    }
    if (STATE.currentIncident.phase && STATE.currentIncident.phase !== 'agentic') {
      // Server says the run already handed back to a human — no
      // agent currently "holds" the incident in the visual sense.
      return null;
    }
    for (const a of STATE.agents) {
      if (agentStatus(a) === 'reading') return agentName(a);
    }
    return null;
  }

  function fmtElapsed(secs) {
    const s = Math.max(0, Math.floor(secs));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60), r = s % 60;
    return `${m}m${String(r).padStart(2, '0')}s`;
  }

  // ── My queue: incidents owned by the signed-in user ───────────────
  // Filter the full Sentinel incidents listing on owner == me, drop
  // anything closed (closed incidents aren't actionable). Sort by
  // last_modified so the most recent one bubbles up.
  function myQueueIncidents() {
    const me = (STATE.me || '').toLowerCase();
    if (!me || !STATE.incidents.length) return [];
    return STATE.incidents
      .filter((inc) => {
        const owner = String((inc && inc.owner) || '').toLowerCase();
        const status = String((inc && inc.status) || '').toLowerCase();
        return owner === me && status !== 'closed';
      })
      .slice()
      .sort((a, b) => {
        const ta = a.last_modified ? Date.parse(a.last_modified) : 0;
        const tb = b.last_modified ? Date.parse(b.last_modified) : 0;
        return tb - ta;
      });
  }

  // Same deep-link shape the dashboard uses for the incident-#
  // column. Returns null when arm_id is missing — fall back to the
  // dashboard so the row is still clickable (rare; only an issue
  // for incidents that lack the ARM id, which shouldn't happen in
  // practice).
  function sentinelPortalUrl(inc) {
    if (!inc || !inc.arm_id) return null;
    return `https://portal.azure.com/#asset/Microsoft_Azure_Security_Insights/Incident${inc.arm_id}`;
  }

  function renderMyQueueItem(inc) {
    const num = inc.number;
    const title = (inc.title || '').toString();
    const sev = String(inc.severity || '').toLowerCase();
    const portal = sentinelPortalUrl(inc);
    const href = portal || '/dashboard';
    const targetAttr = portal ? ' target="_blank" rel="noopener"' : '';
    const tooltip = portal
      ? `Open #${num} in Microsoft Sentinel`
      : `Open #${num} on the dashboard`;
    return `
      <div class="queue-item">
        <a href="${escapeHtml(href)}"${targetAttr} title="${escapeHtml(tooltip)}">
          <span class="qnum">#${num}</span>
          <span class="qtitle">${escapeHtml(title || '(no title)')}</span>
          ${sev ? `<span class="qsev ${escapeHtml(sev)}">${escapeHtml(inc.severity)}</span>` : ''}
        </a>
      </div>`;
  }

  // ── Rendering ───────────────────────────────────────────────────────
  let rootEl = null;

  function ensureRoot() {
    if (rootEl) return rootEl;
    rootEl = document.createElement('div');
    rootEl.id = ROOT_ID;
    document.body.appendChild(rootEl);
    return rootEl;
  }

  function renderHitlItem(q) {
    const id = `hitl-${q.id}`;
    const expanded = STATE.expanded.has(id);
    const draft = STATE.drafts.hitl[q.id] || '';
    const sending = STATE.sending.has(id);
    const chev = expanded ? '▾' : '▸';
    const head = `
      <div class="head" data-toggle="${id}">
        <span class="badge">Question</span>
        <span class="name">${escapeHtml(q.agent || 'agent')}</span>
        <span class="chev">${chev}</span>
      </div>`;
    if (!expanded) return `<div class="item notif ${sending ? '' : 'urgent'}">${head}</div>`;
    const body = `
      <div class="body-content">
        <p class="question">${escapeHtml(q.question || '')}</p>
        <div class="answer-form">
          <textarea data-hitl-textarea="${q.id}" placeholder="Optional rationale (sent with Approve/Reject)…">${escapeHtml(draft)}</textarea>
          <div class="actions">
            <button class="approve" data-hitl-approve="${q.id}" ${sending ? 'disabled' : ''}>Approve</button>
            <button class="reject"  data-hitl-reject="${q.id}"  ${sending ? 'disabled' : ''}>Reject</button>
          </div>
        </div>
      </div>`;
    return `<div class="item notif">${head}${body}</div>`;
  }

  function renderChatItem(a) {
    const agent = agentName(a);
    if (!agent) return '';
    const id = `chat-${agent}`;
    const expanded = STATE.expanded.has(id);
    const draft = STATE.drafts.chat[agent] || '';
    const sending = STATE.sending.has(id);
    const chev = expanded ? '▾' : '▸';
    const status = agentStatus(a);

    // "owns #N" badge + highlight ring when this agent currently
    // holds the active incident.
    const ownsActive = (
      STATE.currentIncident
      && STATE.currentIncident.incident_number != null
      && activeOwnerAgent() === agent
    );
    const ownsPill = ownsActive
      ? `<span class="owns-pill" title="Currently working on incident #${STATE.currentIncident.incident_number}">#${STATE.currentIncident.incident_number}</span>`
      : '';
    const itemCls = ownsActive ? 'item owns-active' : 'item';

    const head = `
      <div class="head" data-toggle="${id}">
        <span class="dot ${status}"></span>
        <span class="name">${escapeHtml(capitalize(agent))}</span>
        ${ownsPill}
        ${expanded ? '' : `<span class="preview">${escapeHtml(lastMessagePreview(agent))}</span>`}
        <span class="chev">${chev}</span>
      </div>`;
    if (!expanded) return `<div class="${itemCls}">${head}</div>`;
    const conv = STATE.conversations[agent] || [];
    const msgsHtml = conv.length
      ? conv.map((m) => {
          const tools = (m.toolCalls && m.toolCalls.length)
            ? `<div style="margin-top:4px; font-size:11px; opacity:0.7; font-family:ui-monospace,Menlo,monospace;">🔧 ${m.toolCalls.map((t) => escapeHtml(t.name || '')).join(', ')}</div>`
            : '';
          // While we're awaiting the first delta from the model, the
          // bubble has no text yet — show a three-dot typing indicator
          // instead of an empty rectangle. Once any text arrives we
          // switch to normal rendering even if streaming continues.
          if (m.streaming && !(m.text || '').length && !m.error) {
            return `<div class="msg assistant typing" aria-label="Agent is typing">`
                 + `<span class="dot"></span><span class="dot"></span><span class="dot"></span>`
                 + `${tools}</div>`;
          }
          const cls = m.error ? 'msg error' : `msg ${m.role}`;
          return `<div class="${cls}">${escapeHtml(m.text || '')}${tools}</div>`;
        }).join('')
      : '<div class="empty-line" style="padding:8px; font-size:12px;">No messages yet — say hi.</div>';
    const errLine = STATE.chatErrors[agent]
      ? `<div class="err-line">${escapeHtml(STATE.chatErrors[agent])}</div>`
      : '';
    const body = `
      <div class="body-content">
        <div class="messages">${msgsHtml}</div>
        <div class="compose">
          <textarea data-chat-textarea="${escapeHtml(agent)}" placeholder="Message ${escapeHtml(capitalize(agent))}…" ${sending ? 'disabled' : ''}>${escapeHtml(draft)}</textarea>
          <button data-chat-send="${escapeHtml(agent)}" ${sending ? 'disabled' : ''}>Send</button>
        </div>
        ${errLine}
      </div>`;
    return `<div class="${itemCls}">${head}${body}</div>`;
  }

  // ── DM thread item (one per online human) ──────────────────────────
  function dmPreviewFor(peer) {
    const thread = STATE.dmThreads[peer] || [];
    const last = thread[thread.length - 1];
    if (!last) return 'Click to start a conversation';
    const prefix = last.from === STATE.me ? 'You: ' : '';
    return prefix + (last.text || '').replace(/\s+/g, ' ').slice(0, 80);
  }

  function renderDmItem(userRec) {
    // Accept either a full {email, online, ...} record (preferred)
    // or a bare email string (legacy callers that just had a peer).
    const peer = (userRec && typeof userRec === 'object') ? userRec.email : userRec;
    const isOnline = !!(userRec && userRec.online);
    const isSelf = !!(userRec && userRec.is_self);
    if (!peer) return '';

    // Self gets a flat, non-clickable row — no toggle, no thread,
    // no compose. The pulsing green dot makes it visually
    // consistent with the other online users; the "(you)" suffix
    // avoids any "wait, can I DM myself?" confusion.
    if (isSelf) {
      return `
        <div class="item">
          <div class="head" style="cursor: default;">
            <span class="dot online" title="You"></span>
            <span class="name email" title="${escapeHtml(peer)}">`
            + `${escapeHtml(peer)} `
            + `<em style="font-style:italic;opacity:0.6;font-weight:500;">(you)</em>`
            + `</span>
          </div>
        </div>`;
    }

    const id = `dm-${peer}`;
    const expanded = STATE.expanded.has(id);
    const draft = STATE.drafts.dm[peer] || '';
    const sending = STATE.sending.has(id);
    const chev = expanded ? '▾' : '▸';
    const dotCls = isOnline ? 'dot online' : 'dot';
    const dotTitle = isOnline
      ? 'Online'
      : (userRec && userRec.ago_sec != null
          ? `Offline (last seen ${userRec.ago_sec}s ago)`
          : 'Offline');
    const head = `
      <div class="head" data-toggle="${id}">
        <span class="${dotCls}" title="${escapeHtml(dotTitle)}"></span>
        <span class="name email" title="${escapeHtml(peer)}">${escapeHtml(peer)}</span>
        ${expanded ? '' : `<span class="preview">${escapeHtml(dmPreviewFor(peer))}</span>`}
        <span class="chev">${chev}</span>
      </div>`;
    if (!expanded) return `<div class="item">${head}</div>`;

    const thread = STATE.dmThreads[peer] || [];
    const me = STATE.me;
    const msgsHtml = thread.length
      ? thread.map((m) => {
          // Reuse the agent-chat bubble look: own messages on the
          // right (user-bubble), peer messages on the left (assistant
          // bubble — neutral grey).
          const cls = m.from === me ? 'msg user' : 'msg assistant';
          const ts = m.ts ? new Date(m.ts * 1000).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'}) : '';
          const tsLine = ts
            ? `<div style="margin-top:4px;font-size:10px;opacity:0.6;">${escapeHtml(ts)}</div>`
            : '';
          return `<div class="${cls}">${escapeHtml(m.text || '')}${tsLine}</div>`;
        }).join('')
      : '<div class="empty-line" style="padding:8px; font-size:12px;">No messages yet — say hi.</div>';
    const errLine = STATE.dmErrors[peer]
      ? `<div class="err-line">${escapeHtml(STATE.dmErrors[peer])}</div>`
      : '';
    const body = `
      <div class="body-content">
        <div class="messages">${msgsHtml}</div>
        <div class="compose">
          <textarea data-dm-textarea="${escapeHtml(peer)}" placeholder="Message ${escapeHtml(peer)}…" ${sending ? 'disabled' : ''}>${escapeHtml(draft)}</textarea>
          <button data-dm-send="${escapeHtml(peer)}" ${sending ? 'disabled' : ''}>Send</button>
        </div>
        ${errLine}
      </div>`;
    return `<div class="item">${head}${body}</div>`;
  }

  function render() {
    const root = ensureRoot();

    // ── Preserve focus + selection across re-renders ──
    const active = document.activeElement;
    let focusKind = null, focusKey = null, selStart = 0, selEnd = 0;
    if (active && active.tagName === 'TEXTAREA') {
      const hk = active.getAttribute('data-hitl-textarea');
      const ck = active.getAttribute('data-chat-textarea');
      const dk = active.getAttribute('data-dm-textarea');
      if (hk) { focusKind = 'hitl'; focusKey = hk; }
      else if (ck) { focusKind = 'chat'; focusKey = ck; }
      else if (dk) { focusKind = 'dm'; focusKey = dk; }
      try { selStart = active.selectionStart; selEnd = active.selectionEnd; } catch (_) {}
    }

    // ── Snapshot scroll positions before the innerHTML wipe ──
    // Two scroll containers matter: the sidebar's `.body` (the list of
    // items) and each open item's `.body-content` (the chat thread or
    // HITL question). Both reset to top on innerHTML replacement; we
    // restore here so streaming tokens / poll refreshes don't yank
    // the user back to the top of whatever they were reading.
    //
    // For each, we also remember whether the user was already at the
    // bottom — if so, we *re-stick* to the bottom after render so new
    // content appears as if the chat scrolled naturally with it.
    const STICK_THRESHOLD_PX = 30;
    function snapshotScroll(el) {
      if (!el) return null;
      return {
        top: el.scrollTop,
        atBottom: (el.scrollHeight - el.scrollTop - el.clientHeight) < STICK_THRESHOLD_PX,
      };
    }
    const bodyScroll = snapshotScroll(root.querySelector('.body'));
    const itemScrolls = {};
    root.querySelectorAll('.item').forEach((item) => {
      const head = item.querySelector('[data-toggle]');
      const id = head ? head.getAttribute('data-toggle') : null;
      const content = item.querySelector('.body-content');
      if (id && content) itemScrolls[id] = snapshotScroll(content);
    });

    let html = '<header>Control Panel<div class="sub">Agents, humans, and the incidents on your plate</div></header>';
    html += '<div class="body">';

    // Active incident banner — sits at the very top so the user
    // always knows what's in flight at a glance.
    const ci = STATE.currentIncident;
    if (ci && ci.incident_number != null) {
      const num = ci.incident_number;
      const title = ci.title || '(loading title…)';
      const phase = ci.phase || 'agentic';
      const ownerSlug = activeOwnerAgent();
      const ownerLabel = ownerSlug
        ? capitalize(ownerSlug)
        : (phase === 'human' ? 'Human analyst' : '—');
      const elapsed = ci.started_at
        ? fmtElapsed(Date.now() / 1000 - ci.started_at)
        : '—';
      html += `
        <a href="/dashboard" class="active-banner" title="Open in dashboard">
          <div class="ab-line1">
            <span class="dot reading"></span>
            <span class="num">Incident #${num}</span>
            <span style="opacity:0.7;font-weight:500;">in flight</span>
          </div>
          <div class="ab-line2">${escapeHtml(title)}</div>
          <div class="ab-line3">
            ${escapeHtml(ownerLabel)} · ${escapeHtml(elapsed)} elapsed
          </div>
        </a>`;
    }

    if (STATE.hitl.length) {
      html += '<h2 class="section">Pending requests</h2>';
      for (const q of STATE.hitl) html += renderHitlItem(q);
    }
    html += '<h2 class="section">Agents</h2>';
    if (!STATE.agents.length) {
      html += '<div class="empty-line">No agents reporting yet.</div>';
    } else {
      for (const a of STATE.agents) html += renderChatItem(a);
    }
    // Humans — full configured roster (online sorted first, then
    // offline). Status dot reflects online/offline, same affordance
    // as the agents above.
    html += '<h2 class="section">Humans</h2>';
    if (!STATE.users.length) {
      html += '<div class="empty-line">No other humans configured.</div>';
    } else {
      for (const u of STATE.users) html += renderDmItem(u);
    }
    // My queue — non-Closed Sentinel incidents whose owner is the
    // signed-in user. Click → /dashboard (where the row's "Run
    // workflow" / runs-history live).
    html += '<h2 class="section">My queue</h2>';
    const myInc = myQueueIncidents();
    if (!myInc.length) {
      html += '<div class="empty-line">No incidents currently assigned to you.</div>';
    } else {
      for (const inc of myInc) html += renderMyQueueItem(inc);
    }
    html += '</div>';
    root.innerHTML = html;

    // ── Restore scroll positions ──
    function restoreScroll(el, snap) {
      if (!el || !snap) return;
      // Auto-stick to bottom if the user was already there; otherwise
      // restore the exact prior offset.
      el.scrollTop = snap.atBottom ? el.scrollHeight : snap.top;
    }
    restoreScroll(root.querySelector('.body'), bodyScroll);
    root.querySelectorAll('.item').forEach((item) => {
      const head = item.querySelector('[data-toggle]');
      const id = head ? head.getAttribute('data-toggle') : null;
      const content = item.querySelector('.body-content');
      if (id && content && itemScrolls[id]) {
        restoreScroll(content, itemScrolls[id]);
      }
    });

    // ── Restore focus ──
    if (focusKind && focusKey) {
      const sel = focusKind === 'hitl'
        ? `[data-hitl-textarea="${CSS.escape(focusKey)}"]`
        : focusKind === 'dm'
          ? `[data-dm-textarea="${CSS.escape(focusKey)}"]`
          : `[data-chat-textarea="${CSS.escape(focusKey)}"]`;
      const el = root.querySelector(sel);
      if (el) {
        try { el.focus(); el.setSelectionRange(selStart, selEnd); } catch (_) {}
      }
    }

    // Click handlers on heads (toggle).
    root.querySelectorAll('[data-toggle]').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.getAttribute('data-toggle');
        if (STATE.expanded.has(id)) STATE.expanded.delete(id);
        else STATE.expanded.add(id);
        render();
      });
    });

    // HITL textarea drafts.
    root.querySelectorAll('[data-hitl-textarea]').forEach((ta) => {
      ta.addEventListener('input', () => {
        STATE.drafts.hitl[ta.getAttribute('data-hitl-textarea')] = ta.value;
      });
    });
    root.querySelectorAll('[data-hitl-approve]').forEach((btn) => {
      btn.addEventListener('click', () => onHitlAnswer(btn.getAttribute('data-hitl-approve'), 'approve'));
    });
    root.querySelectorAll('[data-hitl-reject]').forEach((btn) => {
      btn.addEventListener('click', () => onHitlAnswer(btn.getAttribute('data-hitl-reject'), 'reject'));
    });

    // Chat textarea drafts + send.
    root.querySelectorAll('[data-chat-textarea]').forEach((ta) => {
      const agent = ta.getAttribute('data-chat-textarea');
      ta.addEventListener('input', () => { STATE.drafts.chat[agent] = ta.value; });
      ta.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          onChatSend(agent);
        }
      });
    });
    root.querySelectorAll('[data-chat-send]').forEach((btn) => {
      btn.addEventListener('click', () => onChatSend(btn.getAttribute('data-chat-send')));
    });

    // DM textarea drafts + send + Enter-to-send.
    root.querySelectorAll('[data-dm-textarea]').forEach((ta) => {
      const peer = ta.getAttribute('data-dm-textarea');
      ta.addEventListener('input', () => { STATE.drafts.dm[peer] = ta.value; });
      ta.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          onDmSend(peer);
        }
      });
    });
    root.querySelectorAll('[data-dm-send]').forEach((btn) => {
      btn.addEventListener('click', () => onDmSend(btn.getAttribute('data-dm-send')));
    });

    // Lazy-hydrate any DM thread that's currently expanded but not
    // yet loaded (e.g. user just clicked a head for the first time).
    for (const id of STATE.expanded) {
      if (!id.startsWith('dm-')) continue;
      const peer = id.slice(3);
      if (!STATE.dmThreadsLoaded.has(peer)) {
        STATE.dmThreadsLoaded.add(peer);
        hydrateDmThread(peer);
      }
    }
  }

  // ── HITL answer ─────────────────────────────────────────────────────
  async function onHitlAnswer(qid, decision) {
    const id = `hitl-${qid}`;
    if (STATE.sending.has(id)) return;
    STATE.sending.add(id);
    render();
    try {
      const rationale = STATE.drafts.hitl[qid] || '';
      const answer = decision === 'approve'
        ? (rationale ? `APPROVE: ${rationale}` : 'APPROVE')
        : (rationale ? `REJECT: ${rationale}` : 'REJECT');
      const r = await fetch(`/api/hitl/answer/${encodeURIComponent(qid)}`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ answer }),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status}: ${text}`);
      }
      // Optimistic: remove from local pending list; the next poll will reconcile.
      STATE.hitl = STATE.hitl.filter((q) => q.id !== qid);
      STATE.expanded.delete(id);
      delete STATE.drafts.hitl[qid];
    } catch (e) {
      // Surface the error in the relevant question's draft area.
      STATE.drafts.hitl[qid] = (STATE.drafts.hitl[qid] || '') + `\n[error: ${e.message || e}]`;
    } finally {
      STATE.sending.delete(id);
      render();
    }
  }

  // ── Chat send (streaming) ───────────────────────────────────────────
  async function onChatSend(agent) {
    const id = `chat-${agent}`;
    if (STATE.sending.has(id)) return;
    const text = (STATE.drafts.chat[agent] || '').trim();
    if (!text) return;

    if (!STATE.conversations[agent]) STATE.conversations[agent] = [];
    STATE.conversations[agent].push({ role: 'user', text });
    const assistantIdx = STATE.conversations[agent].length;
    STATE.conversations[agent].push({ role: 'assistant', text: '', streaming: true });

    STATE.drafts.chat[agent] = '';
    STATE.sending.add(id);
    STATE.chatErrors[agent] = '';
    render();

    try {
      const r = await fetch(STREAM_PATH(agent), {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...authHeaders() },
        body: JSON.stringify({ message: text }),
      });
      if (!r.ok || !r.body) {
        const errText = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status}: ${errText}`);
      }

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n\n');
        buf = lines.pop() || '';
        for (const block of lines) {
          handleSseBlock(block, agent, assistantIdx);
        }
        render();
      }
      // Any tail bytes
      if (buf.trim()) handleSseBlock(buf, agent, assistantIdx);
      const m = STATE.conversations[agent][assistantIdx];
      if (m) m.streaming = false;
    } catch (e) {
      const m = STATE.conversations[agent][assistantIdx];
      if (m) { m.error = true; m.text = (m.text || '') + `\n${e.message || e}`; m.streaming = false; }
      STATE.chatErrors[agent] = String(e.message || e);
    } finally {
      STATE.sending.delete(id);
      render();
    }
  }

  function handleSseBlock(block, agent, assistantIdx) {
    let event = 'message', dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    const raw = dataLines.join('\n');
    let data;
    try { data = JSON.parse(raw); } catch (_) { return; }

    const m = STATE.conversations[agent][assistantIdx];
    if (!m) return;
    if (event === 'delta' && data.text) {
      m.text = (m.text || '') + data.text;
    } else if (event === 'tool_call' && data.name) {
      if (!m.toolCalls) m.toolCalls = [];
      m.toolCalls.push({ name: data.name });
    } else if (event === 'error') {
      m.error = true;
      m.text = `Error ${data.status || ''}: ${typeof data.body === 'string' ? data.body : JSON.stringify(data.body)}`;
    }
  }

  // ── Polling ────────────────────────────────────────────────────────
  async function pollHitl() {
    try {
      const r = await fetch('/api/hitl/pending', { credentials: 'same-origin', headers: authHeaders() });
      if (!r.ok) return;
      const data = await r.json();
      const next = (data && data.questions) || [];
      // Detect new questions for an audible hint? Skip for now.
      STATE.hitl = next;
      render();
    } catch (_) { /* ignore */ }
  }

  async function pollAgents() {
    try {
      const r = await fetch('/api/agents/state', { credentials: 'same-origin', headers: authHeaders() });
      if (!r.ok) return;
      const data = await r.json();
      STATE.agents = (data && data.agents) || [];
      render();

      // First time we see the roster, hydrate per-agent chat history
      // from the server. Lets a navigation / refresh restore
      // conversations that happened in earlier visits.
      if (!STATE.__historyHydrated) {
        STATE.__historyHydrated = true;
        const slugs = STATE.agents.map(agentName).filter(Boolean);
        for (const slug of slugs) hydrateAgentHistory(slug);
      }
    } catch (_) { /* ignore */ }
  }

  // ── Per-agent chat history ─────────────────────────────────────────
  // The server persists each user's conversation with each agent in
  // CONVERSATIONS, so this fetch returns whatever was previously sent
  // (including responses that arrived while we were away on another
  // page). After hydration, if any message is still streaming on the
  // server, set up a 2s repoll until it lands or fails.
  function convertServerMessage(m) {
    if (!m || typeof m !== 'object') return null;
    const out = { role: m.role || 'assistant', text: m.text || '' };
    if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
      out.toolCalls = m.tool_calls.map((t) => ({ name: (t && t.name) || '' }));
    }
    if (m.status === 'streaming') out.streaming = true;
    if (m.status === 'failed') {
      out.error = true;
      if (!out.text) {
        let body = m.error || 'stream failed';
        // Server often packs structured errors as JSON strings — pretty
        // them up so the user sees readable text in the bubble.
        try {
          const parsed = JSON.parse(body);
          body = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
        } catch (_) { /* keep raw string */ }
        out.text = `Error: ${body}`;
      }
    }
    return out;
  }

  async function hydrateAgentHistory(slug) {
    if (!slug) return;
    try {
      const r = await fetch(
        `/api/agents/${encodeURIComponent(slug)}/messages`,
        { credentials: 'same-origin', headers: authHeaders() },
      );
      if (!r.ok) return;
      const data = await r.json();
      const messages = (data && data.messages) || [];
      const converted = messages.map(convertServerMessage).filter(Boolean);

      // Don't clobber a send that's currently in flight in THIS tab —
      // the local SSE handler is the authoritative writer for it.
      const inFlightLocal = STATE.sending.has(`chat-${slug}`);
      if (!inFlightLocal) {
        STATE.conversations[slug] = converted;
        render();
      }

      STATE.historyLoaded.add(slug);

      // If anything is still streaming server-side, keep refreshing
      // until it lands. Coalesce concurrent calls per agent.
      const stillStreaming = converted.some((m) => m && m.streaming);
      if (stillStreaming) {
        if (!STATE.historyPolling.has(slug)) {
          STATE.historyPolling.add(slug);
          setTimeout(() => {
            STATE.historyPolling.delete(slug);
            hydrateAgentHistory(slug);
          }, 2000);
        }
      }
    } catch (_) { /* ignore — next render keeps showing what we have */ }
  }

  // ── Sentinel incidents polling ─────────────────────────────────────
  // Drives the "My queue" section. Same endpoint the dashboard
  // already polls — same 8s cadence.
  async function pollIncidents() {
    try {
      const r = await fetch('/api/sentinel/incidents',
                            { credentials: 'same-origin', headers: authHeaders() });
      if (!r.ok) return;
      const data = await r.json();
      STATE.incidents = (data && data.incidents) || [];
      render();
    } catch (_) { /* ignore */ }
  }

  // ── Active-incident polling ────────────────────────────────────────
  // Drives the banner at the top of the sidebar and the "owns #N"
  // pill on the agent currently working it. Faster than the agent
  // poll so the elapsed-time counter ticks visibly.
  async function pollCurrentIncident() {
    try {
      const r = await fetch('/api/current_incident',
                            { credentials: 'same-origin', headers: authHeaders() });
      if (!r.ok) return;
      const data = await r.json();
      const had = !!(STATE.currentIncident && STATE.currentIncident.incident_number != null);
      const has = !!(data && data.incident_number != null);
      STATE.currentIncident = has ? data : null;
      // Re-render only when state actually changed OR when an incident
      // is in flight (so the elapsed timer ticks). Avoids burning
      // cycles re-rendering the static "no incident" sidebar every
      // 1.5s when nothing is happening.
      if (has || had) render();
    } catch (_) { /* ignore */ }
  }

  // ── Online presence + DM polling ───────────────────────────────────
  async function pollOnline() {
    try {
      const r = await fetch('/api/sessions/online',
                            { credentials: 'same-origin', headers: authHeaders() });
      if (!r.ok) return;
      const data = await r.json();
      // Endpoint now returns the full configured roster minus self,
      // each with an `online` boolean. Render every entry; the row's
      // dot reflects status the same way agent rows do.
      STATE.users = (data && data.users) || [];
      STATE.me = (data && data.me) || STATE.me;
      render();
    } catch (_) { /* ignore */ }
  }

  // Refresh every open DM thread on a steady tick, so messages from
  // peers appear without the user having to close + re-open the
  // panel. Only refreshes threads whose head is currently expanded —
  // collapsed threads stay cached and refresh on next expand.
  async function pollOpenDms() {
    for (const id of STATE.expanded) {
      if (!id.startsWith('dm-')) continue;
      const peer = id.slice(3);
      // No-await fan-out: hydrateDmThread updates state and triggers
      // its own render when the response lands.
      hydrateDmThread(peer);
    }
  }

  async function hydrateDmThread(peer) {
    try {
      const r = await fetch(
        `/api/messages/${encodeURIComponent(peer)}`,
        { credentials: 'same-origin', headers: authHeaders() },
      );
      if (!r.ok) return;
      const data = await r.json();
      const msgs = (data && data.messages) || [];
      // Replace wholesale — server is the source of truth.
      STATE.dmThreads[peer] = msgs;
      // Clear any prior error if we successfully refreshed.
      if (STATE.dmErrors[peer]) delete STATE.dmErrors[peer];
      render();
    } catch (_) { /* ignore — next tick will retry */ }
  }

  async function onDmSend(peer) {
    const id = `dm-${peer}`;
    if (STATE.sending.has(id)) return;
    const text = (STATE.drafts.dm[peer] || '').trim();
    if (!text) return;

    // Optimistic local append so the user's own message lands
    // immediately without waiting on the round trip.
    const localMsg = {
      id: `local-${Date.now()}`,
      from: STATE.me,
      to: peer,
      text,
      ts: Date.now() / 1000,
    };
    if (!STATE.dmThreads[peer]) STATE.dmThreads[peer] = [];
    STATE.dmThreads[peer].push(localMsg);
    STATE.drafts.dm[peer] = '';
    STATE.sending.add(id);
    delete STATE.dmErrors[peer];
    render();

    try {
      const r = await fetch(
        `/api/messages/${encodeURIComponent(peer)}`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ text }),
        },
      );
      if (!r.ok) {
        const errText = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status}: ${errText.slice(0, 200)}`);
      }
      // Re-hydrate from server so the local-temp id is replaced with
      // the real persisted record (matters if the user sends multiple
      // in a row before a poll tick lands).
      hydrateDmThread(peer);
    } catch (e) {
      // Roll back the optimistic append.
      STATE.dmThreads[peer] = (STATE.dmThreads[peer] || []).filter(
        (m) => m.id !== localMsg.id,
      );
      // Put the draft back so the user doesn't have to retype.
      STATE.drafts.dm[peer] = text;
      STATE.dmErrors[peer] = String(e.message || e);
    } finally {
      STATE.sending.delete(id);
      render();
    }
  }

  ensureRoot();
  render();
  pollHitl(); pollAgents(); pollOnline(); pollCurrentIncident(); pollIncidents();
  setInterval(pollHitl, POLL_HITL_MS);
  setInterval(pollAgents, POLL_AGENTS_MS);
  setInterval(pollOnline, POLL_ONLINE_MS);
  setInterval(pollOpenDms, POLL_DM_MS);
  setInterval(pollCurrentIncident, POLL_INCIDENT_MS);
  setInterval(pollIncidents, POLL_QUEUE_MS);
})();
