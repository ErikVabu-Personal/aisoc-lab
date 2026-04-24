/*
 * AISOC Sentinel incidents panel.
 *
 * Renders a collapsible glass panel pinned to the top-right of the viewport,
 * showing the current list of Sentinel incidents. Polls /api/sentinel/incidents
 * every 15s. Dependency-free vanilla JS, mirrors the chat drawer's patterns
 * so the two panels feel consistent.
 *
 * Token arrives via window.__PIXELAGENTS_CHAT (same as the chat drawer).
 */

(function () {
  'use strict';

  const cfg = window.__PIXELAGENTS_CHAT || {};
  const TOKEN = cfg.token || '';

  if (!TOKEN) {
    console.warn('[incidents-panel] no token injected; panel disabled.');
    return;
  }

  // ── State ────────────────────────────────────────────────────────────────
  const state = {
    incidents: [],
    count: 0,
    loadedOnce: false,
    lastError: null,
    open: true,
  };

  // ── Root DOM ─────────────────────────────────────────────────────────────
  const rootId = 'aisoc-incidents-panel-root';
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
      right: 16px;
      top: 16px;
      width: 440px;
      max-height: 45vh;
      background: rgba(10, 12, 18, 0.82);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border: 1px solid rgba(255, 255, 255, 0.12);
      border-radius: 8px;
      color: #e7e9ee;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 15px;
      line-height: 1.45;
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
    #${rootId} header .count {
      background: rgba(96, 165, 250, 0.25);
      border: 1px solid rgba(96, 165, 250, 0.5);
      border-radius: 999px;
      padding: 2px 8px;
      font-size: 12px;
      font-weight: 600;
    }
    #${rootId} header .toggle {
      opacity: 0.6;
      font-size: 16px;
      line-height: 1;
    }
    #${rootId} .body {
      flex: 1;
      min-height: 0;
      overflow-y: auto;
    }
    #${rootId}[data-collapsed="true"] .body {
      display: none;
    }
    #${rootId} table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    #${rootId} thead th {
      text-align: left;
      padding: 8px 10px;
      background: rgba(255, 255, 255, 0.02);
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      font-weight: 600;
      position: sticky;
      top: 0;
      z-index: 1;
      color: rgba(231, 233, 238, 0.75);
    }
    #${rootId} tbody td {
      padding: 6px 10px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.04);
      vertical-align: top;
    }
    #${rootId} tbody tr:hover {
      background: rgba(255, 255, 255, 0.04);
    }
    #${rootId} .num {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      opacity: 0.9;
      white-space: nowrap;
    }
    #${rootId} .title-cell {
      max-width: 210px;
      word-wrap: break-word;
    }
    #${rootId} .sev {
      display: inline-block;
      padding: 1px 6px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      white-space: nowrap;
    }
    #${rootId} .sev.high,
    #${rootId} .sev.informational {
      color: #fecaca;
      background: rgba(239, 68, 68, 0.22);
      border: 1px solid rgba(239, 68, 68, 0.4);
    }
    #${rootId} .sev.medium {
      color: #fde68a;
      background: rgba(245, 158, 11, 0.22);
      border: 1px solid rgba(245, 158, 11, 0.4);
    }
    #${rootId} .sev.low {
      color: #bbf7d0;
      background: rgba(34, 197, 94, 0.22);
      border: 1px solid rgba(34, 197, 94, 0.4);
    }
    #${rootId} .sev.informational {
      color: #bfdbfe;
      background: rgba(96, 165, 250, 0.22);
      border: 1px solid rgba(96, 165, 250, 0.4);
    }
    #${rootId} .status {
      font-size: 12px;
      opacity: 0.85;
      white-space: nowrap;
    }
    #${rootId} .status.new {
      color: #fecaca;
    }
    #${rootId} .status.active {
      color: #fde68a;
    }
    #${rootId} .status.closed {
      color: #9ca3af;
    }
    #${rootId} .empty,
    #${rootId} .error {
      padding: 16px 12px;
      color: rgba(255, 255, 255, 0.55);
      text-align: center;
      font-style: italic;
    }
    #${rootId} .error {
      color: #fecaca;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-style: normal;
      font-size: 12px;
      text-align: left;
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

  function sevClass(s) {
    const v = (s || '').toLowerCase();
    if (['high', 'medium', 'low', 'informational'].indexOf(v) >= 0) return v;
    return 'informational';
  }

  function statusClass(s) {
    const v = (s || '').toLowerCase();
    if (['new', 'active', 'closed'].indexOf(v) >= 0) return v;
    return '';
  }

  // ── Data fetching ────────────────────────────────────────────────────────
  async function loadIncidents() {
    try {
      const res = await fetch('/api/sentinel/incidents', {
        headers: { 'x-pixelagents-token': TOKEN },
      });
      if (!res.ok) {
        let bodyText = '';
        try {
          bodyText = JSON.stringify(await res.json(), null, 2);
        } catch (_) {
          bodyText = await res.text();
        }
        state.lastError = `HTTP ${res.status}\n${bodyText}`;
        state.loadedOnce = true;
        render();
        return;
      }
      const data = await res.json();
      state.incidents = data.incidents || [];
      state.count = data.count || state.incidents.length;
      state.lastError = null;
      state.loadedOnce = true;
      render();
    } catch (e) {
      state.lastError = e && e.message ? e.message : String(e);
      state.loadedOnce = true;
      render();
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────
  function render() {
    rootEl.setAttribute('data-collapsed', state.open ? 'false' : 'true');

    const header = `
      <header data-action="toggle">
        <div class="title">Sentinel incidents</div>
        <div class="count">${state.count}</div>
        <div class="toggle">${state.open ? '▾' : '▸'}</div>
      </header>
    `;

    let body;
    if (state.lastError) {
      body = `<div class="error">${escapeHtml(state.lastError)}</div>`;
    } else if (!state.loadedOnce) {
      body = `<div class="empty">Loading…</div>`;
    } else if (!state.incidents.length) {
      body = `<div class="empty">No incidents.</div>`;
    } else {
      const rows = state.incidents
        .map((inc) => {
          const num = inc.number == null ? '—' : `#${inc.number}`;
          const title = inc.title || '(untitled)';
          const sev = inc.severity || 'Informational';
          const status = inc.status || '';
          return `
            <tr>
              <td class="num">${escapeHtml(num)}</td>
              <td class="title-cell">${escapeHtml(title)}</td>
              <td><span class="sev ${sevClass(sev)}">${escapeHtml(sev)}</span></td>
              <td><span class="status ${statusClass(status)}">${escapeHtml(status)}</span></td>
            </tr>
          `;
        })
        .join('');
      body = `
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Title</th>
              <th>Severity</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      `;
    }

    rootEl.innerHTML = `${header}<div class="body">${body}</div>`;
  }

  rootEl.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-action]');
    if (!t) return;
    if (t.getAttribute('data-action') === 'toggle') {
      state.open = !state.open;
      render();
    }
  });

  // ── Boot ─────────────────────────────────────────────────────────────────
  render();
  loadIncidents();
  setInterval(loadIncidents, 15000);
})();
