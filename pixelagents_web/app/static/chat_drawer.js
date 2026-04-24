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
    /* Inherit FS Pixel Sans from the vendored Pixel Agents global styles so
       the drawer matches the rest of the UI. Colors pull from the vendored
       CSS custom properties so the panel restyles automatically if the
       upstream theme changes; fallbacks kick in if the webfont CSS hasn't
       parsed yet. */
    #${rootId} {
      position: fixed;
      right: 16px;
      bottom: 16px;
      width: 520px;
      max-height: 75vh;
      background: var(--color-bg, #1e1e2e);
      border: 2px solid var(--color-border, #4a4a6a);
      border-radius: 6px;
      color: var(--color-text, #ffffffe6);
      font-size: 22px;
      line-height: 1.4;
      box-shadow: var(--shadow-pixel, 2px 2px 0 #0a0a14);
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
      background: var(--color-accent, #6030ff);
      border-bottom: 2px solid var(--color-border, #4a4a6a);
      color: #fff;
      cursor: pointer;
      user-select: none;
    }
    #${rootId} header .title {
      flex: 1;
      font-weight: 700;
      letter-spacing: 0.02em;
    }
    #${rootId} header .back {
      background: var(--color-btn-bg, #353445);
      border: 2px solid var(--color-border, #4a4a6a);
      color: var(--color-text, #ffffffe6);
      border-radius: 4px;
      padding: 4px 10px;
      cursor: pointer;
      font-size: 18px;
      box-shadow: var(--shadow-pixel, 2px 2px 0 #0a0a14);
    }
    #${rootId} header .back:hover {
      background: var(--color-btn-hover, #4e4b68);
    }
    #${rootId} header .toggle {
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
      /* Errors + tool-call chips keep a monospace font for alignment of
         status codes / tool names; reads fine beside the pixel text. */
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 16px;
    }
    #${rootId} .msg .tool-calls {
      margin-top: 4px;
      font-size: 16px;
      opacity: 0.7;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    #${rootId} .thinking-dots {
      opacity: 0.7;
      font-style: italic;
    }
    #${rootId} .thinking-dots .dots {
      display: inline-block;
      animation: aisoc-chat-dots 1.1s steps(3, end) infinite;
      overflow: hidden;
      vertical-align: bottom;
      width: 1.2em;
      white-space: nowrap;
    }
    @keyframes aisoc-chat-dots {
      0%   { clip-path: inset(0 1em 0 0); }
      33%  { clip-path: inset(0 0.66em 0 0); }
      66%  { clip-path: inset(0 0.33em 0 0); }
      100% { clip-path: inset(0 0 0 0); }
    }
    #${rootId} .cursor {
      display: inline-block;
      margin-left: 2px;
      opacity: 0.6;
      animation: aisoc-chat-cursor 1s steps(2, end) infinite;
    }
    @keyframes aisoc-chat-cursor {
      50% { opacity: 0; }
    }
    #${rootId} .compose {
      border-top: 2px solid var(--color-border, #4a4a6a);
      padding: 8px;
      display: flex;
      gap: 6px;
      background: var(--color-bg-dark, #181828);
    }
    #${rootId} .compose textarea {
      flex: 1;
      resize: none;
      background: var(--color-bg-dark, #181828);
      border: 2px solid var(--color-border, #4a4a6a);
      border-radius: 4px;
      color: var(--color-text, #ffffffe6);
      padding: 8px 10px;
      font: inherit;
      min-height: 52px;
      max-height: 160px;
    }
    #${rootId} .compose textarea:focus {
      outline: none;
      border-color: var(--color-accent, #6030ff);
    }
    #${rootId} .compose button {
      background: var(--color-accent, #6030ff);
      border: 2px solid var(--color-border, #4a4a6a);
      color: #fff;
      border-radius: 4px;
      padding: 0 16px;
      cursor: pointer;
      font: inherit;
      font-weight: 700;
      box-shadow: var(--shadow-pixel, 2px 2px 0 #0a0a14);
    }
    #${rootId} .compose button:hover:not(:disabled) {
      background: var(--color-accent-bright, #746fff);
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
    // Handles hyphenated / snake_cased agent slugs, so "detection-engineer"
    // renders as "Detection Engineer" rather than "Detection-engineer".
    return String(s || '')
      .split(/[-_\s]+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
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

  function parseSseBlock(block) {
    // Parse a single SSE event block (lines terminated by \n, block by \n\n).
    let eventName = null;
    const dataLines = [];
    for (const rawLine of block.split('\n')) {
      const line = rawLine.replace(/\r$/, '');
      if (line.startsWith('event:')) {
        eventName = line.slice(6).trim();
      } else if (line.startsWith('data:')) {
        let chunk = line.slice(5);
        if (chunk.startsWith(' ')) chunk = chunk.slice(1);
        dataLines.push(chunk);
      }
      // ignore id:, retry:, comments starting with ':'
    }
    if (!eventName) return null;
    let data = null;
    if (dataLines.length) {
      const raw = dataLines.join('');
      try {
        data = JSON.parse(raw);
      } catch (_) {
        data = raw;
      }
    }
    return { event: eventName, data: data == null ? {} : data };
  }

  async function sendMessage(agent, text) {
    state.loading = true;
    state.error = null;
    getConversation(agent).push({ role: 'user', text });

    // Placeholder that grows as deltas arrive.
    const placeholder = {
      role: 'assistant',
      text: '',
      toolCalls: [],
      streaming: true,
    };
    getConversation(agent).push(placeholder);
    render();

    let lastRender = Date.now();
    const RENDER_THROTTLE_MS = 60; // ~15fps max

    const renderSoon = () => {
      const now = Date.now();
      if (now - lastRender >= RENDER_THROTTLE_MS) {
        lastRender = now;
        render();
      }
    };

    try {
      const res = await fetch(
        `/api/agents/${encodeURIComponent(agent)}/message/stream`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-pixelagents-token': TOKEN,
            Accept: 'text/event-stream',
          },
          body: JSON.stringify({ message: text }),
        },
      );
      if (!res.ok) {
        let bodyText = '';
        try {
          bodyText = JSON.stringify(await res.json(), null, 2);
        } catch (_) {
          bodyText = await res.text();
        }
        throw new Error(`HTTP ${res.status}\n${bodyText}`);
      }
      if (!res.body) {
        throw new Error('Response has no stream body.');
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let errored = false;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Split on SSE event boundary (\n\n). Keep the tail for next chunk.
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const ev = parseSseBlock(block);
          if (!ev) continue;

          if (ev.event === 'delta' && ev.data && typeof ev.data.text === 'string') {
            placeholder.text += ev.data.text;
            renderSoon();
          } else if (ev.event === 'tool_call' && ev.data && ev.data.name) {
            placeholder.toolCalls.push({
              name: ev.data.name,
              arguments: ev.data.arguments || {},
            });
            renderSoon();
          } else if (ev.event === 'error') {
            const bodyStr =
              typeof ev.data.body === 'string'
                ? ev.data.body
                : JSON.stringify(ev.data.body, null, 2);
            // Convert the placeholder into an error bubble.
            placeholder.role = 'error';
            placeholder.text = `Foundry error (HTTP ${ev.data.status}):\n${bodyStr}`;
            placeholder.streaming = false;
            errored = true;
            render();
          } else if (ev.event === 'done') {
            // Surface the diagnostic in the browser console so we can see
            // what the upstream Foundry stream actually emitted without
            // touching server logs. Useful when the response is empty.
            try {
              // eslint-disable-next-line no-console
              console.debug('[chat-drawer] stream done', ev.data);
            } catch (_) {}
            placeholder.streaming = false;
            render();
          }
        }
      }

      placeholder.streaming = false;
      if (!errored && !placeholder.text) {
        const hadTools = placeholder.toolCalls && placeholder.toolCalls.length;
        placeholder.text = hadTools
          ? '(the agent ran tools but produced no text reply — try asking again or rephrase the question)'
          : '(no text returned)';
      }
    } catch (e) {
      placeholder.role = 'error';
      placeholder.text = e && e.message ? e.message : String(e);
      placeholder.streaming = false;
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

    // Capture scroll state before we rebuild the DOM so streaming deltas
    // don't scroll the user back to the top of the thread on every chunk.
    let prevScrollTop = 0;
    let prevWasNearBottom = true;
    const existingMessages = rootEl.querySelector('.messages');
    if (existingMessages) {
      prevScrollTop = existingMessages.scrollTop;
      prevWasNearBottom =
        existingMessages.scrollHeight -
          existingMessages.scrollTop -
          existingMessages.clientHeight <
        50;
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
              // While streaming with no text yet, show a subtle thinking
              // indicator in the bubble instead of an empty box.
              const textHtml =
                m.streaming && !m.text
                  ? `<span class="thinking-dots">Agent is thinking<span class="dots">…</span></span>`
                  : escapeHtml(m.text);
              const cursor =
                m.streaming && m.text
                  ? `<span class="cursor">▋</span>`
                  : '';
              return `<div class="msg ${m.role}">${textHtml}${cursor}${toolsHtml}</div>`;
            })
            .join('')
        : `<div class="empty">Send a message to start.</div>`;
      body = `
        <div class="messages">${msgsHtml}</div>
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

    // Restore (or auto-scroll) the messages container.
    const newMessages = rootEl.querySelector('.messages');
    if (newMessages) {
      if (prevWasNearBottom) {
        newMessages.scrollTop = newMessages.scrollHeight;
      } else {
        newMessages.scrollTop = prevScrollTop;
      }
    }

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
