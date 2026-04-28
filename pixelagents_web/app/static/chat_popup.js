// chat_popup.js
// ────────────────────────────────────────────────────────────────────
// Drives the standalone chat-popup window. Loaded by /chat-popup,
// which injects window.__CHAT_POPUP_CONFIG = {kind, id, me, token, header}.
//
// Two modes:
//   - kind="agent" — uses the streaming chat path (SSE deltas + tool
//     call notifications + typing indicator while waiting on the first
//     delta), GET /api/agents/{slug}/messages for hydration.
//   - kind="human" — uses POST /api/messages/{email} (no streaming)
//     and GET /api/messages/{email} for hydration. Polls every 3s
//     while the window is open so peer messages appear without manual
//     refresh.
//
// The window is independent of the main /live page — close it and
// the main page is unaffected; multiple popups can be open at once
// for different agents/humans.

(function () {
  'use strict';

  const CFG = window.__CHAT_POPUP_CONFIG || {};
  if (!CFG.kind || !CFG.id) {
    document.body.innerHTML = '<p style="padding:24px;color:#991b1b;">Missing chat-popup config — open via the Live Agent View sidebar.</p>';
    return;
  }

  const POLL_MS = 3000;

  // ── Styles ──────────────────────────────────────────────────────────
  const css = `
    body { background: #f9fafb; }
    header.popup-header {
      flex-shrink: 0;
      padding: 12px 18px;
      background: #0099cc;
      color: #ffffff;
      font-weight: 700;
      font-size: 15px;
      letter-spacing: 0.02em;
      border-bottom: 1px solid #cbd5e1;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    header.popup-header .sub {
      flex: 1;
      font-size: 11px;
      font-weight: 500;
      opacity: 0.85;
      text-transform: none;
    }
    .messages {
      flex: 1; min-height: 0;
      overflow-y: auto;
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 6px;
    }
    .msg {
      max-width: 88%;
      padding: 8px 12px;
      border-radius: 8px;
      white-space: pre-wrap;
      word-wrap: break-word;
      font-size: 14px;
      line-height: 1.45;
    }
    .msg.user      { align-self: flex-end;   background: #e0f2fe; border: 1px solid #0099cc; }
    .msg.assistant { align-self: flex-start; background: #ffffff; border: 1px solid #cbd5e1; }
    .msg.error     { align-self: flex-start; background: rgba(239,68,68,0.10); border: 1px solid rgba(239,68,68,0.5); color: #991b1b; }
    .msg .ts {
      margin-top: 4px;
      font-size: 10px;
      opacity: 0.6;
    }
    .msg.assistant.typing {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 10px 12px;
      min-height: 18px;
    }
    .msg.assistant.typing .dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: #6b7280;
      opacity: 0.35;
      animation: chat-typing 1.2s ease-in-out infinite;
    }
    .msg.assistant.typing .dot:nth-child(2) { animation-delay: 0.15s; }
    .msg.assistant.typing .dot:nth-child(3) { animation-delay: 0.30s; }
    @keyframes chat-typing {
      0%, 80%, 100% { opacity: 0.35; transform: translateY(0); }
      40%           { opacity: 1;    transform: translateY(-2px); }
    }
    .empty {
      color: #6b7280;
      font-style: italic;
      font-size: 13px;
      text-align: center;
      padding: 32px 16px;
    }
    .compose {
      flex-shrink: 0;
      display: flex;
      gap: 8px;
      padding: 10px 16px 14px;
      border-top: 1px solid #e5e7eb;
      background: #ffffff;
    }
    .compose textarea {
      flex: 1;
      resize: none;
      padding: 8px 10px;
      border: 1px solid #cbd5e1;
      border-radius: 4px;
      font: inherit;
      min-height: 40px;
      max-height: 140px;
      box-sizing: border-box;
    }
    .compose textarea:focus {
      outline: none;
      border-color: #0099cc;
      box-shadow: 0 0 0 3px rgba(0,153,204,0.18);
    }
    .compose button {
      padding: 0 16px;
      border: none;
      border-radius: 4px;
      background: #0099cc;
      color: #ffffff;
      font-weight: 700;
      cursor: pointer;
    }
    .compose button:hover:not(:disabled) { background: #33b0dd; }
    .compose button:disabled {
      background: #cbd5e1;
      cursor: not-allowed;
    }
    .err-line {
      margin: 6px 16px 0;
      padding: 6px 8px;
      background: rgba(239,68,68,0.10);
      color: #991b1b;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      border-radius: 4px;
    }
    .tool-hint {
      margin-top: 4px;
      font-size: 11px;
      opacity: 0.7;
      font-family: ui-monospace, Menlo, monospace;
    }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ── State ─────────────────────────────────────────────────────────
  // Each message in the popup: {role, text, toolCalls?, streaming?, error?, ts?}.
  // Same shape as agent_comm.js so the rendering code is symmetrical.
  let messages = [];
  let sending = false;
  let composeDraft = '';
  let composeError = '';

  // ── DOM scaffold ──────────────────────────────────────────────────
  const headerEl = document.createElement('header');
  headerEl.className = 'popup-header';
  const subLabel = CFG.kind === 'agent' ? 'agent' : 'human';
  headerEl.innerHTML = `<span>${escapeHtml(CFG.header)}</span><span class="sub">${escapeHtml(subLabel)}</span>`;
  document.body.appendChild(headerEl);

  const messagesEl = document.createElement('div');
  messagesEl.className = 'messages';
  document.body.appendChild(messagesEl);

  const errEl = document.createElement('div');
  errEl.style.display = 'none';
  document.body.appendChild(errEl);

  const composeForm = document.createElement('form');
  composeForm.className = 'compose';
  composeForm.innerHTML = `
    <textarea id="compose-ta" placeholder="Message ${escapeHtml(CFG.header)}…"></textarea>
    <button id="compose-send" type="submit">Send</button>
  `;
  document.body.appendChild(composeForm);
  const taEl = composeForm.querySelector('textarea');
  const sendBtn = composeForm.querySelector('button');

  taEl.addEventListener('input', () => { composeDraft = taEl.value; });
  taEl.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      onSend();
    }
  });
  composeForm.addEventListener('submit', (ev) => {
    ev.preventDefault();
    onSend();
  });

  // ── Helpers ───────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function authHeaders() {
    return CFG.token ? { 'x-pixelagents-token': CFG.token } : {};
  }

  function fmtTime(ts) {
    if (!ts) return '';
    const d = new Date(ts * 1000);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function isAtBottom(el) {
    return (el.scrollHeight - el.scrollTop - el.clientHeight) < 30;
  }

  // ── Render ────────────────────────────────────────────────────────
  function render() {
    const wasAtBottom = isAtBottom(messagesEl);

    if (!messages.length) {
      messagesEl.innerHTML = `<div class="empty">No messages yet — say hi.</div>`;
    } else {
      let html = '';
      for (const m of messages) {
        const tools = (m.toolCalls && m.toolCalls.length)
          ? `<div class="tool-hint">🔧 ${m.toolCalls.map((t) => escapeHtml(t.name || '')).join(', ')}</div>`
          : '';
        if (m.streaming && !(m.text || '').length && !m.error) {
          html += `<div class="msg assistant typing" aria-label="Agent is typing">`
                + `<span class="dot"></span><span class="dot"></span><span class="dot"></span>`
                + `${tools}</div>`;
          continue;
        }
        const cls = m.error ? 'msg error' : `msg ${m.role}`;
        const tsLine = m.ts ? `<div class="ts">${escapeHtml(fmtTime(m.ts))}</div>` : '';
        html += `<div class="${cls}">${escapeHtml(m.text || '')}${tools}${tsLine}</div>`;
      }
      messagesEl.innerHTML = html;
    }

    if (composeError) {
      errEl.className = 'err-line';
      errEl.textContent = composeError;
      errEl.style.display = '';
    } else {
      errEl.style.display = 'none';
    }

    sendBtn.disabled = sending;
    taEl.disabled = sending;

    if (wasAtBottom) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }
  }

  // ── Hydration / polling ──────────────────────────────────────────
  function convertServerMessage(m) {
    if (!m) return null;
    if (CFG.kind === 'agent') {
      const out = { role: m.role || 'assistant', text: m.text || '', ts: m.started_at || m.ts };
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        out.toolCalls = m.tool_calls.map((t) => ({ name: (t && t.name) || '' }));
      }
      if (m.status === 'streaming') out.streaming = true;
      if (m.status === 'failed') {
        out.error = true;
        if (!out.text) {
          let body = m.error || 'stream failed';
          try {
            const parsed = JSON.parse(body);
            body = typeof parsed === 'string' ? parsed : JSON.stringify(parsed);
          } catch (_) { /* keep raw */ }
          out.text = `Error: ${body}`;
        }
      }
      return out;
    }
    // human DM
    return {
      role: m.from === CFG.me ? 'user' : 'assistant',
      text: m.text || '',
      ts: m.ts,
    };
  }

  async function hydrate() {
    try {
      const url = CFG.kind === 'agent'
        ? `/api/agents/${encodeURIComponent(CFG.id)}/messages`
        : `/api/messages/${encodeURIComponent(CFG.id)}`;
      const r = await fetch(url, { credentials: 'same-origin', headers: authHeaders() });
      if (!r.ok) return;
      const data = await r.json();
      const list = (data && data.messages) || [];
      const fresh = list.map(convertServerMessage).filter(Boolean);
      // If a send is currently in flight (streaming), DON'T clobber —
      // the in-flight message is owned by the SSE handler.
      if (!sending) {
        messages = fresh;
        render();
      }
      // If the agent has a streaming message server-side and we're
      // not actively sending, schedule a quick re-poll until it lands.
      const stillStreaming = fresh.some((m) => m.streaming);
      if (stillStreaming && !sending) {
        setTimeout(hydrate, 1500);
      }
    } catch (_) { /* ignore */ }
  }

  // ── Send ──────────────────────────────────────────────────────────
  async function onSend() {
    if (sending) return;
    const text = (composeDraft || '').trim();
    if (!text) return;

    composeError = '';
    sending = true;

    if (CFG.kind === 'agent') {
      // Streaming SSE path — same as agent_comm.js's onChatSend.
      messages.push({ role: 'user', text, ts: Date.now() / 1000 });
      const idx = messages.length;
      messages.push({ role: 'assistant', text: '', streaming: true });
      composeDraft = '';
      taEl.value = '';
      render();

      try {
        const r = await fetch(
          `/api/agents/${encodeURIComponent(CFG.id)}/message/stream`,
          {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...authHeaders() },
            body: JSON.stringify({ message: text }),
          },
        );
        if (!r.ok || !r.body) {
          const errText = await r.text().catch(() => '');
          throw new Error(`HTTP ${r.status}: ${errText.slice(0, 200)}`);
        }
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const blocks = buf.split('\n\n');
          buf = blocks.pop() || '';
          for (const block of blocks) handleSseBlock(block, idx);
          render();
        }
        if (buf.trim()) handleSseBlock(buf, idx);
        const m = messages[idx];
        if (m) m.streaming = false;
      } catch (e) {
        const m = messages[idx];
        if (m) {
          m.error = true;
          m.text = (m.text || '') + `\n${e.message || e}`;
          m.streaming = false;
        }
        composeError = String(e.message || e);
      } finally {
        sending = false;
        render();
      }
      return;
    }

    // Human DM — plain POST + optimistic append.
    const optimistic = {
      role: 'user',
      text,
      ts: Date.now() / 1000,
    };
    messages.push(optimistic);
    composeDraft = '';
    taEl.value = '';
    render();

    try {
      const r = await fetch(
        `/api/messages/${encodeURIComponent(CFG.id)}`,
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
      // Re-hydrate so the optimistic local-temp record is replaced
      // with the real persisted one.
      await hydrate();
    } catch (e) {
      // Roll back the optimistic append + re-fill the textarea.
      messages = messages.filter((m) => m !== optimistic);
      composeDraft = text;
      taEl.value = text;
      composeError = String(e.message || e);
    } finally {
      sending = false;
      render();
    }
  }

  function handleSseBlock(block, assistantIdx) {
    let event = 'message', dataLines = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    const raw = dataLines.join('\n');
    let data;
    try { data = JSON.parse(raw); } catch (_) { return; }
    const m = messages[assistantIdx];
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

  // Kick things off.
  hydrate();
  setInterval(() => { if (!sending) hydrate(); }, POLL_MS);
  taEl.focus();
})();
