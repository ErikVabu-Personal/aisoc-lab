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
    // In-flight orchestrations, keyed by incident number.
    // { [number]: { startedAt: ms } }
    orchestrating: {},
    // Latest notice banner.
    // { kind: 'info' | 'success' | 'error', message, incidentNumber, ts }
    notice: null,
    // Context menu (right-click) state.
    // { x, y, incident: {number, id, title} }
    contextMenu: null,
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
    #${rootId} tbody tr.running {
      background: rgba(96, 165, 250, 0.08);
    }
    #${rootId} .row-spinner {
      display: inline-block;
      width: 10px;
      height: 10px;
      border: 2px solid rgba(96, 165, 250, 0.4);
      border-top-color: #60a5fa;
      border-radius: 50%;
      animation: aisoc-inc-spin 0.9s linear infinite;
      vertical-align: middle;
      margin-right: 6px;
    }
    @keyframes aisoc-inc-spin {
      to { transform: rotate(360deg); }
    }
    #${rootId} .notice {
      padding: 8px 12px;
      font-size: 13px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      display: flex;
      align-items: center;
      gap: 8px;
    }
    #${rootId} .notice.info {
      background: rgba(96, 165, 250, 0.15);
      color: #dbeafe;
    }
    #${rootId} .notice.success {
      background: rgba(34, 197, 94, 0.15);
      color: #bbf7d0;
    }
    #${rootId} .notice.error {
      background: rgba(239, 68, 68, 0.15);
      color: #fecaca;
      white-space: pre-wrap;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
    }
    #${rootId} .notice .dismiss {
      margin-left: auto;
      background: transparent;
      border: none;
      color: inherit;
      cursor: pointer;
      opacity: 0.7;
      font-size: 14px;
      padding: 0 4px;
    }
    #${rootId} .notice .dismiss:hover { opacity: 1; }

    /* Context menu lives outside the panel root so it can overflow. */
    #aisoc-incidents-ctxmenu {
      position: fixed;
      background: rgba(15, 18, 26, 0.96);
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      border: 1px solid rgba(255, 255, 255, 0.14);
      border-radius: 6px;
      box-shadow: 0 14px 40px rgba(0, 0, 0, 0.55);
      z-index: 10001;
      min-width: 220px;
      padding: 4px 0;
      color: #e7e9ee;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 14px;
    }
    #aisoc-incidents-ctxmenu .ctx-header {
      padding: 6px 12px 4px 12px;
      font-size: 12px;
      opacity: 0.6;
      border-bottom: 1px solid rgba(255, 255, 255, 0.08);
      margin-bottom: 4px;
      white-space: nowrap;
      max-width: 320px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #aisoc-incidents-ctxmenu .ctx-item {
      padding: 8px 14px;
      cursor: pointer;
      user-select: none;
    }
    #aisoc-incidents-ctxmenu .ctx-item:hover {
      background: rgba(96, 165, 250, 0.18);
    }
    #aisoc-incidents-ctxmenu .ctx-item[data-disabled="true"] {
      opacity: 0.5;
      cursor: not-allowed;
    }
    #aisoc-incidents-ctxmenu .ctx-item[data-disabled="true"]:hover {
      background: transparent;
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

    let noticeHtml = '';
    if (state.notice) {
      noticeHtml = `
        <div class="notice ${state.notice.kind}">
          <div>${escapeHtml(state.notice.message)}</div>
          <button class="dismiss" data-action="dismiss-notice" title="Dismiss">✕</button>
        </div>
      `;
    }

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
          const isRunning =
            inc.number != null && state.orchestrating[inc.number];
          const numCell = isRunning
            ? `<span class="row-spinner"></span>${escapeHtml(num)}`
            : escapeHtml(num);
          const numberAttr = inc.number == null ? '' : String(inc.number);
          return `
            <tr class="${isRunning ? 'running' : ''}" data-incident-number="${escapeHtml(numberAttr)}" data-incident-title="${escapeHtml(title)}">
              <td class="num">${numCell}</td>
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

    rootEl.innerHTML = `${header}${noticeHtml}<div class="body">${body}</div>`;

    renderContextMenu();
  }

  // ── Context menu ─────────────────────────────────────────────────────────
  const ctxMenuId = 'aisoc-incidents-ctxmenu';

  function renderContextMenu() {
    let menu = document.getElementById(ctxMenuId);
    if (!state.contextMenu) {
      if (menu) menu.remove();
      return;
    }
    if (!menu) {
      menu = document.createElement('div');
      menu.id = ctxMenuId;
      document.body.appendChild(menu);
    }

    const { x, y, incident } = state.contextMenu;
    const running =
      incident.number != null && state.orchestrating[incident.number];
    const disabled = running || incident.number == null;
    const disabledAttr = disabled ? 'true' : 'false';

    const label =
      incident.number == null
        ? '(no incident number)'
        : `#${incident.number} — ${incident.title || '(untitled)'}`;

    menu.innerHTML = `
      <div class="ctx-header">${escapeHtml(label)}</div>
      <div class="ctx-item" data-action="assign-workflow" data-disabled="${disabledAttr}">
        ${running ? 'Workflow running…' : 'Assign to workflow (triage → investigator → reporter)'}
      </div>
    `;

    // Position, clamping inside the viewport.
    menu.style.left = '0px';
    menu.style.top = '0px';
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const rect = menu.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const left = Math.min(x, vw - w - 8);
    const top = Math.min(y, vh - h - 8);
    menu.style.left = `${Math.max(8, left)}px`;
    menu.style.top = `${Math.max(8, top)}px`;
  }

  // ── Notice auto-dismiss ──────────────────────────────────────────────────
  function setNotice(notice, autoDismissMs) {
    state.notice = notice;
    render();
    if (autoDismissMs && notice) {
      const ts = notice.ts;
      setTimeout(() => {
        if (state.notice && state.notice.ts === ts) {
          state.notice = null;
          render();
        }
      }, autoDismissMs);
    }
  }

  // ── Orchestration trigger ────────────────────────────────────────────────
  async function startOrchestration(incidentNumber, incidentTitle) {
    if (incidentNumber == null) return;
    if (state.orchestrating[incidentNumber]) return;

    state.orchestrating[incidentNumber] = { startedAt: Date.now() };
    setNotice(
      {
        kind: 'info',
        message: `Running workflow for incident #${incidentNumber}…`,
        incidentNumber,
        ts: Date.now(),
      },
      null, // no auto-dismiss while it's in progress
    );

    try {
      const res = await fetch(
        `/api/sentinel/incidents/${encodeURIComponent(incidentNumber)}/orchestrate`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-pixelagents-token': TOKEN,
          },
          body: JSON.stringify({ mode: 'full', writeback: true }),
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

      const data = await res.json();
      const wroteComment =
        data && data.wrote_comment && data.wrote_comment.count;
      const summary = wroteComment
        ? `wrote ${data.wrote_comment.count} Sentinel comment(s)`
        : 'no Sentinel comment written';
      setNotice(
        {
          kind: 'success',
          message: `Workflow complete for incident #${incidentNumber} — ${summary}.`,
          incidentNumber,
          ts: Date.now(),
        },
        12000,
      );
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      setNotice(
        {
          kind: 'error',
          message: `Workflow failed for incident #${incidentNumber}:\n${msg}`,
          incidentNumber,
          ts: Date.now(),
        },
        null, // errors stay put until dismissed
      );
    } finally {
      delete state.orchestrating[incidentNumber];
      render();
      // Refresh the incident list so any status/comment changes show up.
      loadIncidents();
    }
  }

  // ── Event wiring ─────────────────────────────────────────────────────────
  rootEl.addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-action]');
    if (!t) return;
    const action = t.getAttribute('data-action');
    if (action === 'toggle') {
      state.open = !state.open;
      render();
    } else if (action === 'dismiss-notice') {
      state.notice = null;
      render();
    }
  });

  // Registered on `document` with `capture: true` because the vendored
  // Pixel Agents bundle attaches its own `contextmenu` handlers and can
  // stopPropagation() on the bubble phase — if we listen only on rootEl
  // we never see the event. Capture-phase runs before target-phase, so
  // we get the event first and can intervene only for rows inside our panel.
  document.addEventListener(
    'contextmenu',
    (ev) => {
      if (!rootEl.contains(ev.target)) return; // not ours, let it pass
      const row = ev.target.closest('tr[data-incident-number]');
      if (!row) return;
      ev.preventDefault();
      ev.stopPropagation();
      const rawNum = row.getAttribute('data-incident-number');
      const number = rawNum === '' ? null : Number(rawNum);
      const title = row.getAttribute('data-incident-title') || '';
      state.contextMenu = {
        // clientX/Y because the menu is position: fixed (viewport-relative).
        x: ev.clientX,
        y: ev.clientY,
        incident: { number, title },
      };
      render();
    },
    true,
  );

  // Click/contextmenu anywhere outside the menu closes it.
  document.addEventListener('click', (ev) => {
    if (!state.contextMenu) return;
    const menu = document.getElementById(ctxMenuId);
    if (menu && menu.contains(ev.target)) {
      const item = ev.target.closest('.ctx-item');
      if (item && item.getAttribute('data-disabled') !== 'true') {
        const action = item.getAttribute('data-action');
        if (action === 'assign-workflow') {
          const inc = state.contextMenu.incident;
          state.contextMenu = null;
          render();
          startOrchestration(inc.number, inc.title);
          return;
        }
      }
      // Clicked inside but on a disabled item or header: just close.
    }
    state.contextMenu = null;
    render();
  });
  document.addEventListener(
    'contextmenu',
    (ev) => {
      if (!state.contextMenu) return;
      // Right-clicking another row inside the panel reopens the menu via the
      // capture-phase handler above, which gets to the event before this one.
      if (rootEl.contains(ev.target)) return;
      state.contextMenu = null;
      render();
    },
    true, // capture-phase, mirrors the open handler
  );
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && state.contextMenu) {
      state.contextMenu = null;
      render();
    }
  });
  window.addEventListener('resize', () => {
    if (state.contextMenu) renderContextMenu();
  });

  // ── Boot ─────────────────────────────────────────────────────────────────
  render();
  loadIncidents();
  setInterval(loadIncidents, 15000);
})();
