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
    #${ROOT_ID} .num a {
      color: inherit;
      text-decoration: none;
      border-bottom: 1px dotted #cbd5e1;
    }
    #${ROOT_ID} .num a:hover {
      color: #0099cc;
      border-bottom-color: #0099cc;
    }
    #${ROOT_ID} .num a .ext {
      font-size: 11px;
      margin-left: 4px;
      color: #6b7280;
      vertical-align: top;
    }
    #${ROOT_ID} .num a:hover .ext { color: #0099cc; }
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

    /* Status pill — simple 1:1 with Sentinel statuses
       (new / active / closed). Owner-aware nuance moved to its own
       column. */
    #${ROOT_ID} .status {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 2px 10px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
      border: 1px solid transparent;
    }
    #${ROOT_ID} .status .dot {
      width: 6px; height: 6px;
      border-radius: 50%;
      background: currentColor;
      flex-shrink: 0;
    }
    #${ROOT_ID} .status.new {
      color: #991b1b; background: rgba(239,68,68,0.10); border-color: rgba(239,68,68,0.35);
    }
    #${ROOT_ID} .status.active {
      color: #92400e; background: rgba(245,158,11,0.12); border-color: rgba(245,158,11,0.4);
    }
    #${ROOT_ID} .status.closed {
      color: #6b7280; background: #f3f4f6; border-color: #e5e7eb;
    }
    #${ROOT_ID} .status.unknown {
      color: #6b7280; background: #f9fafb; border-color: #e5e7eb;
    }

    /* Owner column — shows the current owner.assignedTo. Visually
       distinguishes agents (Triage Agent, Reporter Agent, ...) from
       humans (email-shaped) so the agent-vs-human story is clear at
       a glance. */
    #${ROOT_ID} .owner {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      font-size: 13px;
      max-width: 180px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    #${ROOT_ID} .owner.agent {
      color: #1e40af;
    }
    #${ROOT_ID} .owner.human {
      color: #1f2937;
    }
    #${ROOT_ID} .owner.unassigned {
      color: #9ca3af;
      font-style: italic;
    }
    #${ROOT_ID} .owner .who-icon {
      flex-shrink: 0;
      width: 14px; height: 14px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 11px;
      font-weight: 700;
      border-radius: 4px;
      letter-spacing: -0.05em;
    }
    #${ROOT_ID} .owner.agent .who-icon {
      color: #1e40af;
      background: rgba(0,153,204,0.16);
    }
    #${ROOT_ID} .owner.human .who-icon {
      color: #065f46;
      background: rgba(16,185,129,0.16);
    }

    /* Filter dropdowns above the incidents table. */
    #${ROOT_ID} .filters {
      display: flex;
      gap: 10px;
      align-items: center;
      margin-bottom: 12px;
      flex-wrap: wrap;
    }
    #${ROOT_ID} .filters label {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: #6b7280;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    #${ROOT_ID} .filters select {
      padding: 4px 26px 4px 10px;
      border: 1px solid #cbd5e1;
      border-radius: 4px;
      background: #ffffff;
      font: 13px -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      color: #1f2937;
      cursor: pointer;
    }
    #${ROOT_ID} .filters select:focus {
      outline: none;
      border-color: #0099cc;
      box-shadow: 0 0 0 3px rgba(0,153,204,0.18);
    }
    #${ROOT_ID} .filters .count {
      font-size: 12px;
      color: #6b7280;
      margin-left: auto;
      font-variant-numeric: tabular-nums;
    }
    #${ROOT_ID} .filters .clear-btn {
      padding: 4px 10px;
      border: 1px solid #cbd5e1;
      background: transparent;
      color: #0099cc;
      font: 600 12px -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      border-radius: 4px;
      cursor: pointer;
    }
    #${ROOT_ID} .filters .clear-btn:hover {
      background: #f0f9ff;
      border-color: #0099cc;
    }

    /* Click-to-edit cells (Status + Owner). The pill stays visible
       on hover with a subtle outline so analysts can tell they're
       editable; the inline <select> takes over on click. */
    #${ROOT_ID} .editable {
      cursor: pointer;
      border-radius: 999px;
      transition: outline 0.1s ease;
      outline: 1px dashed transparent;
      outline-offset: 2px;
    }
    #${ROOT_ID} .editable:hover {
      outline-color: #cbd5e1;
    }
    #${ROOT_ID} .editable.saving {
      opacity: 0.55;
      cursor: wait;
    }
    #${ROOT_ID} td select.cell-edit {
      padding: 3px 6px;
      border: 1px solid #0099cc;
      border-radius: 4px;
      background: #ffffff;
      font: 13px -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      color: #1f2937;
      cursor: pointer;
    }
    #${ROOT_ID} td select.cell-edit:focus {
      outline: none;
      box-shadow: 0 0 0 3px rgba(0,153,204,0.18);
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

    #${ROOT_ID} .runs-badge {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 3px 10px; border: 1px solid #cbd5e1; border-radius: 999px;
      background: #f9fafb; color: #374151;
      font-size: 12px; font-weight: 600;
      cursor: pointer; user-select: none;
    }
    #${ROOT_ID} .runs-badge:hover { background: #e5e7eb; }
    #${ROOT_ID} .runs-badge.fail { border-color: #ef4444; color: #991b1b; background: rgba(239,68,68,0.08); }
    #${ROOT_ID} .runs-badge.ok   { border-color: #22c55e; color: #166534; background: rgba(34,197,94,0.10); }
    #${ROOT_ID} .runs-badge.run  { border-color: #0099cc; color: #1e40af; background: rgba(0,153,204,0.10); }

    #${ROOT_ID} tr.runs-row > td {
      padding: 0 14px 12px !important;
      background: #f9fafb;
      border-top: none !important;
    }
    #${ROOT_ID} .runs-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 12px;
    }
    #${ROOT_ID} .runs-table th {
      text-align: left;
      padding: 6px 8px;
      color: #6b7280;
      font-size: 11px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      border-bottom: 1px solid #e5e7eb;
    }
    #${ROOT_ID} .runs-table td {
      padding: 6px 8px;
      border-top: 1px solid #f3f4f6;
      vertical-align: top;
    }
    #${ROOT_ID} .runs-table tr.run-summary { cursor: pointer; }
    #${ROOT_ID} .runs-table tr.run-summary:hover { background: #ffffff; }
    #${ROOT_ID} .runs-table tr.run-detail > td {
      background: #ffffff;
      padding: 8px 10px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      white-space: pre-wrap;
      word-break: break-word;
      color: #1f2937;
    }
    #${ROOT_ID} .runs-table tr.run-detail.failed > td { color: #991b1b; background: rgba(239,68,68,0.06); }
    #${ROOT_ID} .runs-empty {
      padding: 8px;
      color: #6b7280;
      font-style: italic;
      font-size: 12px;
    }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ── State ──────────────────────────────────────────────────────────
  const root = document.getElementById(ROOT_ID);
  if (!root) return;

  let incidents = [];
  let costs = {};                  // map keyed by incident number (string)
  let runsSummary = {};            // map: incident_number -> {count, last_status, ...}
  const runsDetail = {};           // map: incident_number -> [run record, ...] (lazy-fetched)
  const expandedIncidents = new Set();  // incident numbers whose run list is open
  const expandedRuns = new Set();        // run_ids whose error/summary is open
  let currentIncident = null;      // { incident_number, started_at } or null
  let notice = null;               // { kind: 'info'|'success'|'error', text: string }
  // Click-to-edit state — which cell is currently in edit mode.
  // Both maps key by incident number (string). Mutually exclusive
  // per row (you only edit one cell at a time).
  let editingOwner = null;         // string incident number or null
  let editingStatus = null;        // string incident number or null
  let savingCell = null;           // 'owner-N' or 'status-N' while POST is in flight
  // Configured user roster — fetched once on first poll. Used to
  // populate the Owner edit dropdown. Includes self.
  let userRoster = [];             // [{email, ...}]
  // Filter state — empty string = no filter on that axis.
  let filterSeverity = '';
  let filterStatus = '';
  let filterOwner = '';

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

  // Sentinel statuses, 1:1. Status is just one of New / Active /
  // Closed; the agent-vs-human distinction now lives in the Owner
  // column (rendered separately).
  function statusLabel(s) {
    const k = String(s || '').toLowerCase();
    if (k === 'new')    return 'New';
    if (k === 'active') return 'Active';
    if (k === 'closed') return 'Closed';
    return s || 'Unknown';
  }
  function statusClass(s) {
    const k = String(s || '').toLowerCase();
    return ['new', 'active', 'closed'].includes(k) ? k : 'unknown';
  }

  // Classify the owner string returned by /api/sentinel/incidents
  // (Sentinel's owner.assignedTo). Heuristic: emails are humans,
  // strings ending in " Agent" are agents, the rest is unassigned /
  // unknown.
  function ownerKind(ownerRaw) {
    const s = String(ownerRaw || '').trim();
    if (!s) return 'unassigned';
    if (s.includes('@')) return 'human';
    if (/agent\b/i.test(s)) return 'agent';
    return 'human';  // safest bet — show as human-attributable text
  }
  function ownerLabel(ownerRaw) {
    const s = String(ownerRaw || '').trim();
    return s || 'Unassigned';
  }

  function isRunning(incidentNumber) {
    return currentIncident && Number(currentIncident.incident_number) === Number(incidentNumber);
  }

  function fmtElapsed(secs) {
    if (secs < 60) return `${Math.floor(secs)}s`;
    const m = Math.floor(secs / 60), s = Math.floor(secs % 60);
    return `${m}m${String(s).padStart(2, '0')}s`;
  }

  function fmtDuration(start, end) {
    if (!start) return '';
    const e = end || (Date.now() / 1000);
    const sec = Math.max(0, e - start);
    return fmtElapsed(sec);
  }

  function sentinelPortalUrl(inc) {
    // Sentinel's incident blade is reached via the "asset" deep-link format.
    // The arm_id field already includes the full /subscriptions/... path so
    // this renders correctly even if the demo moves between subscriptions.
    if (!inc || !inc.arm_id) return null;
    return `https://portal.azure.com/#asset/Microsoft_Azure_Security_Insights/Incident${inc.arm_id}`;
  }

  function statusIcon(status) {
    if (status === 'completed') return '<span style="color:#166534;font-weight:700;">✓</span>';
    if (status === 'failed')    return '<span style="color:#991b1b;font-weight:700;">✗</span>';
    if (status === 'running')   return '<span class="row-spinner" style="vertical-align:middle;"></span>';
    return '<span style="color:#6b7280;">·</span>';
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

    // Filter dropdowns. Owner options are computed dynamically from
    // current data so the list reflects actual active owners (humans
    // + "Triage Agent" / "Reporter Agent" depending on what's in
    // play). Selecting a filter value persists across re-renders
    // until cleared.
    const ownersInData = Array.from(
      new Set(incidents.map((i) => (i.owner || '').trim()).filter(Boolean))
    ).sort();
    const sevOptions = ['High', 'Medium', 'Low', 'Informational'];
    const statusOptions = ['New', 'Active', 'Closed'];
    body += '<div class="filters">';
    body += '<label>Severity'
          + `<select data-filter="severity">`
          + `<option value="">All</option>`
          + sevOptions.map((s) => `<option value="${escapeHtml(s)}"${filterSeverity === s ? ' selected' : ''}>${escapeHtml(s)}</option>`).join('')
          + `</select></label>`;
    body += '<label>Status'
          + `<select data-filter="status">`
          + `<option value="">All</option>`
          + statusOptions.map((s) => `<option value="${escapeHtml(s)}"${filterStatus === s ? ' selected' : ''}>${escapeHtml(s)}</option>`).join('')
          + `</select></label>`;
    body += '<label>Owner'
          + `<select data-filter="owner">`
          + `<option value="">All</option>`
          + ownersInData.map((o) => `<option value="${escapeHtml(o)}"${filterOwner === o ? ' selected' : ''}>${escapeHtml(o)}</option>`).join('')
          + `</select></label>`;
    if (filterSeverity || filterStatus || filterOwner) {
      body += `<button class="clear-btn" data-clear-filters="1">Clear filters</button>`;
    }

    // Apply filters client-side.
    const filtered = incidents.filter((inc) => {
      if (filterSeverity && (inc.severity || '').toLowerCase() !== filterSeverity.toLowerCase()) return false;
      if (filterStatus && (inc.status || '').toLowerCase() !== filterStatus.toLowerCase()) return false;
      if (filterOwner && (inc.owner || '').trim() !== filterOwner) return false;
      return true;
    });
    body += `<span class="count">Showing ${filtered.length} of ${incidents.length}</span>`;
    body += '</div>';

    if (!incidentCount) {
      body += '<div class="empty">No incidents to show. Trigger a few failed logins to see them appear here.</div>';
    } else if (!filtered.length) {
      body += '<div class="empty">No incidents match the current filters.</div>';
    } else {
      body += '<table>';
      body += '<thead><tr>'
        + '<th style="width:60px;">#</th>'
        + '<th>Title</th>'
        + '<th style="width:110px;">Severity</th>'
        + '<th style="width:110px;">Status</th>'
        + '<th style="width:220px;">Owner</th>'
        + '<th class="cost" style="width:120px;">Cost</th>'
        + '<th style="width:90px;">Runs</th>'
        + '</tr></thead>';
      body += '<tbody>';
      for (const inc of filtered) {
        const num = inc.number;
        const numStr = String(num);
        const running = isRunning(num);
        const cost = costs[numStr] || {};
        const eur = cost.total_eur || 0;
        const summary = runsSummary[numStr] || null;
        const isExpanded = expandedIncidents.has(numStr);

        const portalUrl = sentinelPortalUrl(inc);
        body += `<tr class="${running ? 'running' : ''}">`;
        body += `<td class="num">`;
        if (portalUrl) {
          body += `<a href="${escapeHtml(portalUrl)}" target="_blank" rel="noopener" `
                + `title="Open incident #${num} in Microsoft Sentinel">`
                + `#${num}<span class="ext">↗</span></a>`;
        } else {
          body += `#${num}`;
        }
        body += `</td>`;
        body += `<td class="title">${escapeHtml(inc.title || '')}</td>`;
        body += `<td><span class="sev ${severityClass(inc.severity)}">${escapeHtml(inc.severity || '?')}</span></td>`;

        // Status cell — click to edit (New / Active; Closed lives
        // in Sentinel itself). When the incident is mid-run we
        // freeze the cell with a spinner so the user can't
        // double-fire.
        {
          const sCls = statusClass(inc.status);
          const sLabel = statusLabel(inc.status);
          const isEditingThis = editingStatus === numStr;
          const isSavingThis = savingCell === `status-${numStr}`;
          body += '<td>';
          if (isEditingThis && !running) {
            body += `<select class="cell-edit" data-edit-status="${num}" autofocus>`
                  + `<option value="">Cancel…</option>`
                  + `<option value="New"${inc.status === 'New' ? ' disabled' : ''}>New (re-triage)</option>`
                  + `<option value="Active"${inc.status === 'Active' ? ' disabled' : ''}>Active</option>`
                  + `</select>`;
          } else if (running) {
            body += `<span class="status ${sCls}" title="Workflow in flight — status edit disabled">`
                  + `<span class="dot"></span>${escapeHtml(sLabel)}`
                  + `</span>`;
          } else {
            const cls = `status ${sCls} editable${isSavingThis ? ' saving' : ''}`;
            body += `<span class="${cls}" data-open-status="${num}" title="Click to change status">`
                  + `<span class="dot"></span>${escapeHtml(sLabel)}`
                  + `</span>`;
          }
          body += '</td>';
        }

        // Owner cell — click to edit. Options are "Triage Agent"
        // (kicks off a triage_only run via the orchestrator) and
        // every configured human (writes Sentinel owner directly).
        {
          const kind = ownerKind(inc.owner);
          const label = ownerLabel(inc.owner);
          const icon = kind === 'agent' ? 'AI'
                     : kind === 'human' ? '👤'
                     : '';
          const iconHtml = icon
            ? `<span class="who-icon">${escapeHtml(icon)}</span>`
            : '';
          const isEditingThis = editingOwner === numStr;
          const isSavingThis = savingCell === `owner-${numStr}`;
          body += '<td>';
          if (isEditingThis && !running) {
            const userOpts = userRoster
              .map((u) => `<option value="${escapeHtml(u.email)}"${(inc.owner || '').toLowerCase() === u.email.toLowerCase() ? ' disabled' : ''}>${escapeHtml(u.email)}${u.is_self ? ' (you)' : ''}</option>`)
              .join('');
            body += `<select class="cell-edit" data-edit-owner="${num}" autofocus>`
                  + `<option value="">Cancel…</option>`
                  + `<option value="Triage Agent">⚡ Triage Agent (re-triage)</option>`
                  + userOpts
                  + `</select>`;
          } else if (running) {
            body += `<span class="owner ${kind}" title="Workflow in flight — owner edit disabled">`
                  + `${iconHtml}${escapeHtml(label)}`
                  + `</span>`;
          } else {
            const cls = `owner ${kind} editable${isSavingThis ? ' saving' : ''}`;
            body += `<span class="${cls}" data-open-owner="${num}" title="Click to reassign">`
                  + `${iconHtml}${escapeHtml(label)}`
                  + `</span>`;
          }
          body += '</td>';
        }

        body += `<td class="cost">${eur > 0 ? fmtEur(eur) : '—'}</td>`;

        // Runs badge — class flips to fail/ok/run based on most recent run.
        body += '<td>';
        if (summary && summary.count > 0) {
          const cls = summary.last_status === 'failed' ? 'fail'
                    : summary.last_status === 'completed' ? 'ok'
                    : 'run';
          const chev = isExpanded ? '▾' : '▸';
          body += `<span class="runs-badge ${cls}" data-runs-toggle="${num}">${chev} ${summary.count} run${summary.count === 1 ? '' : 's'}</span>`;
        } else {
          body += '<span style="color:#9ca3af;font-size:12px;">—</span>';
        }
        body += '</td>';

        body += '</tr>';

        // Expanded sub-row: list of runs with click-to-show details.
        if (isExpanded) {
          const list = runsDetail[String(num)] || [];
          body += '<tr class="runs-row"><td colspan="7">';
          if (!list.length) {
            body += '<div class="runs-empty">No runs yet.</div>';
          } else {
            body += '<table class="runs-table"><thead><tr>'
                  + '<th style="width:24px;"></th>'
                  + '<th>Started</th>'
                  + '<th>Mode</th>'
                  + '<th>Duration</th>'
                  + '<th>Status</th>'
                  + '<th>Detail</th>'
                  + '</tr></thead><tbody>';
            for (const run of list) {
              const detailOpen = expandedRuns.has(run.run_id);
              const startedStr = run.started_at ? new Date(run.started_at * 1000).toLocaleString() : '—';
              const dur = fmtDuration(run.started_at, run.ended_at);
              body += `<tr class="run-summary" data-run-toggle="${escapeHtml(run.run_id)}">`;
              body += `<td>${statusIcon(run.status)}</td>`;
              body += `<td>${escapeHtml(startedStr)}</td>`;
              body += `<td>${escapeHtml(run.mode || '')}</td>`;
              body += `<td>${escapeHtml(dur)}</td>`;
              body += `<td>${escapeHtml(run.status)}</td>`;
              body += `<td>${escapeHtml(run.error ? 'click to see error' : (run.summary || (run.status === 'running' ? 'in progress' : '—')))}</td>`;
              body += '</tr>';
              if (detailOpen) {
                const cls = run.status === 'failed' ? 'failed' : '';
                const detailText = run.error || run.summary || JSON.stringify(run, null, 2);
                body += `<tr class="run-detail ${cls}"><td colspan="6">${escapeHtml(detailText)}</td></tr>`;
              }
            }
            body += '</tbody></table>';
          }
          body += '</td></tr>';
        }
      }
      body += '</tbody></table>';
    }

    root.innerHTML = body;

    // Filter dropdowns.
    root.querySelectorAll('[data-filter]').forEach((sel) => {
      sel.addEventListener('change', () => {
        const which = sel.getAttribute('data-filter');
        if (which === 'severity') filterSeverity = sel.value;
        else if (which === 'status') filterStatus = sel.value;
        else if (which === 'owner') filterOwner = sel.value;
        render();
      });
    });
    const clearBtn = root.querySelector('[data-clear-filters]');
    if (clearBtn) {
      clearBtn.addEventListener('click', () => {
        filterSeverity = ''; filterStatus = ''; filterOwner = '';
        render();
      });
    }

    // Click-to-edit triggers — Status pill / Owner pill.
    root.querySelectorAll('[data-open-status]').forEach((el) => {
      el.addEventListener('click', () => {
        editingStatus = el.getAttribute('data-open-status');
        editingOwner = null;  // mutually exclusive
        render();
      });
    });
    root.querySelectorAll('[data-open-owner]').forEach((el) => {
      el.addEventListener('click', () => {
        editingOwner = el.getAttribute('data-open-owner');
        editingStatus = null;
        render();
      });
    });
    // The active edit selects — change handler dispatches to the
    // server, blur cancels back to read-only without saving.
    root.querySelectorAll('[data-edit-status]').forEach((sel) => {
      sel.addEventListener('change', () => {
        const num = Number(sel.getAttribute('data-edit-status'));
        const newStatus = sel.value;
        if (!newStatus) { editingStatus = null; render(); return; }
        onStatusEdit(num, newStatus);
      });
      sel.addEventListener('blur', () => {
        editingStatus = null;
        render();
      });
    });
    root.querySelectorAll('[data-edit-owner]').forEach((sel) => {
      sel.addEventListener('change', () => {
        const num = Number(sel.getAttribute('data-edit-owner'));
        const newOwner = sel.value;
        if (!newOwner) { editingOwner = null; render(); return; }
        onOwnerEdit(num, newOwner);
      });
      sel.addEventListener('blur', () => {
        editingOwner = null;
        render();
      });
    });
    // "X runs" badge — toggle the per-incident sub-row + lazy-fetch the
    // detailed run list the first time the badge is opened.
    root.querySelectorAll('[data-runs-toggle]').forEach((el) => {
      el.addEventListener('click', () => onToggleRuns(el.getAttribute('data-runs-toggle')));
    });
    // Each run row in the sub-table — toggle its detail panel.
    root.querySelectorAll('[data-run-toggle]').forEach((el) => {
      el.addEventListener('click', () => {
        const id = el.getAttribute('data-run-toggle');
        if (expandedRuns.has(id)) expandedRuns.delete(id);
        else expandedRuns.add(id);
        render();
      });
    });
  }

  async function onToggleRuns(numStr) {
    if (expandedIncidents.has(numStr)) {
      expandedIncidents.delete(numStr);
      render();
      return;
    }
    expandedIncidents.add(numStr);
    render();
    // Fetch the full run list for this incident (the summary endpoint
    // only returns counts + last status — details require this call).
    try {
      const r = await fetch(`/api/sentinel/incidents/${encodeURIComponent(numStr)}/runs`,
                            { credentials: 'same-origin' });
      if (!r.ok) return;
      const data = await r.json();
      runsDetail[numStr] = data.runs || [];
      render();
    } catch (_) { /* swallow */ }
  }

  // ── Actions ────────────────────────────────────────────────────────

  async function postCellEdit(path, body) {
    const r = await fetch(path, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await r.text().catch(() => '');
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch (_) { data = { raw: text }; }
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      const detail = data && data.detail;
      if (typeof detail === 'string') msg = `${msg}: ${detail}`;
      else if (detail && typeof detail === 'object') msg = `${msg}: ${JSON.stringify(detail).slice(0, 400)}`;
      throw new Error(msg);
    }
    return data;
  }

  async function onStatusEdit(incidentNumber, newStatus) {
    const numStr = String(incidentNumber);
    savingCell = `status-${numStr}`;
    editingStatus = null;
    notice = null;
    render();
    try {
      const data = await postCellEdit(
        `/api/sentinel/incidents/${incidentNumber}/status`,
        { status: newStatus },
      );
      if (data.action === 're-triage-triggered') {
        notice = { kind: 'success', text: `Re-triage started for incident #${incidentNumber}.` };
        // Optimistic — flip to "running" so the row spinner shows
        // before the next /api/current_incident poll catches up.
        currentIncident = { incident_number: incidentNumber, started_at: Date.now() / 1000 };
      } else {
        notice = { kind: 'success', text: `Incident #${incidentNumber} status set to ${newStatus}.` };
      }
    } catch (e) {
      notice = { kind: 'error', text: `Failed to update status for #${incidentNumber}: ${e.message || e}` };
    } finally {
      savingCell = null;
      pollIncidents();
      pollCurrent();
      render();
    }
  }

  async function onOwnerEdit(incidentNumber, newOwner) {
    const numStr = String(incidentNumber);
    savingCell = `owner-${numStr}`;
    editingOwner = null;
    notice = null;
    render();
    try {
      const data = await postCellEdit(
        `/api/sentinel/incidents/${incidentNumber}/owner`,
        { owner: newOwner },
      );
      if (data.action === 'triage-triggered') {
        notice = { kind: 'success', text: `Triage started for incident #${incidentNumber}.` };
        currentIncident = { incident_number: incidentNumber, started_at: Date.now() / 1000 };
      } else {
        notice = { kind: 'success', text: `Incident #${incidentNumber} reassigned to ${newOwner}.` };
      }
    } catch (e) {
      notice = { kind: 'error', text: `Failed to reassign #${incidentNumber}: ${e.message || e}` };
    } finally {
      savingCell = null;
      pollIncidents();
      pollCurrent();
      render();
    }
  }

  // ── Roster fetch (drives the Owner edit dropdown) ───────────────────
  async function pollRoster() {
    try {
      const r = await fetch('/api/sessions/online', { credentials: 'same-origin' });
      if (!r.ok) return;
      const data = await r.json();
      // /api/sessions/online returns {users: [...]} that already
      // includes the caller (with is_self=true). Sort: self first,
      // then alpha.
      const list = (data && data.users) || [];
      list.sort((a, b) => {
        if (a.is_self && !b.is_self) return -1;
        if (b.is_self && !a.is_self) return 1;
        return (a.email || '').localeCompare(b.email || '');
      });
      userRoster = list;
    } catch (_) { /* ignore */ }
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

  // Per-incident run-summary (count + last status). Cheap to poll;
  // detail rows are fetched on-demand when an incident is expanded.
  async function pollRuns() {
    try {
      const r = await fetch('/api/sentinel/incidents/runs', { credentials: 'same-origin' });
      if (!r.ok) return;
      const data = await r.json();
      runsSummary = (data && data.runs) || {};
      // Refresh the detail list for any currently-expanded incident so
      // a running workflow's status / duration tick live.
      for (const numStr of expandedIncidents) {
        try {
          const rr = await fetch(`/api/sentinel/incidents/${encodeURIComponent(numStr)}/runs`,
                                  { credentials: 'same-origin' });
          if (rr.ok) {
            const d = await rr.json();
            runsDetail[numStr] = d.runs || [];
          }
        } catch (_) { /* swallow per-incident error */ }
      }
      render();
    } catch (_) { /* swallow */ }
  }

  pollIncidents();
  pollCosts();
  pollCurrent();
  pollRuns();
  pollRoster();  // populates the Owner edit dropdown
  setInterval(pollIncidents, POLL_INCIDENTS_MS);
  setInterval(pollCosts, POLL_COSTS_MS);
  setInterval(pollCurrent, POLL_CURRENT_MS);
  setInterval(pollRuns, POLL_COSTS_MS);
  // Roster doesn't change often; refresh once a minute is plenty.
  setInterval(pollRoster, 60_000);
})();
