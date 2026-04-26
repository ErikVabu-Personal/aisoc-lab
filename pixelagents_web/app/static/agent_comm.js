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
      font: 14px -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      color: var(--color-text, #1f2937);
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
    #${ROOT_ID} .item .head .dot.reading { background: #34d399; }
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
      padding: 7px 10px;
      border-radius: 8px;
      white-space: pre-wrap; word-wrap: break-word;
      font-size: 13px;
    }
    #${ROOT_ID} .msg.user      { align-self: flex-end;   background: #e0f2fe; border: 1px solid #0099cc; }
    #${ROOT_ID} .msg.assistant { align-self: flex-start; background: #f3f4f6; border: 1px solid #cbd5e1; }
    #${ROOT_ID} .msg.error     { align-self: flex-start; background: rgba(239,68,68,0.10); border: 1px solid rgba(239,68,68,0.5); color: #991b1b; }
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
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ── State ───────────────────────────────────────────────────────────
  const STATE = {
    hitl: [],                    // [{id, agent, question, asked_at}]
    agents: [],                  // [{agent, state, ...}]
    expanded: new Set(),         // ids 'hitl-{qid}' or 'chat-{agent}'
    conversations: {},           // agent -> [{role, text, toolCalls?, streaming?, error?}]
    drafts: { hitl: {}, chat: {} },
    sending: new Set(),          // ids currently sending
    chatErrors: {},              // agent -> string
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
    const agent = a.agent;
    const id = `chat-${agent}`;
    const expanded = STATE.expanded.has(id);
    const draft = STATE.drafts.chat[agent] || '';
    const sending = STATE.sending.has(id);
    const chev = expanded ? '▾' : '▸';
    const status = (a && a.inferred_status) || a.state || 'idle';
    const head = `
      <div class="head" data-toggle="${id}">
        <span class="dot ${status}"></span>
        <span class="name">${escapeHtml(capitalize(agent))}</span>
        ${expanded ? '' : `<span class="preview">${escapeHtml(lastMessagePreview(agent))}</span>`}
        <span class="chev">${chev}</span>
      </div>`;
    if (!expanded) return `<div class="item">${head}</div>`;
    const conv = STATE.conversations[agent] || [];
    const msgsHtml = conv.length
      ? conv.map((m) => {
          const cls = m.error ? 'msg error' : `msg ${m.role}`;
          const tools = (m.toolCalls && m.toolCalls.length)
            ? `<div style="margin-top:4px; font-size:11px; opacity:0.7; font-family:ui-monospace,Menlo,monospace;">🔧 ${m.toolCalls.map((t) => escapeHtml(t.name || '')).join(', ')}</div>`
            : '';
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
    return `<div class="item">${head}${body}</div>`;
  }

  function render() {
    const root = ensureRoot();
    // Preserve focus + selection across re-renders so typing isn't disrupted.
    const active = document.activeElement;
    let focusKind = null, focusKey = null, selStart = 0, selEnd = 0;
    if (active && active.tagName === 'TEXTAREA') {
      const hk = active.getAttribute('data-hitl-textarea');
      const ck = active.getAttribute('data-chat-textarea');
      if (hk) { focusKind = 'hitl'; focusKey = hk; }
      else if (ck) { focusKind = 'chat'; focusKey = ck; }
      try { selStart = active.selectionStart; selEnd = active.selectionEnd; } catch (_) {}
    }

    let html = '<header>Agent Communication<div class="sub">Talk to the agents · respond to their requests</div></header>';
    html += '<div class="body">';
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
    html += '</div>';
    root.innerHTML = html;

    // Restore focus.
    if (focusKind && focusKey) {
      const sel = focusKind === 'hitl'
        ? `[data-hitl-textarea="${CSS.escape(focusKey)}"]`
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
    } catch (_) { /* ignore */ }
  }

  ensureRoot();
  render();
  pollHitl(); pollAgents();
  setInterval(pollHitl, POLL_HITL_MS);
  setInterval(pollAgents, POLL_AGENTS_MS);
})();
