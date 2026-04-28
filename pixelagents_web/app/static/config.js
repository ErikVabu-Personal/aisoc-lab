// config.js
// ────────────────────────────────────────────────────────────────────
// Renders agent telemetry as human-readable cards with a per-card
// "Show raw JSON" toggle. Backed by /api/agents/state.

(function () {
  'use strict';

  const ROOT_ID = 'aisoc-config-root';
  const POLL_MS = 4000;

  const css = `
    #${ROOT_ID} { font: 14px -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
    #${ROOT_ID} .agents {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(360px, 1fr));
      gap: 16px;
    }
    #${ROOT_ID} .card {
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 18px 20px;
    }
    #${ROOT_ID} .card .head {
      display: flex; align-items: center; gap: 10px;
      margin-bottom: 12px;
    }
    #${ROOT_ID} .card .name {
      flex: 1;
      font-size: 16px; font-weight: 700;
      color: #1f2937;
      text-transform: capitalize;
    }
    #${ROOT_ID} .card .dot {
      width: 10px; height: 10px; border-radius: 50%;
      background: #9ca3af;
      flex-shrink: 0;
    }
    /* Coherent agent palette across config + sidebar:
         .idle    = online, not working   -> solid green
         .reading = actively working      -> pulsing blue
         .error   = something went wrong  -> red                        */
    #${ROOT_ID} .card .dot.idle {
      background: #10b981;
    }
    #${ROOT_ID} .card .dot.reading {
      background: #0099cc;
      box-shadow: 0 0 0 0 rgba(0,153,204,0.55);
      animation: aisoc-config-active-pulse 1.6s ease-out infinite;
    }
    @keyframes aisoc-config-active-pulse {
      0%   { box-shadow: 0 0 0 0 rgba(0,153,204,0.55); }
      70%  { box-shadow: 0 0 0 8px rgba(0,153,204,0);  }
      100% { box-shadow: 0 0 0 0 rgba(0,153,204,0);  }
    }
    #${ROOT_ID} .card .dot.error  { background: #ef4444; }
    #${ROOT_ID} .card .pill {
      font-size: 11px; font-weight: 700;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      padding: 3px 8px;
      border-radius: 999px;
      color: #6b7280;
      background: #f3f4f6;
    }
    /* Pills mirror the dot palette: idle=green, reading=blue, error=red. */
    #${ROOT_ID} .card .pill.idle    { color: #065f46; background: rgba(16,185,129,0.16); }
    #${ROOT_ID} .card .pill.reading { color: #1e3a8a; background: rgba(0,153,204,0.16); }
    #${ROOT_ID} .card .pill.error   { color: #991b1b; background: rgba(239,68,68,0.16); }

    #${ROOT_ID} .card dl {
      margin: 0;
      display: grid;
      grid-template-columns: max-content 1fr;
      column-gap: 14px; row-gap: 6px;
    }
    #${ROOT_ID} .card dt {
      color: #6b7280;
      font-size: 12px; font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      align-self: center;
    }
    #${ROOT_ID} .card dd {
      margin: 0;
      color: #1f2937;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 13px;
      word-break: break-word;
    }
    #${ROOT_ID} .card dd.muted { color: #9ca3af; font-style: italic; font-family: inherit; }

    #${ROOT_ID} .card .toggle {
      display: flex;
      justify-content: flex-end;
      margin-top: 14px;
    }
    #${ROOT_ID} .card .toggle button {
      background: transparent;
      border: 1px solid #cbd5e1;
      color: #0099cc;
      font-weight: 600;
      font-size: 12px;
      padding: 4px 10px;
      border-radius: 4px;
      cursor: pointer;
    }
    #${ROOT_ID} .card .toggle button:hover {
      background: #f0f9ff;
      border-color: #0099cc;
    }
    #${ROOT_ID} .card pre {
      margin: 12px 0 0;
      padding: 12px;
      background: #f9fafb;
      border: 1px solid #e5e7eb;
      border-radius: 6px;
      font-size: 12px;
      line-height: 1.4;
      overflow-x: auto;
      max-height: 320px;
    }
    /* Instructions panel — same shell as raw-JSON pre, but the body is
       prose (markdown source) so use a system stack and let it wrap. */
    #${ROOT_ID} .card pre.instr {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      font-size: 13px;
      line-height: 1.5;
      color: #1f2937;
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 480px;
    }
    /* Editable variant of the instructions panel. Shares the wrapped-
       prose look of pre.instr but allows resize and accepts input. */
    #${ROOT_ID} .card textarea.instr-edit {
      width: 100%;
      box-sizing: border-box;
      margin: 12px 0 0;
      padding: 12px;
      background: #ffffff;
      border: 1px solid #cbd5e1;
      border-radius: 6px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      font-size: 13px;
      line-height: 1.5;
      color: #1f2937;
      resize: vertical;
      min-height: 200px;
      max-height: 600px;
    }
    #${ROOT_ID} .card textarea.instr-edit:focus {
      outline: none;
      border-color: #0099cc;
      box-shadow: 0 0 0 3px rgba(0,153,204,0.18);
    }
    #${ROOT_ID} .card .instr-actions {
      display: flex;
      gap: 8px;
      margin-top: 10px;
      align-items: center;
      flex-wrap: wrap;
    }
    #${ROOT_ID} .card .instr-actions button.save {
      background: #0099cc;
      color: #ffffff;
      border: 1px solid #0099cc;
    }
    #${ROOT_ID} .card .instr-actions button.save:hover:not(:disabled) {
      background: #33b0dd;
    }
    #${ROOT_ID} .card .instr-actions button.save:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
    #${ROOT_ID} .card .instr-status {
      font-size: 12px;
      flex: 1;
    }
    #${ROOT_ID} .card .instr-status.saving { color: #6b7280; font-style: italic; }
    #${ROOT_ID} .card .instr-status.ok     { color: #065f46; }
    #${ROOT_ID} .card .instr-status.error  {
      color: #991b1b;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      white-space: pre-wrap;
      word-break: break-word;
    }

    #${ROOT_ID} .empty,
    #${ROOT_ID} .err {
      padding: 24px;
      text-align: center;
      color: #6b7280;
      font-style: italic;
    }
    #${ROOT_ID} .err {
      color: #991b1b; font-style: normal;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 13px;
    }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const root = document.getElementById(ROOT_ID);
  if (!root) return;

  // Track which agent cards have raw JSON expanded across re-renders.
  const expanded = new Set();
  // Track which agent cards have role-specific instructions expanded.
  const expandedInstructions = new Set();
  // Track which agent cards are in INSTRUCTION-EDIT mode (mutually
  // exclusive with the read-only expanded state — entering edit mode
  // implies expanded).
  const editingInstructions = new Set();
  // {agent_name: draft_text} — preserved across renders so a user's
  // typing doesn't get clobbered by the 60s background re-fetch.
  const editDrafts = {};
  // {agent_name: {state: 'saving'|'ok'|'error', message: str}} — most
  // recent save outcome, surfaced in the panel.
  const editStatus = {};
  // {slug: instructions_text} populated by fetchInstructions(); used by
  // both renderAgent (per-agent expander) and the Generic card IIFE.
  let agentInstructions = {};

  // ── Generic instructions card state ────────────────────────────────
  // These are referenced by renderGenericInstructions() which is
  // (transitively) called from the top-level setup code further down.
  // `let` bindings sit in the temporal dead zone until their
  // declaration is reached, so they MUST be declared before the
  // setup call — moving them here avoids "Cannot access 'giLoadedAt'
  // before initialization" at module load.
  let giOpen = false;
  let giCommon = '';
  let giError = '';
  let giLoadedAt = 0;
  // Editing the shared preamble (fans out to all four agents).
  let giEditing = false;
  let giDraft = null;
  // {state: 'saving'|'ok'|'error', message: str,
  //  perAgent?: {slug: 'pending'|'ok'|'error'}}
  let giSaveStatus = null;

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function fmtTs(t) {
    if (t == null || !Number(t)) return null;
    const d = new Date(Number(t) * 1000);
    return d.toLocaleString();
  }

  function fmtAgo(t) {
    if (t == null || !Number(t)) return null;
    const sec = Math.floor(Date.now() / 1000) - Number(t);
    if (sec < 0)   return 'just now';
    if (sec < 60)  return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
  }

  // /api/agents/state returns each agent as
  //   {id, status, tool_name, last_start_ts, last_event_type, ...}
  // — wrap so the rest of this file can keep using readable accessors.
  function statusOf(a) { return (a && a.status) || 'idle'; }
  function nameOf(a)   { return (a && (a.id || a.agent)) || '?'; }

  function renderAgent(a) {
    const name = String(nameOf(a));
    const status = statusOf(a);
    const lastEvent = a.last_event_type || '—';
    const lastStart = a.last_start_ts ? `${fmtTs(a.last_start_ts)} (${fmtAgo(a.last_start_ts)})` : null;
    const toolName = a.tool_name || null;
    const showRaw = expanded.has(name);

    let html = '<div class="card">';
    html += '<div class="head">';
    html += `<span class="dot ${status}"></span>`;
    html += `<span class="name">${escapeHtml(name)}</span>`;
    html += `<span class="pill ${status}">${escapeHtml(status)}</span>`;
    html += '</div>';

    html += '<dl>';
    html += `<dt>Last event</dt><dd>${escapeHtml(lastEvent)}</dd>`;
    html += `<dt>Last start</dt>`;
    html += lastStart ? `<dd>${escapeHtml(lastStart)}</dd>` : '<dd class="muted">never</dd>';
    if (toolName) {
      html += `<dt>Tool name</dt><dd>${escapeHtml(toolName)}</dd>`;
    }
    if (a.message) {
      html += `<dt>Message</dt><dd>${escapeHtml(a.message)}</dd>`;
    }
    html += '</dl>';

    const showInstr = expandedInstructions.has(name);
    const editing = editingInstructions.has(name);
    const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const instr = agentInstructions[slug];
    const hasInstr = typeof instr === 'string' && instr.length > 0;
    // (`status` is already in scope above as the agent's lifecycle
    // state from /api/agents/state — use a distinct name here.)
    const editState = editStatus[name];

    html += '<div class="toggle">';
    if (hasInstr || agentInstructions.__loaded) {
      const label = hasInstr
        ? (showInstr ? 'Hide instructions' : 'Show instructions')
        : 'No instructions';
      const disabled = hasInstr ? '' : 'disabled';
      html += `<button data-instr="${escapeHtml(name)}" ${disabled}>${label}</button>`;
      // Edit button only shows when the panel is expanded AND we have
      // content AND we're not already editing.
      if (showInstr && hasInstr && !editing) {
        html += `<button data-instr-edit="${escapeHtml(name)}">Edit</button>`;
      }
    }
    html += `<button data-agent="${escapeHtml(name)}">${showRaw ? 'Hide raw JSON' : 'Show raw JSON'}</button>`;
    html += '</div>';

    if (showInstr && editing) {
      // Editor — pre-fill the textarea with the current draft (which
      // defaults to the role-tail content the user is editing).
      const draft = editDrafts[name] != null ? editDrafts[name] : (instr || '');
      const saving = editState && editState.state === 'saving';
      const statusCls = editState ? editState.state : '';
      const statusMsg = editState ? editState.message : '';
      html += `<textarea class="instr-edit" data-instr-textarea="${escapeHtml(name)}" `
            + `${saving ? 'disabled' : ''}>${escapeHtml(draft)}</textarea>`;
      html += '<div class="instr-actions">';
      html += `<button class="save" data-instr-save="${escapeHtml(name)}" `
            + `${saving ? 'disabled' : ''}>${saving ? 'Saving…' : 'Save'}</button>`;
      html += `<button data-instr-cancel="${escapeHtml(name)}" `
            + `${saving ? 'disabled' : ''}>Cancel</button>`;
      if (statusMsg) {
        html += `<span class="instr-status ${escapeHtml(statusCls)}">${escapeHtml(statusMsg)}</span>`;
      } else {
        html += `<span class="instr-status" style="color:#6b7280">`
              + `Editing the role-specific tail (the shared preamble is preserved)</span>`;
      }
      html += '</div>';
    } else if (showInstr && hasInstr) {
      html += `<pre class="instr">${escapeHtml(instr)}</pre>`;
      // Surface the most recent save outcome below the read-only view
      // (e.g. "Saved version 2" stays visible after the editor closes).
      if (editState && editState.state === 'ok') {
        html += `<div class="instr-status ok" style="margin-top:8px;font-size:12px;">`
              + `${escapeHtml(editState.message)}</div>`;
      }
    }
    if (showRaw) {
      html += `<pre>${escapeHtml(JSON.stringify(a, null, 2))}</pre>`;
    }
    html += '</div>';
    return html;
  }

  function render(agents) {
    if (!agents || !agents.length) {
      root.innerHTML = '<div class="empty">No agents reporting yet. Run a workflow to populate this page.</div>';
      return;
    }

    // ── Preserve focus + selection across re-renders ────────────────
    // The /api/agents/state poll fires every 4s and the instructions
    // background fetch fires every 60s; both call render() which does
    // an innerHTML wipe and would otherwise yank focus out of any
    // open instructions-edit textarea mid-typing.
    const active = document.activeElement;
    let focusKey = null;
    let selStart = 0;
    let selEnd = 0;
    let scrollTop = 0;
    if (active && active.tagName === 'TEXTAREA') {
      focusKey = active.getAttribute('data-instr-textarea');
      if (focusKey) {
        try { selStart = active.selectionStart; selEnd = active.selectionEnd; } catch (_) {}
        scrollTop = active.scrollTop;
      }
    }

    let body = '<div class="agents">';
    for (const a of agents) body += renderAgent(a);
    body += '</div>';
    root.innerHTML = body;

    if (focusKey) {
      const sel = `textarea[data-instr-textarea="${focusKey.replace(/"/g, '\\"')}"]`;
      const ta = root.querySelector(sel);
      if (ta) {
        try {
          ta.focus({ preventScroll: true });
          ta.setSelectionRange(selStart, selEnd);
          ta.scrollTop = scrollTop;
        } catch (_) { /* best-effort */ }
      }
    }

    root.querySelectorAll('.card .toggle button[data-agent]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const n = btn.dataset.agent;
        if (expanded.has(n)) expanded.delete(n);
        else expanded.add(n);
        render(window.__AISOC_AGENTS_LAST || []);
      });
    });
    root.querySelectorAll('.card .toggle button[data-instr]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const n = btn.dataset.instr;
        if (expandedInstructions.has(n)) {
          expandedInstructions.delete(n);
          // Closing the panel also exits edit mode and forgets the
          // draft — reasonable demo-grade behaviour.
          editingInstructions.delete(n);
          delete editDrafts[n];
        } else {
          expandedInstructions.add(n);
        }
        render(window.__AISOC_AGENTS_LAST || []);
      });
    });
    root.querySelectorAll('.card .toggle button[data-instr-edit]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const n = btn.dataset.instrEdit;
        editingInstructions.add(n);
        // Seed the draft with the current role-tail content.
        const slug = String(n).toLowerCase().replace(/[^a-z0-9]+/g, '-');
        if (editDrafts[n] == null) {
          editDrafts[n] = agentInstructions[slug] || '';
        }
        // Clear any previous status when entering a fresh edit session.
        delete editStatus[n];
        render(window.__AISOC_AGENTS_LAST || []);
      });
    });
    root.querySelectorAll('[data-instr-textarea]').forEach((ta) => {
      ta.addEventListener('input', () => {
        editDrafts[ta.getAttribute('data-instr-textarea')] = ta.value;
      });
    });
    root.querySelectorAll('[data-instr-cancel]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const n = btn.getAttribute('data-instr-cancel');
        editingInstructions.delete(n);
        delete editDrafts[n];
        delete editStatus[n];
        render(window.__AISOC_AGENTS_LAST || []);
      });
    });
    root.querySelectorAll('[data-instr-save]').forEach((btn) => {
      btn.addEventListener('click', () => {
        onInstructionsSave(btn.getAttribute('data-instr-save'));
      });
    });
  }

  // ── Save handler ───────────────────────────────────────────────────
  // Concatenates the shared common preamble with the user's edited
  // role-tail, then POSTs the FULL instructions blob to Foundry. The
  // server doesn't have to do any splitting — it just persists what
  // we send (preserving the agent's existing model + tools wiring).
  async function onInstructionsSave(name) {
    const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const draft = editDrafts[name] != null ? editDrafts[name] : '';
    if (!draft.trim()) {
      editStatus[name] = { state: 'error', message: 'Cannot save empty instructions' };
      render(window.__AISOC_AGENTS_LAST || []);
      return;
    }
    // Reconstruct the full instructions: common preamble (if any) +
    // blank-line separator + role tail. Matches the format the
    // Phase-2 deploy script writes.
    const fullInstructions = giCommon
      ? `${giCommon}\n\n${draft}`
      : draft;

    editStatus[name] = { state: 'saving', message: 'Saving to Foundry…' };
    render(window.__AISOC_AGENTS_LAST || []);

    try {
      const r = await fetch(
        `/api/foundry/agents/${encodeURIComponent(slug)}/instructions`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instructions: fullInstructions }),
        },
      );
      const respText = await r.text();
      let data;
      try { data = respText ? JSON.parse(respText) : {}; } catch (_) { data = { raw: respText }; }

      if (!r.ok) {
        // Server packs structured errors into data.detail. Pull a
        // readable message out of it.
        let msg = `HTTP ${r.status}`;
        const detail = data && data.detail;
        if (typeof detail === 'string') {
          msg = `${msg}: ${detail}`;
        } else if (detail && typeof detail === 'object') {
          msg = `${msg}: ${detail.error || ''}\n${detail.body || ''}`.trim();
        } else if (data && data.raw) {
          msg = `${msg}: ${data.raw.slice(0, 500)}`;
        }
        editStatus[name] = { state: 'error', message: msg };
        render(window.__AISOC_AGENTS_LAST || []);
        return;
      }

      const newVer = data && (data.new_version || data.agent);
      editStatus[name] = {
        state: 'ok',
        message: newVer ? `Saved (new version: ${newVer})` : 'Saved',
      };
      // Exit edit mode + drop the draft. Keep status visible — it'll
      // show under the refreshed read-only block.
      editingInstructions.delete(name);
      delete editDrafts[name];
      render(window.__AISOC_AGENTS_LAST || []);

      // Re-fetch instructions so the read-only view reflects the new
      // content. The server already busted its cache on POST, but
      // this is what populates agentInstructions client-side.
      fetchAgentInstructions();
    } catch (e) {
      editStatus[name] = {
        state: 'error',
        message: `Network error: ${e.message || e}`,
      };
      render(window.__AISOC_AGENTS_LAST || []);
    }
  }

  async function poll() {
    try {
      const r = await fetch('/api/agents/state', { credentials: 'same-origin' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      const agents = (data && data.agents) || [];
      window.__AISOC_AGENTS_LAST = agents;
      render(agents);
    } catch (e) {
      root.innerHTML = `<div class="err">Failed to load agents: ${escapeHtml(e.message || String(e))}</div>`;
    }
  }

  poll();
  setInterval(poll, POLL_MS);

  // ── Toggle widgets (auto-pickup + auto-close) ─────────────────────
  // Both render the same pill-switch card layout with their own polled
  // state from /api/auto_pickup or /api/auto_close. The matching read-
  // only badges on the Live Agent View are rendered by
  // auto_pickup_badge.js.
  injectToggleStyles();

  setupToggle({
    rootId: 'aisoc-auto-pickup-root',
    apiPath: '/api/auto_pickup',
    title: 'Automated alert pickup',
    desc:
      'When enabled, PixelAgents continuously monitors Microsoft Sentinel '
      + 'for new incidents and triggers the orchestration workflow '
      + 'automatically. If a workflow run fails, the incident is marked '
      + 'seen and <strong>not</strong> retried — the human analyst takes '
      + 'over from the dashboard.',
    renderState: (s) => {
      const intervalTxt = s.interval_sec ? `${Math.round(s.interval_sec)}s` : '—';
      const checkTxt = s.last_check_ts ? fmtAgoLocal(s.last_check_ts) : 'never';
      return (
        `Poll every ${escapeHtml(intervalTxt)} · last check ${escapeHtml(checkTxt)}`
        + ` · ${escapeHtml(String(s.seen_count || 0))} incident(s) seen`
      );
    },
  });

  setupToggle({
    rootId: 'aisoc-auto-close-root',
    apiPath: '/api/auto_close',
    title: 'Automated incident closure',
    desc:
      'When enabled, the reporter agent is permitted to close Sentinel '
      + 'incidents directly when its analysis is conclusive. When disabled '
      + '(default), every workflow run hands back to the human analyst — '
      + 'the agents <strong>cannot</strong> close incidents on their own.',
    renderState: () => 'Reporter closes incidents when confident',
  });

  // ── Generic instructions / context (read-only) ────────────────────
  // Renders the shared preamble (common.md, identical across all
  // agents) as a single card. Per-agent role-specific instructions are
  // rendered inline on each agent card via the "Show instructions"
  // toggle (see renderAgent).
  injectGenericInstructionsStyles();
  setupGenericInstructions();

  // Also kick off the fetch — populates `agentInstructions` so the
  // per-agent "Show instructions" buttons can light up.
  fetchAgentInstructions();
  setInterval(fetchAgentInstructions, 60000);

  // ── Generic instructions card ─────────────────────────────────────
  function injectGenericInstructionsStyles() {
    if (document.getElementById('aisoc-generic-instr-styles')) return;
    const css = `
      #aisoc-generic-instructions-root { margin-bottom: 16px; }
      #aisoc-generic-instructions-root .gi-card {
        background: #ffffff;
        border: 1px solid #e5e7eb;
        border-radius: 8px;
        padding: 16px 20px;
      }
      #aisoc-generic-instructions-root .gi-head {
        display: flex; align-items: baseline; gap: 12px;
        margin-bottom: 6px;
      }
      #aisoc-generic-instructions-root .gi-title {
        font-size: 15px; font-weight: 700; color: #1f2937;
      }
      #aisoc-generic-instructions-root .gi-sub {
        font-size: 12px; color: #6b7280; flex: 1;
      }
      #aisoc-generic-instructions-root .gi-toggle {
        background: transparent;
        border: 1px solid #cbd5e1;
        color: #0099cc;
        font-weight: 600;
        font-size: 12px;
        padding: 4px 10px;
        border-radius: 4px;
        cursor: pointer;
      }
      #aisoc-generic-instructions-root .gi-toggle:hover {
        background: #f0f9ff; border-color: #0099cc;
      }
      #aisoc-generic-instructions-root .gi-toggle:disabled {
        opacity: 0.5; cursor: not-allowed;
      }
      #aisoc-generic-instructions-root .gi-body {
        margin-top: 10px;
        padding: 12px;
        background: #f9fafb;
        border: 1px solid #e5e7eb;
        border-radius: 6px;
        font-size: 13px;
        line-height: 1.5;
        color: #1f2937;
        white-space: pre-wrap;
        word-break: break-word;
        max-height: 480px;
        overflow-y: auto;
      }
      #aisoc-generic-instructions-root .gi-empty {
        color: #6b7280; font-style: italic; font-size: 13px;
      }
      #aisoc-generic-instructions-root .gi-err {
        color: #991b1b; font-size: 13px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      }
      /* Editor for the shared preamble. */
      #aisoc-generic-instructions-root textarea.gi-edit {
        width: 100%;
        box-sizing: border-box;
        margin-top: 10px;
        padding: 12px;
        background: #ffffff;
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
        font-size: 13px;
        line-height: 1.5;
        color: #1f2937;
        resize: vertical;
        min-height: 200px;
        max-height: 600px;
      }
      #aisoc-generic-instructions-root textarea.gi-edit:focus {
        outline: none;
        border-color: #0099cc;
        box-shadow: 0 0 0 3px rgba(0,153,204,0.18);
      }
      #aisoc-generic-instructions-root .gi-edit-warning {
        margin-top: 8px;
        padding: 8px 12px;
        background: rgba(245,158,11,0.08);
        border: 1px solid rgba(245,158,11,0.4);
        border-radius: 6px;
        color: #92400e;
        font-size: 12px;
      }
      #aisoc-generic-instructions-root .gi-edit-actions {
        display: flex;
        gap: 8px;
        margin-top: 10px;
        align-items: center;
        flex-wrap: wrap;
      }
      #aisoc-generic-instructions-root .gi-edit-actions button.save {
        background: #0099cc;
        color: #ffffff;
        border: 1px solid #0099cc;
        padding: 4px 14px;
        border-radius: 4px;
        cursor: pointer;
        font-weight: 600;
      }
      #aisoc-generic-instructions-root .gi-edit-actions button.save:hover:not(:disabled) {
        background: #33b0dd;
      }
      #aisoc-generic-instructions-root .gi-edit-actions button.save:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }
      #aisoc-generic-instructions-root .gi-save-status {
        font-size: 12px;
        flex: 1;
      }
      #aisoc-generic-instructions-root .gi-save-status.saving { color: #6b7280; font-style: italic; }
      #aisoc-generic-instructions-root .gi-save-status.ok { color: #065f46; }
      #aisoc-generic-instructions-root .gi-save-status.error {
        color: #991b1b;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        white-space: pre-wrap;
        word-break: break-word;
      }
      /* Per-agent progress badges shown during a fan-out save. */
      #aisoc-generic-instructions-root .gi-progress {
        margin-top: 8px;
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      #aisoc-generic-instructions-root .gi-progress .pa {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 2px 10px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 600;
        border: 1px solid #cbd5e1;
        background: #f9fafb;
        color: #6b7280;
      }
      #aisoc-generic-instructions-root .gi-progress .pa.pending {
        background: #f3f4f6; color: #6b7280;
      }
      #aisoc-generic-instructions-root .gi-progress .pa.ok {
        background: rgba(34,197,94,0.10);
        border-color: rgba(34,197,94,0.5);
        color: #166534;
      }
      #aisoc-generic-instructions-root .gi-progress .pa.error {
        background: rgba(239,68,68,0.10);
        border-color: rgba(239,68,68,0.5);
        color: #991b1b;
      }
    `;
    const style = document.createElement('style');
    style.id = 'aisoc-generic-instr-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // (Generic-instructions card state — giOpen / giCommon / giError /
  // giLoadedAt — is declared near the top of the IIFE so render*
  // helpers can access it before this point in the file.)

  function setupGenericInstructions() {
    const r = document.getElementById('aisoc-generic-instructions-root');
    if (!r) return;
    renderGenericInstructions();
  }

  function renderGenericInstructions() {
    const r = document.getElementById('aisoc-generic-instructions-root');
    if (!r) return;

    // ── Focus preservation across re-renders ────────────────────────
    // The save fan-out re-renders this card after every agent — we
    // don't want that to yank the user's textarea focus.
    const active = document.activeElement;
    const wasGiTa = active && active.getAttribute && active.getAttribute('data-gi-textarea');
    let selStart = 0, selEnd = 0, scrollTop = 0;
    if (wasGiTa) {
      try { selStart = active.selectionStart; selEnd = active.selectionEnd; } catch (_) {}
      scrollTop = active.scrollTop;
    }

    const ageTxt = giLoadedAt
      ? ` · loaded ${escapeHtml(fmtAgoLocal(giLoadedAt) || '')}`
      : '';
    const hasCommon = typeof giCommon === 'string' && giCommon.length > 0;

    let headRight = '';
    if (giEditing) {
      // While editing the head buttons are subdued — Save/Cancel live
      // in the editor below. Don't render Show/Hide or Edit here.
    } else {
      headRight += `<button class="gi-toggle" id="gi-toggle-btn" ${hasCommon ? '' : 'disabled'}>`
                 + `${giOpen ? 'Hide' : (hasCommon ? 'Show' : 'Loading…')}`
                 + `</button>`;
      if (giOpen && hasCommon) {
        headRight += ` <button class="gi-toggle" id="gi-edit-btn" `
                   + `style="margin-left:6px;">Edit</button>`;
      }
    }

    let body = `
      <div class="gi-card">
        <div class="gi-head">
          <span class="gi-title">Generic instructions / context</span>
          <span class="gi-sub">Shared preamble loaded from each Foundry agent's deployed instructions${ageTxt}</span>
          ${headRight}
        </div>
    `;

    if (giEditing) {
      const draft = giDraft != null ? giDraft : (giCommon || '');
      const saving = giSaveStatus && giSaveStatus.state === 'saving';
      const slugs = (window.__AISOC_AGENTS_LAST || [])
        .map((a) => (a && (a.id || a.agent)) || '').filter(Boolean);
      body += `<textarea class="gi-edit" data-gi-textarea="common" ${saving ? 'disabled' : ''}>${escapeHtml(draft)}</textarea>`;
      body += `<div class="gi-edit-warning">`
            + `<strong>Heads up:</strong> Saving will create a new version on `
            + `<strong>${slugs.length}</strong> agents in Foundry `
            + `(${escapeHtml(slugs.join(', '))}). Each gets the new common preamble + that agent's existing role-specific tail.`
            + `</div>`;
      body += '<div class="gi-edit-actions">';
      body += `<button class="save" id="gi-save-btn" ${saving ? 'disabled' : ''}>${saving ? 'Saving…' : 'Save to Foundry'}</button>`;
      body += `<button class="gi-toggle" id="gi-cancel-btn" ${saving ? 'disabled' : ''}>Cancel</button>`;
      if (giSaveStatus && giSaveStatus.message) {
        body += `<span class="gi-save-status ${escapeHtml(giSaveStatus.state)}">${escapeHtml(giSaveStatus.message)}</span>`;
      }
      body += '</div>';
      // Per-agent badges during a fan-out.
      if (giSaveStatus && giSaveStatus.perAgent) {
        body += '<div class="gi-progress">';
        for (const slug of Object.keys(giSaveStatus.perAgent)) {
          const st = giSaveStatus.perAgent[slug];
          const sym = st === 'ok' ? '✓' : (st === 'error' ? '✗' : '·');
          body += `<span class="pa ${escapeHtml(st)}">${sym} ${escapeHtml(slug)}</span>`;
        }
        body += '</div>';
      }
    } else if (giError) {
      body += `<div class="gi-err">Failed to load instructions: ${escapeHtml(giError)}</div>`;
    } else if (giOpen && hasCommon) {
      body += `<div class="gi-body">${escapeHtml(giCommon)}</div>`;
      // Surface the most recent save outcome below the read-only view.
      if (giSaveStatus && giSaveStatus.state === 'ok') {
        body += `<div class="gi-save-status ok" style="margin-top:8px;">${escapeHtml(giSaveStatus.message)}</div>`;
      }
    } else if (giOpen && !hasCommon) {
      body += `<div class="gi-empty">No shared preamble found. Either the agents are not yet deployed, or each agent's instructions diverge entirely (no common prefix).</div>`;
    }
    body += '</div>';
    r.innerHTML = body;

    // Wire up handlers.
    const toggleBtn = document.getElementById('gi-toggle-btn');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        giOpen = !giOpen;
        renderGenericInstructions();
      });
    }
    const editBtn = document.getElementById('gi-edit-btn');
    if (editBtn) {
      editBtn.addEventListener('click', () => {
        giEditing = true;
        if (giDraft == null) giDraft = giCommon || '';
        giSaveStatus = null;
        renderGenericInstructions();
      });
    }
    const cancelBtn = document.getElementById('gi-cancel-btn');
    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        giEditing = false;
        giDraft = null;
        giSaveStatus = null;
        renderGenericInstructions();
      });
    }
    const saveBtn = document.getElementById('gi-save-btn');
    if (saveBtn) {
      saveBtn.addEventListener('click', onCommonInstructionsSave);
    }
    const ta = r.querySelector('textarea[data-gi-textarea="common"]');
    if (ta) {
      ta.addEventListener('input', () => { giDraft = ta.value; });
    }

    // Restore focus on the textarea if we had it before the wipe.
    if (wasGiTa) {
      const newTa = r.querySelector(`textarea[data-gi-textarea="${wasGiTa}"]`);
      if (newTa) {
        try {
          newTa.focus({ preventScroll: true });
          newTa.setSelectionRange(selStart, selEnd);
          newTa.scrollTop = scrollTop;
        } catch (_) { /* best-effort */ }
      }
    }
  }

  // ── Common-preamble save (fans out to every roster agent) ─────────
  // Each agent's stored instructions = common + "\n\n" + role_tail. To
  // change just the common part we need to re-concat per-agent and
  // POST a new version to each. Sequential rather than parallel so
  // partial failures are easy to surface (and the user can see which
  // ones succeeded before the failure).
  async function onCommonInstructionsSave() {
    const draft = giDraft != null ? giDraft : '';
    if (!draft.trim()) {
      giSaveStatus = { state: 'error', message: 'Cannot save an empty common preamble' };
      renderGenericInstructions();
      return;
    }

    const slugs = (window.__AISOC_AGENTS_LAST || [])
      .map((a) => (a && (a.id || a.agent)) || '').filter(Boolean);
    if (!slugs.length) {
      giSaveStatus = { state: 'error', message: 'No agents loaded yet — refresh and try again' };
      renderGenericInstructions();
      return;
    }

    const ok = window.confirm(
      `This will create a new version on ${slugs.length} agents in Foundry:\n  ${slugs.join(', ')}\n\n`
      + `Each gets: new common preamble + that agent's existing role-specific tail.\n\n`
      + `The change is live immediately for any incoming workflow runs. Continue?`
    );
    if (!ok) return;

    // Initial state: every agent is "pending" until we hit it.
    const perAgent = {};
    for (const slug of slugs) perAgent[slug] = 'pending';
    giSaveStatus = { state: 'saving', message: 'Saving…', perAgent };
    renderGenericInstructions();

    const errors = [];
    for (const slug of slugs) {
      giSaveStatus.message = `Saving ${slug}…`;
      renderGenericInstructions();

      // Use whatever role tail we have on file for this agent. If
      // it's missing (agent not yet hydrated), skip — better than
      // wiping the role with empty.
      const roleTail = agentInstructions[slug];
      if (typeof roleTail !== 'string') {
        perAgent[slug] = 'error';
        errors.push(`${slug}: no role-tail loaded; refresh /config and retry`);
        renderGenericInstructions();
        continue;
      }

      const fullInstructions = roleTail
        ? `${draft}\n\n${roleTail}`
        : draft;

      try {
        const r = await fetch(
          `/api/foundry/agents/${encodeURIComponent(slug)}/instructions`,
          {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ instructions: fullInstructions }),
          },
        );
        if (!r.ok) {
          let msg = `HTTP ${r.status}`;
          try {
            const j = await r.json();
            const detail = j && j.detail;
            if (typeof detail === 'string') msg += `: ${detail}`;
            else if (detail) msg += `: ${detail.error || ''} ${detail.body || ''}`.trim();
          } catch (_) { /* keep msg */ }
          perAgent[slug] = 'error';
          errors.push(`${slug}: ${msg}`);
        } else {
          perAgent[slug] = 'ok';
        }
      } catch (e) {
        perAgent[slug] = 'error';
        errors.push(`${slug}: ${e.message || e}`);
      }
      renderGenericInstructions();
    }

    if (errors.length === 0) {
      giSaveStatus = {
        state: 'ok',
        message: `Saved ${slugs.length} agents`,
        perAgent,
      };
      giEditing = false;
      giDraft = null;
      renderGenericInstructions();
      // Pull fresh content so the read-only view shows the new common.
      fetchAgentInstructions();
    } else {
      giSaveStatus = {
        state: 'error',
        message:
          `${slugs.length - errors.length}/${slugs.length} succeeded; failures:\n`
          + errors.join('\n'),
        perAgent,
      };
      // Stay in edit mode so the user can retry.
      renderGenericInstructions();
    }
  }

  async function fetchAgentInstructions() {
    try {
      const r = await fetch('/api/foundry/agents/instructions',
                            { credentials: 'same-origin' });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status}${text ? `: ${text}` : ''}`);
      }
      const data = await r.json();
      giCommon = (data && typeof data.common === 'string') ? data.common : '';
      giError = '';
      giLoadedAt = Math.floor(Date.now() / 1000);

      const map = {};
      for (const a of (data && data.agents) || []) {
        if (a && a.slug) map[a.slug] = a.instructions || '';
      }
      // Sentinel field so renderAgent can distinguish "loaded but empty"
      // from "still loading".
      map.__loaded = true;
      agentInstructions = map;

      renderGenericInstructions();
      // Re-render the agents grid so the per-agent buttons appear /
      // refresh.
      render(window.__AISOC_AGENTS_LAST || []);
    } catch (e) {
      giError = String(e.message || e);
      // Don't drop previously-loaded agentInstructions on transient
      // errors — keeps the per-agent buttons usable while we retry.
      renderGenericInstructions();
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────
  function fmtAgoLocal(t) {
    if (t == null || !Number(t)) return null;
    const sec = Math.floor(Date.now() / 1000) - Number(t);
    if (sec < 0)   return 'just now';
    if (sec < 60)  return `${sec}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
  }

  function injectToggleStyles() {
    if (document.getElementById('aisoc-toggle-styles')) return;
    const css = `
      .aisoc-toggle-root { margin-bottom: 16px; }
      .aisoc-toggle-root .ap-card {
        background: #ffffff;
        border: 1px solid #e5e7eb;
        border-radius: 8px;
        padding: 16px 20px;
        display: flex; align-items: center; gap: 16px;
        flex-wrap: wrap;
      }
      .aisoc-toggle-root .ap-info { flex: 1; min-width: 240px; }
      .aisoc-toggle-root .ap-title {
        font-size: 15px; font-weight: 700; color: #1f2937;
        margin-bottom: 4px;
      }
      .aisoc-toggle-root .ap-desc {
        font-size: 13px; color: #6b7280; line-height: 1.4;
      }
      .aisoc-toggle-root .ap-state {
        margin-top: 8px;
        font-size: 12px;
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        color: #6b7280;
      }
      .aisoc-toggle-root .ap-state .ev { color: #1f2937; }
      .aisoc-toggle-root .ap-switch {
        position: relative;
        width: 56px; height: 30px;
        background: #d1d5db;
        border-radius: 999px;
        cursor: pointer;
        transition: background 0.15s ease;
        flex-shrink: 0;
      }
      .aisoc-toggle-root .ap-switch.on { background: #10b981; }
      .aisoc-toggle-root .ap-switch.busy { opacity: 0.6; cursor: wait; }
      .aisoc-toggle-root .ap-switch::after {
        content: '';
        position: absolute;
        top: 3px; left: 3px;
        width: 24px; height: 24px;
        background: #ffffff;
        border-radius: 50%;
        box-shadow: 0 1px 3px rgba(0,0,0,0.2);
        transition: left 0.15s ease;
      }
      .aisoc-toggle-root .ap-switch.on::after { left: 29px; }
      .aisoc-toggle-root .ap-label {
        font-size: 13px; font-weight: 700;
        color: #6b7280;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        min-width: 36px;
        text-align: left;
      }
      .aisoc-toggle-root .ap-switch.on + .ap-label { color: #065f46; }
    `;
    const style = document.createElement('style');
    style.id = 'aisoc-toggle-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // Generic two-state toggle backed by GET/POST {apiPath} returning at
  // least { enabled: bool, last_event?, last_event_ts? }. Renders into
  // the element with id=opts.rootId and polls every 5s.
  function setupToggle(opts) {
    const root = document.getElementById(opts.rootId);
    if (!root) return;
    root.classList.add('aisoc-toggle-root');

    let state = { enabled: false, last_event: null, last_event_ts: null };
    let busy = false;

    function r() {
      const onCls = state.enabled ? 'on' : '';
      const busyCls = busy ? 'busy' : '';
      const label = state.enabled ? 'ON' : 'OFF';
      const extraState = (typeof opts.renderState === 'function')
        ? opts.renderState(state) : '';
      const evTxt = state.last_event
        ? `<span class="ev">${escapeHtml(state.last_event)}</span>`
            + (state.last_event_ts ? ` · ${escapeHtml(fmtAgoLocal(state.last_event_ts) || '')}` : '')
        : 'no events yet';

      const btnId = opts.rootId + '-btn';
      root.innerHTML = `
        <div class="ap-card">
          <div class="ap-info">
            <div class="ap-title">${escapeHtml(opts.title)}</div>
            <div class="ap-desc">${opts.desc}</div>
            <div class="ap-state">
              ${extraState}<br>
              Last event: ${evTxt}
            </div>
          </div>
          <div class="ap-switch ${onCls} ${busyCls}" id="${escapeHtml(btnId)}"
               role="switch" aria-checked="${state.enabled}"
               tabindex="0"></div>
          <div class="ap-label">${label}</div>
        </div>
      `;
      const btn = document.getElementById(btnId);
      if (btn) {
        btn.addEventListener('click', toggle);
        btn.addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter' || ev.key === ' ') {
            ev.preventDefault();
            toggle();
          }
        });
      }
    }

    async function poll() {
      try {
        const resp = await fetch(opts.apiPath, { credentials: 'same-origin' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        state = await resp.json();
        r();
      } catch (e) {
        root.innerHTML = `
          <div class="ap-card">
            <div class="ap-info">
              <div class="ap-title">${escapeHtml(opts.title)}</div>
              <div class="ap-desc" style="color:#991b1b">
                Failed to load: ${escapeHtml(e.message || String(e))}
              </div>
            </div>
          </div>
        `;
      }
    }

    async function toggle() {
      if (busy) return;
      busy = true;
      const desired = !state.enabled;
      r();
      try {
        const resp = await fetch(opts.apiPath, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: desired }),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        state = await resp.json();
      } catch (e) {
        try {
          const resp = await fetch(opts.apiPath, { credentials: 'same-origin' });
          if (resp.ok) state = await resp.json();
        } catch (_) { /* ignore */ }
        alert(`Failed to update ${opts.title}: ` + (e.message || String(e)));
      } finally {
        busy = false;
        r();
      }
    }

    poll();
    setInterval(poll, 5000);
  }
})();
