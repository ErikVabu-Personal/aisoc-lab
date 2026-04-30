// audit.js
// ────────────────────────────────────────────────────────────────────
// Renders the Logging & Auditing timeline. Pulls /api/audit which
// aggregates incident actions, workflow runs, change proposals +
// decisions, and SOC Manager review ticks into one feed.

(function () {
  'use strict';

  const ROOT_ID = 'aisoc-audit-root';
  const POLL_MS = 5000;

  const css = `
    #${ROOT_ID} { font: 14px -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }
    #${ROOT_ID} .toolbar {
      display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
      margin-bottom: 14px;
      padding: 10px 12px;
      background: #f9fafb;
      border: 1px solid #e5e7eb;
      border-radius: 6px;
    }
    #${ROOT_ID} .toolbar .label {
      font-size: 11px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: #6b7280;
    }
    #${ROOT_ID} .toolbar select,
    #${ROOT_ID} .toolbar input {
      padding: 4px 8px;
      border: 1px solid #cbd5e1;
      border-radius: 4px;
      font: 13px ui-monospace, SFMono-Regular, Menlo, monospace;
      color: #1f2937;
      background: #ffffff;
    }
    #${ROOT_ID} .toolbar input:focus,
    #${ROOT_ID} .toolbar select:focus {
      outline: none;
      border-color: #0099cc;
      box-shadow: 0 0 0 3px rgba(0,153,204,0.18);
    }
    #${ROOT_ID} .toolbar .totals {
      margin-left: auto;
      font-size: 11px;
      color: #6b7280;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    #${ROOT_ID} table {
      width: 100%;
      border-collapse: collapse;
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 6px;
      overflow: hidden;
    }
    #${ROOT_ID} thead th {
      text-align: left;
      padding: 8px 10px;
      font-size: 11px;
      font-weight: 700;
      color: #6b7280;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      background: #f9fafb;
      border-bottom: 1px solid #e5e7eb;
    }
    #${ROOT_ID} tbody td {
      padding: 8px 10px;
      border-top: 1px solid #f3f4f6;
      font-size: 12.5px;
      vertical-align: top;
      color: #1f2937;
    }
    #${ROOT_ID} td.ts {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      color: #6b7280;
      white-space: nowrap;
    }
    #${ROOT_ID} td.kind {
      font-size: 10.5px;
      font-weight: 700;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      white-space: nowrap;
    }
    #${ROOT_ID} td.kind .pill {
      padding: 2px 8px;
      border-radius: 999px;
      background: #f3f4f6;
      color: #6b7280;
    }
    #${ROOT_ID} tr.k-incident_audit       td.kind .pill { background: rgba(124,58,237,0.16); color: #4c1d95; }
    #${ROOT_ID} tr.k-workflow_run         td.kind .pill { background: rgba(0,153,204,0.16);  color: #1e3a8a; }
    #${ROOT_ID} tr.k-change_proposed      td.kind .pill { background: rgba(245,158,11,0.20); color: #92400e; }
    #${ROOT_ID} tr.k-change_decision      td.kind .pill { background: rgba(16,185,129,0.16); color: #065f46; }
    #${ROOT_ID} tr.k-soc_manager_review   td.kind .pill { background: rgba(0,153,204,0.16);  color: #1e3a8a; }
    #${ROOT_ID} td.actor {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      color: #6b7280;
      white-space: nowrap;
    }
    #${ROOT_ID} td.summary {
      font-size: 12.5px;
    }
    #${ROOT_ID} td.summary code {
      background: #f3f4f6;
      padding: 1px 4px;
      border-radius: 3px;
      font-size: 11.5px;
    }
    #${ROOT_ID} .empty,
    #${ROOT_ID} .err {
      padding: 40px 20px;
      text-align: center;
      color: #6b7280;
      font-style: italic;
      border: 1px dashed #cbd5e1;
      border-radius: 6px;
      background: #f9fafb;
    }
    #${ROOT_ID} .err {
      color: #991b1b;
      font-style: normal;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      border-color: rgba(239,68,68,0.45);
      background: rgba(239,68,68,0.06);
    }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const root = document.getElementById(ROOT_ID);
  if (!root) return;

  const STATE = {
    events: [],
    totals: {},
    error: '',
    kindFilter: 'all',
    actorFilter: '',
    limit: 500,
  };

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }

  function fmtTs(ts) {
    if (!ts) return '—';
    const d = new Date(ts * 1000);
    return d.toLocaleString();
  }

  function kindLabel(k) {
    return ({
      incident_audit: 'Incident',
      workflow_run: 'Workflow',
      change_proposed: 'Proposed',
      change_decision: 'Decided',
      soc_manager_review: 'Review',
    })[k] || k;
  }

  function actorOf(ev) {
    if (ev.kind === 'incident_audit')   return ev.actor || '';
    if (ev.kind === 'change_decision')  return ev.reviewer || '';
    if (ev.kind === 'change_proposed')  return ev.proposed_by || '';
    if (ev.kind === 'soc_manager_review') {
      const t = String(ev.trigger || '');
      if (t.startsWith('manual:')) return t.slice('manual:'.length);
      return '— (loop)';
    }
    return '';
  }

  function summaryOf(ev) {
    const incHref = (n) => `/dashboard"><code>#${escapeHtml(n)}</code></a>`;
    const incLink = (n) => (n != null) ? `<a href="/dashboard"><code>#${escapeHtml(n)}</code></a>` : '';
    if (ev.kind === 'incident_audit') {
      const action = ev.action || '?';
      const det = ev.details || {};
      const detStr = Object.keys(det).length
        ? ' · ' + Object.entries(det).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')
        : '';
      return `${incLink(ev.incident_number)} <strong>${escapeHtml(action)}</strong>${escapeHtml(detStr)}`;
    }
    if (ev.kind === 'workflow_run') {
      const phase = ev.phase || '?';
      const dur = ev.duration_sec != null ? ` · ${ev.duration_sec}s` : '';
      const st = ev.status ? ` · status=${escapeHtml(ev.status)}` : '';
      return `${incLink(ev.incident_number)} <strong>${escapeHtml(phase)}</strong> (${escapeHtml(ev.mode || '?')}${st}${escapeHtml(dur)})`;
    }
    if (ev.kind === 'change_proposed') {
      const target = ev.target ? ` → ${escapeHtml(ev.target)}` : '';
      return `<strong>${escapeHtml(ev.change_kind)}</strong>${target}: ${escapeHtml(ev.title || '(untitled)')}`;
    }
    if (ev.kind === 'change_decision') {
      const note = ev.review_note ? ` — note: ${escapeHtml(ev.review_note).slice(0, 200)}` : '';
      return `<strong>${escapeHtml(ev.decision)}</strong> ${escapeHtml(ev.change_kind)}: ${escapeHtml(ev.title || ev.change_id || '?')}${note}`;
    }
    if (ev.kind === 'soc_manager_review') {
      return `Periodic review · ${escapeHtml(String(ev.runs_summarized ?? '?'))} runs summarised`;
    }
    return '';
  }

  function applyFilters(events) {
    let out = events;
    if (STATE.kindFilter && STATE.kindFilter !== 'all') {
      out = out.filter((e) => e.kind === STATE.kindFilter);
    }
    if (STATE.actorFilter) {
      const q = STATE.actorFilter.toLowerCase();
      out = out.filter((e) => actorOf(e).toLowerCase().includes(q));
    }
    return out;
  }

  function render() {
    const filtered = applyFilters(STATE.events);

    let body = '';
    body += '<div class="toolbar">';
    body += `<span class="label">Kind</span>`;
    body += `<select data-filter="kind">`;
    for (const [k, label] of [
      ['all', 'All kinds'],
      ['incident_audit', 'Incident actions'],
      ['workflow_run', 'Workflow runs'],
      ['change_proposed', 'Proposals'],
      ['change_decision', 'Decisions'],
      ['soc_manager_review', 'SOC Manager reviews'],
    ]) {
      const sel = STATE.kindFilter === k ? 'selected' : '';
      body += `<option value="${k}" ${sel}>${escapeHtml(label)}</option>`;
    }
    body += `</select>`;
    body += `<span class="label">Actor</span>`;
    body += `<input type="text" data-filter="actor" placeholder="email or agent slug…" value="${escapeHtml(STATE.actorFilter)}">`;
    const t = STATE.totals || {};
    body += `<span class="totals">`
          + `incidents: ${t.incident_audit ?? 0} · `
          + `runs: ${t.workflow_run ?? 0} · `
          + `proposals: ${t.change_proposed ?? 0} · `
          + `decisions: ${t.change_decision ?? 0} · `
          + `reviews: ${t.soc_manager_review ?? 0}`
          + `</span>`;
    body += '</div>';

    if (STATE.error) {
      body += `<div class="err">${escapeHtml(STATE.error)}</div>`;
    } else if (!filtered.length) {
      body += `<div class="empty">No matching events. Activity will appear here as agents work and humans act.</div>`;
    } else {
      body += '<table>';
      body += '<thead><tr>'
            + '<th style="width:170px;">When</th>'
            + '<th style="width:90px;">Kind</th>'
            + '<th style="width:200px;">Actor</th>'
            + '<th>Summary</th>'
            + '</tr></thead>';
      body += '<tbody>';
      for (const ev of filtered) {
        body += `<tr class="k-${escapeHtml(ev.kind)}">`;
        body += `<td class="ts">${escapeHtml(fmtTs(ev.ts))}</td>`;
        body += `<td class="kind"><span class="pill">${escapeHtml(kindLabel(ev.kind))}</span></td>`;
        body += `<td class="actor">${escapeHtml(actorOf(ev) || '—')}</td>`;
        body += `<td class="summary">${summaryOf(ev)}</td>`;
        body += `</tr>`;
      }
      body += '</tbody></table>';
    }
    root.innerHTML = body;

    const kindSel = root.querySelector('[data-filter="kind"]');
    if (kindSel) {
      kindSel.addEventListener('change', () => {
        STATE.kindFilter = kindSel.value;
        render();
      });
    }
    const actorInput = root.querySelector('[data-filter="actor"]');
    if (actorInput) {
      actorInput.addEventListener('input', () => {
        STATE.actorFilter = actorInput.value;
        render();
      });
    }
  }

  async function poll() {
    try {
      const r = await fetch(`/api/audit?limit=${STATE.limit}`, { credentials: 'same-origin' });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        STATE.error = `Failed to load audit log: HTTP ${r.status} ${text.slice(0, 200)}`;
        render();
        return;
      }
      const data = await r.json();
      STATE.events = (data && data.events) || [];
      STATE.totals = (data && data.totals) || {};
      STATE.error = '';
      render();
    } catch (e) {
      STATE.error = `Network error: ${e.message || e}`;
      render();
    }
  }

  poll();
  setInterval(poll, POLL_MS);
})();
