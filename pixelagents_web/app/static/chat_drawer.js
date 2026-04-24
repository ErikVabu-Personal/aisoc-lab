/*
 * AISOC chat drawer — Phase 2 MVP for interactive PixelAgents.
 *
 * Renders a floating panel with a list of deployed agents. Clicking an agent
 * opens a simple chat view that POSTs to /api/agents/{id}/message and displays
 * the text response. Intentionally written as dependency-free vanilla JS so it
 * can be served alongside the vendored Pixel Agents bundle without requiring a
 * rebuild.
 *
 * Token is injected into window.__PIXELAGENTS_CHAT by the server (see
 * server.py's `/` handler).
 */

(function () {
  'use strict';

  const cfg = window.__PIXELAGENTS_CHAT || {};
  const TOKEN = cfg.token || '';

  if (!TOKEN) {
    console.warn('[chat-drawer] no token injected; chat disabled.');
    return;
  }

  // ── State ────────────────────────────────────────────────────────────────
  const state = {
    agents: [],                 // [{id, status}]
    selectedAgent: null,        // agent id string or null (null = list view)
    conversations: {},          // { [agentId]: [{role, text}] }
    loading: false,             // request in flight
    open: false,                // drawer open/collapsed
    error: null,
    // Composer state preserved across renders so the roster refresh timer
    // doesn't wipe what the user is typing.
    draft: '',
    draftSelection: [0, 0],
    draftHadFocus: false,
  };

  // ── Root DOM ─────────────────────────────────────────────────────────────
  const rootId = 'aisoc-chat-drawer-root';
  let rootEl = document.getElementById(rootId);
  if (!rootEl) {
    rootEl = document.createElement('div');
    rootEl.id = rootId;
    document.body.appendChild(rootEl);
  }

  // ── Styles (scoped via the root id) ──────────────────────────────────────
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    #${rootId} {
      position: fixed;
      right: 16px;
      bottom: 16px;
      width: 360px;
      max-height: 70vh;
      background: rgba(10, 12, 18, 0.82);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 8px;
      color: #e7e9ee;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 13px;
      line-height: 1.4;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.45);
      z-index: 9999;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    #${rootId}[data-collapsed="true"] {
      max-height: none;
      height: auto;
    }
    #${rootId} header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      background: rgba(255, 255, 255, 0.04);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      cursor: pointer;
      user-select: none;
    }
    #${rootId} header .title {
      flex: 1;
      font-weight: 600;
      letter-spacing: 0.02em;
    }
    #${rootId} header .back {
      background: transparent;
      border: 1px solid rgba(255, 255, 255, 0.15);
      color: #e7e9ee;
      border-radius: 4px;
      padding: 2px 8px;
      cursor: pointer;
      font-size: 12px;
    }
    #${rootId} header .back:hover {
      background: rgba(255, 255, 255, 0.06);
    }
    #${rootId} header .toggle {
      opacity: 0.6;
      font-size: 16px;
      line-height: 1;
    }
    #${rootId} .body {
      flex: 1;
      min-height: 0;
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    #${rootId}[data-collapsed="true"] .body {
      display: none;
    }
    #${rootId} .agent-list {
      padding: 6px;
      overflow-y: auto;
    }
    #${rootId} .agent-row {
      display: flex;
      align-items: center;
      padding: 8px 10px;
      border-radius: 4px;
      cursor: pointer;
      gap: 8px;
    }
    #${rootId} .agent-row:hover {
      background: rgba(255, 255, 255, 0.06);
    }
    #${rootId} .agent-row .dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #6b7280;
      flex-shrink: 0;
    }
    #${rootId} .agent-row .dot.active {
      background: #34d399;
      box-shadow: 0 0 6px rgba(52, 211, 153, 0.8);
    }
    #${rootId} .agent-row .dot.error {
      background: #ef4444;
    }
    #${rootId} .agent-row .name {
      flex: 1;
      text-transform: capitalize;
    }
    #${rootId} .messages {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
      padding: 10px 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    #${rootId} .msg {
      max-width: 92%;
      padding: 8px 10px;
      border-radius: 8px;
      white-space: pre-wrap;
      word-wrap: break-word;
    }
    #${rootId} .msg.user {
      align-self: flex-end;
      background: rgba(96, 165, 250, 0.22);
      border: 1px solid rgba(96, 165, 250, 0.35);
    }
    #${rootId} .msg.assistant {
      align-self: flex-start;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.08);
    }
    #${rootId} .msg.error {
      align-self: flex-start;
      background: rgba(239, 68, 68, 0.2);
      border: 1px solid rgba(239, 68, 68, 0.4);
      color: #fecaca;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
    }
    #${rootId} .msg .tool-calls {
      margin-top: 4px;
      font-size: 11px;
      opacity: 0.7;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    #${rootId} .thinking {
      align-self: flex-start;
      padding: 8px 10px;
      opacity: 0.6;
      font-style: italic;
    }
    #${rootId} .compose {
      border-top: 1px solid rgba(255, 255, 255, 0.08);
      padding: 8px;
      display: flex;
      gap: 6px;
      background: rgba(255, 255, 255, 0.02);
    }
    #${rootId} .compose textarea {
      flex: 1;
      resize: none;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 4px;
      color: #e7e9ee;
      padding: 6px 8px;
      font: inherit;
      min-height: 36px;
      max-height: 120px;
    }
    #${rootId} .compose textarea:focus {
      outline: none;
      border-color: rgba(96, 165, 250, 0.6);
    }
    #${rootId} .compose button {
      background: rgba(96, 165, 250, 0.25);
      border: 1px solid rgba(96, 165, 250, 0.5);
      color: #dbeafe;
      border-radius: 4px;
      padding: 0 12px;
      cursor: pointer;
      font: inherit;
      font-weight: 600;
    }
    #${rootId} .compose button:hover:not(:disabled) {
      background: rgba(96, 165, 250, 0.4);
    }
    #${rootId} .compose button:disabled {
      opacity: 0.4;
      cursor: not-allowed;
    }
    #${rootId} .empty {
      padding: 16px 12px;
      color: rgba(255, 255, 255, 0.5);
      text-align: center;
      font-style: italic;
    }
  `;
  document.head.appendChild(styleEl);

  // ── Helpers ─────────────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function capitalize(s) {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
  }

  function getConversation(agent) {
    if (!state.conversations[agent]) state.conversations[agent] = [];
    return state.conversations[agent];
  }

  // ── Data fetching ───────────────────────────────────────────────────────
  async function loadAgents() {
    try {
      const res = await fetch('/api/agents/state');
      if (!res.ok) return;
      const data = await res.json();
      const next = (data.agents || []).map((a) => ({
        id: a.id,
        status: a.status || 'idle',
      }));

      // When the user is in chat view, we only need to re-render if the set
      // of agents actually changed (so a new agent appears in the back-list).
      // Status flips (idle ↔ reading) don't affect what's on screen and would
      // otherwise clobber the composer.
      const prevIds = state.agents.map((a) => a.id).sort().join('|');
      const nextIds = next.map((a) => a.id).sort().join('|');
      const rosterChanged = prevIds !== nextIds;
      const inListView = state.selectedAgent === null;

      state.agents = next;

      if (inListView || rosterChanged) {
        render();
      }
    } catch (e) {
      console.warn('[chat-drawer] loadAgents failed', e);
    }
  }

  async function sendMessage(agent, text) {
    state.loading = true;
    state.error = null;
    getConversation(agent).push({ role: 'user', text });
    render();
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(agent)}/message`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-pixelagents-token': TOKEN,
        },
        body: JSON.stringify({ message: text }),
      });
      if (!res.ok) {
        let bodyText = '';
        try {
          bodyText = JSON.stringify(await res.json(), null, 2);
        } catch (_) {
          bodyText = await res.text();
        }
        throw new Error(`HTTP ${res.status}\n${bodyText}`);
      }
      const data = await res.json();
      getConversation(agent).push({
        role: 'assistant',
        text: data.text || '(no text returned)',
        toolCalls: data.tool_calls || [],
      });
    } catch (e) {
      getConversation(agent).push({
        role: 'error',
        text: e && e.message ? e.message : String(e),
      });
    } finally {
      state.loading = false;
      render();
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────
  function render() {
    // Capture any in-flight composer state before we blow away the DOM.
    const existingTextarea = rootEl.querySelector('textarea[data-role="input"]');
    if (existingTextarea) {
      state.draft = existingTextarea.value;
      state.draftSelection = [
        existingTextarea.selectionStart || 0,
        existingTextarea.selectionEnd || 0,
      ];
      state.draftHadFocus = document.activeElement === existingTextarea;
    }

    rootEl.setAttribute('data-collapsed', state.open ? 'false' : 'true');

    const header = state.selectedAgent
      ? `<header>
           <button class="back" data-action="back">← Back</button>
           <div class="title">${escapeHtml(capitalize(state.selectedAgent))}</div>
           <div class="toggle" data-action="toggle">${state.open ? '▾' : '▸'}</div>
         </header>`
      : `<header data-action="toggle">
           <div class="title">Chat with agents</div>
           <div class="toggle">${state.open ? '▾' : '▸'}</div>
         </header>`;

    let body = '';
    if (state.selectedAgent) {
      const conv = getConversation(state.selectedAgent);
      const msgsHtml = conv.length
        ? conv
            .map((m) => {
              const toolsHtml =
                m.toolCalls && m.toolCalls.length
                  ? `<div class="tool-calls">🔧 ${m.toolCalls
                      .map((t) => escapeHtml(t.name || ''))
                      .join(', ')}</div>`
                  : '';
              return `<div class="msg ${m.role}">${escapeHtml(m.text)}${toolsHtml}</div>`;
            })
            .join('')
        : `<div class="empty">Send a message to start.</div>`;
      const thinking = state.loading
        ? `<div class="thinking">Agent is thinking…</div>`
        : '';
      body = `
        <div class="messages">${msgsHtml}${thinking}</div>
        <div class="compose">
          <textarea placeholder="Ask ${escapeHtml(
            capitalize(state.selectedAgent),
          )} something…" data-role="input" ${state.loading ? 'disabled' : ''}></textarea>
          <button data-action="send" ${state.loading ? 'disabled' : ''}>Send</button>
        </div>
      `;
    } else {
      const rows = state.agents.length
        ? state.agents
            .map((a) => {
              const cls =
                a.status === 'error'
                  ? 'dot error'
                  : a.status === 'typing' || a.status === 'reading'
                  ? 'dot active'
                  : 'dot';
              return `<div class="agent-row" data-action="pick" data-agent="${escapeHtml(a.id)}">
                        <div class="${cls}"></div>
                        <div class="name">${escapeHtml(a.id)}</div>
                      </div>`;
            })
            .join('')
        : `<div class="empty">No agents yet. Waiting for roster…</div>`;
      body = `<div class="agent-list">${rows}</div>`;
    }

    rootEl.innerHTML = `${header}<div class="body">${body}</div>`;

    const textarea = rootEl.querySelector('textarea[data-role="input"]');
    if (textarea) {
      // Restore the draft value. Only re-focus / restore selection if the
      // user was already typing; otherwise don't steal focus on every poll.
      textarea.value = state.draft || '';
      if (state.draftHadFocus) {
        textarea.focus();
        try {
          textarea.setSelectionRange(
            state.draftSelection[0],
            state.draftSelection[1],
          );
        } catch (_) {
          // setSelectionRange throws on some inputs pre-render; ignore.
        }
      }

      textarea.addEventListener('input', (ev) => {
        state.draft = ev.target.value;
        state.draftSelection = [
          ev.target.selectionStart || 0,
          ev.target.selectionEnd || 0,
        ];
      });

      textarea.addEventListener('focus', () => {
        state.draftHadFocus = true;
      });
      textarea.addEventListener('blur', () => {
        state.draftHadFocus = false;
      });

      textarea.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && !ev.shiftKey) {
          ev.preventDefault();
          onSend();
        }
      });
    }
  }

  // ── Event delegation ────────────────────────────────────────────────────
  function onSend() {
    if (!state.selectedAgent || state.loading) return;
    const textarea = rootEl.querySelector('textarea[data-role="input"]');
    if (!textarea) return;
    const text = (textarea.value || '').trim();
    if (!text) return;
    textarea.value = '';
    state.draft = '';
    state.draftSelection = [0, 0];
    sendMessage(state.selectedAgent, text);
  }

  rootEl.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-action]');
    if (!t) return;
    const action = t.getAttribute('data-action');
    if (action === 'toggle') {
      state.open = !state.open;
      render();
    } else if (action === 'pick') {
      state.selectedAgent = t.getAttribute('data-agent');
      state.open = true;
      state.draft = '';
      state.draftSelection = [0, 0];
      state.draftHadFocus = true; // let the new composer grab focus
      render();
    } else if (action === 'back') {
      state.selectedAgent = null;
      state.draft = '';
      state.draftSelection = [0, 0];
      render();
    } else if (action === 'send') {
      onSend();
    }
  });

  // ── Boot ────────────────────────────────────────────────────────────────
  render();
  loadAgents();
  // Refresh the roster occasionally so newly-registered agents appear.
  setInterval(loadAgents, 5000);
})();
