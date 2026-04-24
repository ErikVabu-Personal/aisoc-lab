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
  const SHOW_COST = cfg.show_cost !== false;

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
    // Per-incident EUR totals, keyed by incident number (string).
    // Refreshed on each loadIncidents poll so a running workflow shows
    // its cost rising in real time.
    costs: {},
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
    /* Inherit FS Pixel Sans + palette from the vendored Pixel Agents CSS. */
    #${rootId} {
      position: fixed;
      right: 16px;
      top: 16px;
      width: 720px;
      max-height: 55vh;
      background: var(--color-bg, #1e1e2e);
      border: 2px solid var(--color-border, #4a4a6a);
      border-radius: 6px;
      color: var(--color-text, #ffffffe6);
      font-size: 20px;
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
      gap: 10px;
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
    #${rootId} header .count {
      background: var(--color-bg-dark, #181828);
      border: 2px solid #fff4;
      border-radius: 999px;
      padding: 2px 10px;
      font-size: 16px;
      font-weight: 700;
    }
    #${rootId} header .toggle {
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
      font-size: 18px;
    }
    #${rootId} thead th {
      text-align: left;
      padding: 8px 10px;
      background: var(--color-bg-dark, #181828);
      border-bottom: 2px solid var(--color-border, #4a4a6a);
      font-weight: 700;
      position: sticky;
      top: 0;
      z-index: 1;
      color: var(--color-text-muted, #ffffff80);
    }
    #${rootId} tbody td {
      padding: 6px 10px;
      border-bottom: 1px solid var(--color-border, #4a4a6a);
      vertical-align: top;
    }
    #${rootId} tbody tr:hover {
      background: var(--color-active-bg, #2c2b6d);
    }
    #${rootId} .num {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      opacity: 0.9;
      white-space: nowrap;
    }
    #${rootId} .title-cell {
      max-width: 220px;
      word-wrap: break-word;
    }
    #${rootId} .owner-cell {
      font-size: 14px;
      white-space: nowrap;
      max-width: 140px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #${rootId} .owner-cell.agent-owner {
      color: #dbeafe;
      background: rgba(96, 165, 250, 0.18);
      border: 1px solid rgba(96, 165, 250, 0.4);
      border-radius: 4px;
      padding: 2px 6px;
      font-weight: 600;
    }
    #${rootId} .cost-cell {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 14px;
      white-space: nowrap;
      text-align: right;
      color: #bbf7d0;
    }
    #${rootId} .cost-cell.zero {
      color: var(--color-text-muted, #ffffff80);
    }
    #${rootId} .sev {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 14px;
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
      font-size: 16px;
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
      font-size: 13px;
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
      font-size: 16px;
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
      font-size: 13px;
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

    #${rootId} .run-btn {
      background: var(--color-accent, #6030ff);
      border: 2px solid var(--color-border, #4a4a6a);
      color: #fff;
      border-radius: 4px;
      padding: 5px 14px;
      cursor: pointer;
      font: inherit;
      font-size: 16px;
      font-weight: 700;
      white-space: nowrap;
      box-shadow: var(--shadow-pixel, 2px 2px 0 #0a0a14);
    }
    #${rootId} .run-btn:hover:not(:disabled) {
      background: var(--color-accent-bright, #746fff);
    }
    #${rootId} .run-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
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

      if (SHOW_COST) {
        // Best-effort: fetch the cost map alongside the incidents list
        // so the Cost column reflects in-flight workflow spend. Failure
        // here doesn't disturb the main incidents view.
        try {
          const cRes = await fetch('/api/sentinel/incidents/costs', {
            headers: { 'x-pixelagents-token': TOKEN },
          });
          if (cRes.ok) {
            const cData = await cRes.json();
            state.costs = cData.costs || {};
          }
        } catch (_) {
          /* leave previous costs map in place */
        }
      }

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
          const canRun = inc.number != null && !isRunning;
          const btnLabel = isRunning ? 'Running…' : 'Run workflow';

          const owner = inc.owner || '';
          const isAgent = /\bAgent\b/i.test(owner);
          const ownerCell = owner
            ? `<td class="owner-cell ${isAgent ? 'agent-owner' : ''}" title="${escapeHtml(owner)}">${escapeHtml(owner)}</td>`
            : `<td class="owner-cell" style="opacity:0.5">—</td>`;

          let costCell = '';
          if (SHOW_COST) {
            const c = inc.number != null ? state.costs[String(inc.number)] : null;
            const eur = c ? Number(c.total_eur || 0) : 0;
            if (eur > 0) {
              // Format with up to 4 decimal places, trim trailing zeros.
              const pretty = `€${eur.toFixed(4).replace(/\.?0+$/, '')}`;
              costCell = `<td class="cost-cell" title="${c.total_input_tokens} in + ${c.total_output_tokens} out tokens">${escapeHtml(pretty)}</td>`;
            } else {
              costCell = `<td class="cost-cell zero">—</td>`;
            }
          }

          return `
            <tr class="${isRunning ? 'running' : ''}">
              <td class="num">${numCell}</td>
              <td class="title-cell">${escapeHtml(title)}</td>
              <td><span class="sev ${sevClass(sev)}">${escapeHtml(sev)}</span></td>
              <td><span class="status ${statusClass(status)}">${escapeHtml(status)}</span></td>
              ${ownerCell}
              ${costCell}
              <td>
                <button
                  class="run-btn"
                  data-action="run-workflow"
                  data-incident-number="${escapeHtml(numberAttr)}"
                  data-incident-title="${escapeHtml(title)}"
                  ${canRun ? '' : 'disabled'}
                >${btnLabel}</button>
              </td>
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
              <th>Assignee</th>
              ${SHOW_COST ? '<th>Cost</th>' : ''}
              <th></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      `;
    }

    rootEl.innerHTML = `${header}${noticeHtml}<div class="body">${body}</div>`;
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
    } else if (action === 'run-workflow') {
      if (t.disabled) return;
      const rawNum = t.getAttribute('data-incident-number');
      const number = rawNum === '' ? null : Number(rawNum);
      const title = t.getAttribute('data-incident-title') || '';
      startOrchestration(number, title);
    }
  });

  // ── Boot ─────────────────────────────────────────────────────────────────
  render();
  loadIncidents();
  setInterval(loadIncidents, 15000);
})();
