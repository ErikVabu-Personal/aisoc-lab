/*
 * AISOC human-in-the-loop panel.
 *
 * When a Foundry agent invokes the runner's ask_human tool, the runner
 * POSTs the question to /api/hitl/questions and long-polls /api/hitl/wait
 * until an answer arrives (or a short timeout lapses). This panel is the
 * other side of that handshake:
 *
 *   - Polls /api/hitl/pending every 2s.
 *   - Shows a prominent top-center card for each pending question with
 *     a reply box.
 *   - On submit, POSTs to /api/hitl/answer/{id}; the runner sees the
 *     answer on its next long-poll iteration and returns it to the agent.
 *
 * Hidden entirely when no questions are pending, so it stays out of the
 * way during normal operation.
 */

(function () {
  'use strict';

  const cfg = window.__PIXELAGENTS_CHAT || {};
  const TOKEN = cfg.token || '';

  if (!TOKEN) {
    console.warn('[hitl-panel] no token injected; panel disabled.');
    return;
  }

  // ── State ────────────────────────────────────────────────────────────────
  const state = {
    questions: [],           // pending only, oldest-first
    drafts: {},              // { [qid]: current reply text }
    submitting: {},          // { [qid]: true while POST in flight }
    errors: {},              // { [qid]: error message from a failed submit }
  };

  // ── Root DOM ─────────────────────────────────────────────────────────────
  const rootId = 'aisoc-hitl-panel-root';
  let rootEl = document.getElementById(rootId);
  if (!rootEl) {
    rootEl = document.createElement('div');
    rootEl.id = rootId;
    document.body.appendChild(rootEl);
  }

  // ── Styles ───────────────────────────────────────────────────────────────
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    #${rootId} {
      position: fixed;
      top: 16px;
      left: 50%;
      transform: translateX(-50%);
      width: min(620px, calc(100vw - 520px - 48px));
      max-width: 620px;
      z-index: 9998;
      display: flex;
      flex-direction: column;
      gap: 10px;
      pointer-events: none; /* wrapper doesn't catch clicks when empty */
    }
    #${rootId}[data-empty="true"] {
      display: none;
    }
    #${rootId} .card {
      pointer-events: auto;
      background: rgba(10, 12, 18, 0.9);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border: 1px solid rgba(250, 204, 21, 0.45);
      border-radius: 8px;
      box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55);
      color: #e7e9ee;
      font-size: 18px;
      line-height: 1.4;
      overflow: hidden;
      animation: aisoc-hitl-pulse 2.4s ease-in-out infinite;
    }
    @keyframes aisoc-hitl-pulse {
      0%, 100% { box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55), 0 0 0 0 rgba(250, 204, 21, 0.0); }
      50%      { box-shadow: 0 12px 40px rgba(0, 0, 0, 0.55), 0 0 0 6px rgba(250, 204, 21, 0.22); }
    }
    #${rootId} .card .head {
      padding: 10px 14px;
      background: rgba(250, 204, 21, 0.12);
      border-bottom: 1px solid rgba(250, 204, 21, 0.25);
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 600;
      color: #fde68a;
    }
    #${rootId} .card .head .who {
      text-transform: capitalize;
    }
    #${rootId} .card .head .meta {
      margin-left: auto;
      opacity: 0.6;
      font-size: 14px;
      font-weight: 400;
    }
    #${rootId} .card .body {
      padding: 12px 14px 14px 14px;
    }
    #${rootId} .card .q {
      white-space: pre-wrap;
      word-wrap: break-word;
      margin-bottom: 10px;
    }
    #${rootId} .card .compose {
      display: flex;
      gap: 8px;
    }
    #${rootId} .card textarea {
      flex: 1;
      resize: none;
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 4px;
      color: #e7e9ee;
      padding: 8px 10px;
      font: inherit;
      min-height: 48px;
      max-height: 160px;
    }
    #${rootId} .card textarea:focus {
      outline: none;
      border-color: rgba(250, 204, 21, 0.6);
    }
    #${rootId} .card button {
      background: rgba(250, 204, 21, 0.25);
      border: 1px solid rgba(250, 204, 21, 0.55);
      color: #fde68a;
      border-radius: 4px;
      padding: 0 16px;
      cursor: pointer;
      font: inherit;
      font-weight: 600;
    }
    #${rootId} .card button:hover:not(:disabled) {
      background: rgba(250, 204, 21, 0.4);
    }
    #${rootId} .card button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    #${rootId} .card .err {
      margin-top: 8px;
      padding: 6px 10px;
      background: rgba(239, 68, 68, 0.18);
      border: 1px solid rgba(239, 68, 68, 0.4);
      color: #fecaca;
      border-radius: 4px;
      font-size: 13px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      white-space: pre-wrap;
    }
  `;
  document.head.appendChild(styleEl);

  // ── Helpers ──────────────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function ageLabel(askedAt) {
    if (!askedAt) return '';
    const sec = Math.max(0, (Date.now() / 1000) - askedAt);
    if (sec < 60) return `${Math.floor(sec)}s ago`;
    return `${Math.floor(sec / 60)}m ${Math.floor(sec % 60)}s ago`;
  }

  // ── Data ─────────────────────────────────────────────────────────────────
  async function loadPending() {
    try {
      const res = await fetch('/api/hitl/pending', {
        headers: { 'x-pixelagents-token': TOKEN },
      });
      if (!res.ok) return;
      const data = await res.json();
      state.questions = data.questions || [];

      // Drop drafts / errors for questions that no longer exist so we
      // don't leak memory as the demo runs.
      const liveIds = new Set(state.questions.map((q) => q.id));
      for (const qid of Object.keys(state.drafts)) {
        if (!liveIds.has(qid)) delete state.drafts[qid];
      }
      for (const qid of Object.keys(state.errors)) {
        if (!liveIds.has(qid)) delete state.errors[qid];
      }
      render();
    } catch (e) {
      // ignore transient failures; next tick will try again
    }
  }

  async function submitAnswer(qid) {
    const textarea = rootEl.querySelector(
      `textarea[data-qid="${CSS.escape(qid)}"]`,
    );
    if (!textarea) return;
    const answer = (textarea.value || '').trim();
    if (!answer) return;

    state.submitting[qid] = true;
    state.errors[qid] = null;
    render();

    try {
      const res = await fetch(`/api/hitl/answer/${encodeURIComponent(qid)}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-pixelagents-token': TOKEN,
        },
        body: JSON.stringify({ answer }),
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
      // On success, the question will disappear from the next
      // /api/hitl/pending response. Clear the draft right away.
      delete state.drafts[qid];
      delete state.errors[qid];
      loadPending();
    } catch (e) {
      state.errors[qid] = e && e.message ? e.message : String(e);
    } finally {
      delete state.submitting[qid];
      render();
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────
  function render() {
    // Capture any in-flight composer state (value + caret + focus) for each
    // textarea so the 2-second poll doesn't wipe what the user is typing.
    const captured = {};
    rootEl.querySelectorAll('textarea[data-qid]').forEach((t) => {
      const qid = t.getAttribute('data-qid');
      captured[qid] = {
        value: t.value,
        selectionStart: t.selectionStart || 0,
        selectionEnd: t.selectionEnd || 0,
        hadFocus: document.activeElement === t,
      };
      // Promote the live value into state so subsequent renders pick it up.
      state.drafts[qid] = t.value;
    });

    if (!state.questions.length) {
      rootEl.setAttribute('data-empty', 'true');
      rootEl.innerHTML = '';
      return;
    }
    rootEl.removeAttribute('data-empty');

    const cards = state.questions
      .map((q) => {
        const display = q.agent_display || q.agent || 'agent';
        const draft = state.drafts[q.id] || '';
        const isSubmitting = !!state.submitting[q.id];
        const err = state.errors[q.id];
        const errHtml = err
          ? `<div class="err">${escapeHtml(err)}</div>`
          : '';
        return `
          <div class="card" data-qid="${escapeHtml(q.id)}">
            <div class="head">
              <span>🙋</span>
              <span class="who">${escapeHtml(display)} needs your input</span>
              <span class="meta">${escapeHtml(ageLabel(q.asked_at))}</span>
            </div>
            <div class="body">
              <div class="q">${escapeHtml(q.question)}</div>
              <div class="compose">
                <textarea
                  data-qid="${escapeHtml(q.id)}"
                  placeholder="Type your answer…"
                  ${isSubmitting ? 'disabled' : ''}
                >${escapeHtml(draft)}</textarea>
                <button
                  data-action="submit"
                  data-qid="${escapeHtml(q.id)}"
                  ${isSubmitting ? 'disabled' : ''}
                >${isSubmitting ? 'Sending…' : 'Send'}</button>
              </div>
              ${errHtml}
            </div>
          </div>
        `;
      })
      .join('');

    rootEl.innerHTML = cards;

    // Restore composer state.
    rootEl.querySelectorAll('textarea[data-qid]').forEach((t) => {
      const qid = t.getAttribute('data-qid');
      const cap = captured[qid];
      if (!cap) {
        // First render of this card: focus it so the user can type immediately.
        if (!document.activeElement || document.activeElement === document.body) {
          t.focus();
        }
        return;
      }
      t.value = cap.value;
      if (cap.hadFocus) {
        t.focus();
        try {
          t.setSelectionRange(cap.selectionStart, cap.selectionEnd);
        } catch (_) {}
      }
    });
  }

  // ── Events ───────────────────────────────────────────────────────────────
  rootEl.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-action="submit"]');
    if (!t || t.disabled) return;
    const qid = t.getAttribute('data-qid');
    if (qid) submitAnswer(qid);
  });

  rootEl.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' || ev.shiftKey) return;
    const t = ev.target.closest('textarea[data-qid]');
    if (!t) return;
    ev.preventDefault();
    const qid = t.getAttribute('data-qid');
    if (qid) submitAnswer(qid);
  });

  rootEl.addEventListener('input', (ev) => {
    const t = ev.target.closest('textarea[data-qid]');
    if (!t) return;
    const qid = t.getAttribute('data-qid');
    if (qid) state.drafts[qid] = t.value;
  });

  // ── Boot ─────────────────────────────────────────────────────────────────
  render();
  loadPending();
  // Poll frequently enough that a new question shows up within a second
  // or two of the runner posting it.
  setInterval(loadPending, 2000);
})();
