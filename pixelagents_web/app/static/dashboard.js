// dashboard.js
// ────────────────────────────────────────────────────────────────────
// Renders the operator-facing Sentinel incidents table for the
// Agentic SOC Dashboard. Each row has an inline "Run workflow"
// button that POSTs /api/sentinel/incidents/{n}/orchestrate.
// Costs come from /api/sentinel/incidents/costs.

(function () {
  'use strict';

  const ROOT_ID = 'aisoc-dashboard-root';
  const POLL_INCIDENTS_MS = 8000;
  const POLL_COSTS_MS = 3000;
  const POLL_CURRENT_MS = 1500;
  const RUNNING_STALE_MS = 60_000;   // a phase >60s old without progression = probably stuck

  // ── Styles ──────────────────────────────────────────────────────────
  const css = `
    #${ROOT_ID} { font: 14px -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
    #${ROOT_ID} .summary {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 14px;
      margin-bottom: 28px;
    }
    #${ROOT_ID} .stat {
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 16px 18px;
    }
    #${ROOT_ID} .stat .label {
      color: #6b7280;
      font-size: 12px;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      margin-bottom: 6px;
    }
    #${ROOT_ID} .stat .value {
      font-size: 22px;
      font-weight: 700;
      color: #1f2937;
      font-variant-numeric: tabular-nums;
    }
    #${ROOT_ID} .stat.accent .value { color: #0099cc; }

    #${ROOT_ID} table {
      width: 100%;
      border-collapse: collapse;
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      overflow: hidden;
    }
    #${ROOT_ID} thead th {
      text-align: left;
      padding: 10px 14px;
      font-size: 12px;
      font-weight: 700;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      background: #f9fafb;
      border-bottom: 1px solid #e5e7eb;
    }
    #${ROOT_ID} tbody td {
      padding: 12px 14px;
      border-top: 1px solid #f3f4f6;
      font-size: 14px;
      vertical-align: middle;
    }
    #${ROOT_ID} tbody tr.running { background: rgba(0,153,204,0.06); }
    #${ROOT_ID} .num { font-weight: 700; color: #0e2a47; }
    #${ROOT_ID} .title { max-width: 420px; }
    #${ROOT_ID} .cost { text-align: right; font-variant-numeric: tabular-nums; }

    #${ROOT_ID} .sev {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    #${ROOT_ID} .sev.high           { color: #991b1b; background: rgba(239,68,68,0.12);  border: 1px solid rgba(239,68,68,0.4); }
    #${ROOT_ID} .sev.medium         { color: #92400e; background: rgba(245,158,11,0.12); border: 1px solid rgba(245,158,11,0.4); }
    #${ROOT_ID} .sev.low            { color: #166534; background: rgba(34,197,94,0.12);  border: 1px solid rgba(34,197,94,0.4); }
    #${ROOT_ID} .sev.informational  { color: #1e40af; background: rgba(0,153,204,0.12);  border: 1px solid rgba(0,153,204,0.4); }

    #${ROOT_ID} .status {
      font-size: 13px;
      font-weight: 500;
    }
    #${ROOT_ID} .status.new    { color: #991b1b; }
    #${ROOT_ID} .status.active { color: #92400e; }
    #${ROOT_ID} .status.closed { color: #6b7280; }

    #${ROOT_ID} button.run {
      background: #0099cc;
      color: #ffffff;
      border: none;
      padding: 6px 14px;
      border-radius: 4px;
      font-weight: 600;
      font-size: 13px;
      cursor: pointer;
    }
    #${ROOT_ID} button.run:hover { background: #33b0dd; }
    #${ROOT_ID} button.run:disabled {
      background: #cbd5e1; cursor: not-allowed;
    }

    #${ROOT_ID} .row-spinner {
      display: inline-block;
      width: 12px; height: 12px;
      border: 2px solid rgba(0,153,204,0.4);
      border-top-color: #0099cc;
      border-radius: 50%;
      animation: aisoc-dash-spin 0.9s linear infinite;
      vertical-align: middle;
      margin-right: 6px;
    }
    @keyframes aisoc-dash-spin { to { transform: rotate(360deg); } }

    #${ROOT_ID} .empty,
    #${ROOT_ID} .err {
      padding: 24px;
      text-align: center;
      color: #6b7280;
      font-style: italic;
    }
    #${ROOT_ID} .err {
      color: #991b1b;
      font-style: normal;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 13px;
      text-align: left;
      white-space: pre-wrap;
    }

    #${ROOT_ID} .notice {
      margin: 14px 0;
      padding: 8px 12px;
      border-radius: 4px;
      font-size: 13px;
    }
    #${ROOT_ID} .notice.info    { background: rgba(0,153,204,0.10); color: #1e40af; }
    #${ROOT_ID} .notice.success { background: rgba(34,197,94,0.10); color: #166534; }
    #${ROOT_ID} .notice.error   { background: rgba(239,68,68,0.10); color: #991b1b;
                                   font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
                                   white-space: pre-wrap; }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ── State ──────────────────────────────────────────────────────────
  const root = document.getElementById(ROOT_ID);
  if (!root) return;

  let incidents = [];
  let costs = {};                  // map keyed by incident number (string)
  let currentIncident = null;      // { incident_number, started_at } or null
  let notice = null;               // { kind: 'info'|'success'|'error', text: string }

  // ── Helpers ────────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function fmtEur(eur) {
    if (eur == null) return '€ 0.0000';
    return '€ ' + Number(eur).toFixed(4);
  }

  function totalEur() {
    return Object.values(costs).reduce(
      (acc, b) => acc + (Number((b && b.total_eur) || 0)), 0
    );
  }

  function severityClass(sev) {
    return String(sev || '').toLowerCase();
  }

  function isRunning(incidentNumber) {
    return currentIncident && Number(currentIncident.incident_number) === Number(incidentNumber);
  }

  function fmtElapsed(secs) {
    if (secs < 60) return `${Math.floor(secs)}s`;
    const m = Math.floor(secs / 60), s = Math.floor(secs % 60);
    return `${m}m${String(s).padStart(2, '0')}s`;
  }

  function activeWorkflowSummary() {
    if (!currentIncident || currentIncident.incident_number == null) return null;
    const num = currentIncident.incident_number;
    const started = currentIncident.started_at;
    const elapsed = started ? (Date.now() / 1000) - started : null;
    const cost = costs[String(num)] || {};
    const phase = cost.last_phase || null;
    return { num, elapsed, phase };
  }

  // ── Render ─────────────────────────────────────────────────────────
  function render() {
    const incidentCount = incidents.length;
    const total = totalEur();
    const active = activeWorkflowSummary();

    let body = '';
    body += '<div class="summary">';
    body += `<div class="stat"><div class="label">Open incidents</div><div class="value">${incidentCount}</div></div>`;
    body += `<div class="stat accent"><div class="label">Total agent cost</div><div class="value">${fmtEur(total)}</div></div>`;
    if (active) {
      const phaseLabel = active.phase ? `phase ${escapeHtml(active.phase)}` : 'starting…';
      const elapsed = active.elapsed != null ? fmtElapsed(active.elapsed) : '—';
      body += `<div class="stat accent"><div class="label">Active workflow</div>`
            + `<div class="value">#${active.num}</div>`
            + `<div style="font-size:12px;color:#6b7280;margin-top:4px;">`
            + `<span class="row-spinner" style="vertical-align:middle;margin-right:4px;"></span>`
            + `${phaseLabel} · ${elapsed}</div></div>`;
    } else {
      body += `<div class="stat"><div class="label">Active workflow</div>`
            + `<div class="value" style="color:#6b7280;">Idle</div></div>`;
    }
    body += '</div>';

    if (notice) {
      body += `<div class="notice ${notice.kind}">${escapeHtml(notice.text)}</div>`;
    }

    body += '<h2>Incidents</h2>';
    if (!incidentCount) {
      body += '<div class="empty">No incidents to show. Trigger a few failed logins to see them appear here.</div>';
    } else {
      body += '<table>';
      body += '<thead><tr>'
        + '<th style="width:60px;">#</th>'
        + '<th>Title</th>'
        + '<th style="width:110px;">Severity</th>'
        + '<th style="width:90px;">Status</th>'
        + '<th class="cost" style="width:120px;">Cost</th>'
        + '<th style="width:130px;"></th>'
        + '</tr></thead>';
      body += '<tbody>';
      for (const inc of incidents) {
        const num = inc.number;
        const running = isRunning(num);
        const cost = costs[String(num)] || {};
        const eur = cost.total_eur || 0;
        body += `<tr class="${running ? 'running' : ''}">`;
        body += `<td class="num">#${num}</td>`;
        body += `<td class="title">${escapeHtml(inc.title || '')}</td>`;
        body += `<td><span class="sev ${severityClass(inc.severity)}">${escapeHtml(inc.severity || '?')}</span></td>`;
        body += `<td><span class="status ${severityClass(inc.status)}">${escapeHtml(inc.status || '?')}</span></td>`;
        body += `<td class="cost">${eur > 0 ? fmtEur(eur) : '—'}</td>`;
        body += '<td>';
        if (running) {
          const phase = cost.last_phase || 'starting';
          body += `<span class="row-spinner"></span>`
                + `<span style="font-size:12px;color:#6b7280;">${escapeHtml(phase)}…</span>`;
        } else {
          body += `<button class="run" data-incident="${num}">Run workflow</button>`;
        }
        body += '</td>';
        body += '</tr>';
      }
      body += '</tbody></table>';
    }

    root.innerHTML = body;

    root.querySelectorAll('button.run').forEach((btn) => {
      btn.addEventListener('click', () => onRunWorkflow(Number(btn.dataset.incident)));
    });
  }

  // ── Actions ────────────────────────────────────────────────────────
  async function onRunWorkflow(incidentNumber) {
    if (isRunning(incidentNumber)) return;
    notice = { kind: 'info', text: `Starting workflow for incident #${incidentNumber}…` };
    // Optimistic UI: stamp it as the active incident so the row
    // flips to "starting…" before /api/current_incident reflects it.
    currentIncident = { incident_number: incidentNumber, started_at: Date.now() / 1000 };
    render();

    try {
      const r = await fetch(`/api/sentinel/incidents/${incidentNumber}/orchestrate`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(`HTTP ${r.status}\n${text}`);
      }
      notice = { kind: 'success', text: `Workflow completed for incident #${incidentNumber}.` };
    } catch (e) {
      notice = { kind: 'error', text: `Workflow failed for #${incidentNumber}\n${e.message || e}` };
    } finally {
      // Refresh the server-driven state so the row reverts to idle.
      pollCurrent();
      pollCosts();
      render();
    }
  }

  // ── Polling ────────────────────────────────────────────────────────
  async function pollIncidents() {
    try {
      const r = await fetch('/api/sentinel/incidents', { credentials: 'same-origin' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      incidents = (data && data.incidents) || [];
      render();
    } catch (e) {
      // Show the error inline once instead of clobbering the table.
      if (!incidents.length) {
        root.innerHTML = `<div class="err">Failed to load incidents: ${escapeHtml(e.message || String(e))}</div>`;
      }
    }
  }

  async function pollCosts() {
    try {
      const r = await fetch('/api/sentinel/incidents/costs', { credentials: 'same-origin' });
      if (!r.ok) return;
      const data = await r.json();
      // Endpoint returns { costs: { "1": {...}, "2": {...} }, ts: ... }
      costs = (data && data.costs) || {};
      render();
    } catch (_) { /* swallow */ }
  }

  // Poll the server-side "currently orchestrating" marker so the
  // running state survives navigation. Set by /api/sentinel/incidents/
  // {n}/orchestrate at the start of a run, cleared when it returns.
  async function pollCurrent() {
    try {
      const r = await fetch('/api/current_incident', { credentials: 'same-origin' });
      if (!r.ok) return;
      const data = await r.json();
      currentIncident = (data && data.incident_number != null) ? data : null;
      render();
    } catch (_) { /* swallow */ }
  }

  pollIncidents();
  pollCosts();
  pollCurrent();
  setInterval(pollIncidents, POLL_INCIDENTS_MS);
  setInterval(pollCosts, POLL_COSTS_MS);
  setInterval(pollCurrent, POLL_CURRENT_MS);
})();
