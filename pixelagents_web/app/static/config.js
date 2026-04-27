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
    #${ROOT_ID} .card .dot.reading {
      background: #34d399;
      box-shadow: 0 0 0 4px rgba(52,211,153,0.18);
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
    #${ROOT_ID} .card .pill.reading { color: #065f46; background: rgba(34,197,94,0.16); }
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

    html += '<div class="toggle">';
    html += `<button data-agent="${escapeHtml(name)}">${showRaw ? 'Hide raw JSON' : 'Show raw JSON'}</button>`;
    html += '</div>';
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
    let body = '<div class="agents">';
    for (const a of agents) body += renderAgent(a);
    body += '</div>';
    root.innerHTML = body;

    root.querySelectorAll('.card .toggle button').forEach((btn) => {
      btn.addEventListener('click', () => {
        const n = btn.dataset.agent;
        if (expanded.has(n)) expanded.delete(n);
        else expanded.add(n);
        render(window.__AISOC_AGENTS_LAST || []);
      });
    });
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
