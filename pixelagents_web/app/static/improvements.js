// improvements.js
// ────────────────────────────────────────────────────────────────────
// Continuous Improvement dashboard.
//
// Top half: stats cards + by-agent/by-kind breakdowns + a 14-day
// activity sparkline. Bottom half: pending-decision list (the
// review queue) and a "recently decided" tail for context.
//
// Data sources:
//   /api/changes/stats   — slim per-row records + topline counts.
//                          Returns ALL changes (pending + decided),
//                          gated to soc-manager + detection-engineer.
//                          Used to draw the dashboard widgets and the
//                          recent-decisions list.
//   /api/changes/pending — full per-change rows including current/
//                          proposed bodies. Used for the review
//                          cards (so the diff view stays available).
//
// Two endpoints rather than one because /pending already filters by
// the user's role server-side and carries the bulky bodies the
// review cards need; /stats is slim and serves the analytics view.

(function () {
  'use strict';

  const ROOT_ID = 'aisoc-improvements-root';
  const POLL_MS = 4000;

  const STATE = {
    stats:   null,             // /api/changes/stats payload
    pending: [],               // /api/changes/pending changes (with bodies)
    notes:   {},               // change id -> draft note
    sending: new Set(),
    error:   '',
  };

  // ── Styles ─────────────────────────────────────────────────────────
  const css = `
    #${ROOT_ID} { font: 14px -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }

    /* ── Stats cards (top row) ─────────────────────────────────── */
    #${ROOT_ID} .ci-stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    @media (max-width: 900px) {
      #${ROOT_ID} .ci-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); }
    }
    #${ROOT_ID} .stat-card {
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 14px 16px;
    }
    #${ROOT_ID} .stat-card.accent { border-left: 4px solid #0099cc; }
    #${ROOT_ID} .stat-card.warn   { border-left: 4px solid #f59e0b; }
    #${ROOT_ID} .stat-card.good   { border-left: 4px solid #16a07a; }
    #${ROOT_ID} .stat-card.bad    { border-left: 4px solid #dc2626; }
    #${ROOT_ID} .stat-label {
      font-size: 11px; font-weight: 700; letter-spacing: 0.06em;
      text-transform: uppercase; color: #6b7280;
    }
    #${ROOT_ID} .stat-value {
      font-size: 28px; font-weight: 700; color: #1f2937;
      line-height: 1.1; margin-top: 6px;
    }
    #${ROOT_ID} .stat-sub {
      font-size: 12px; color: #6b7280; margin-top: 4px;
    }

    /* ── Two-column charts row ─────────────────────────────────── */
    #${ROOT_ID} .ci-charts {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
      margin-bottom: 18px;
    }
    @media (max-width: 900px) {
      #${ROOT_ID} .ci-charts { grid-template-columns: 1fr; }
    }
    #${ROOT_ID} .chart-card {
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 14px 16px;
    }
    #${ROOT_ID} .chart-head {
      font-size: 11px; font-weight: 700; letter-spacing: 0.06em;
      text-transform: uppercase; color: #6b7280;
      margin-bottom: 12px;
    }
    #${ROOT_ID} .chart-empty {
      color: #9ca3af; font-style: italic; padding: 8px 0;
    }
    /* Horizontal bar rows. Each row: label (20%) | bar (rest) | count. */
    #${ROOT_ID} .bar-row {
      display: grid;
      grid-template-columns: 130px 1fr auto;
      gap: 10px;
      align-items: center;
      margin-bottom: 6px;
      font-size: 12.5px;
      color: #1f2937;
    }
    #${ROOT_ID} .bar-row .lbl {
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      font-size: 11.5px; color: #374151;
    }
    #${ROOT_ID} .bar-row .bar {
      height: 16px; background: #e5e7eb; border-radius: 3px;
      position: relative; overflow: hidden;
    }
    #${ROOT_ID} .bar-row .bar .fill {
      height: 100%; border-radius: 3px;
      background: linear-gradient(90deg, #0099cc 0%, #33b0dd 100%);
    }
    /* Per-kind colours match the review cards' border-left. */
    #${ROOT_ID} .bar-row .bar.kind-detection-rule       .fill { background: linear-gradient(90deg, #f59e0b 0%, #fbbf24 100%); }
    #${ROOT_ID} .bar-row .bar.kind-knowledge-preamble   .fill { background: linear-gradient(90deg, #7c3aed 0%, #a78bfa 100%); }
    #${ROOT_ID} .bar-row .bar.kind-agent-instructions   .fill { background: linear-gradient(90deg, #0099cc 0%, #33b0dd 100%); }
    /* Status colours for the by-status row. */
    #${ROOT_ID} .bar-row .bar.status-pending  .fill { background: linear-gradient(90deg, #f59e0b 0%, #fbbf24 100%); }
    #${ROOT_ID} .bar-row .bar.status-approved .fill,
    #${ROOT_ID} .bar-row .bar.status-applied  .fill { background: linear-gradient(90deg, #16a07a 0%, #22c55e 100%); }
    #${ROOT_ID} .bar-row .bar.status-rejected .fill,
    #${ROOT_ID} .bar-row .bar.status-failed   .fill { background: linear-gradient(90deg, #dc2626 0%, #f87171 100%); }
    #${ROOT_ID} .bar-row .num {
      font-variant-numeric: tabular-nums; font-weight: 700; color: #1f2937;
      font-size: 12px; min-width: 32px; text-align: right;
    }

    /* ── Activity sparkline ─────────────────────────────────────── */
    #${ROOT_ID} .spark-card {
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 14px 16px;
      margin-bottom: 18px;
    }
    #${ROOT_ID} .spark-grid {
      display: grid;
      grid-template-columns: repeat(14, 1fr);
      gap: 6px;
      align-items: end;
      height: 60px;
      margin: 12px 0 4px;
    }
    #${ROOT_ID} .spark-cell {
      background: #e5e7eb;
      border-radius: 2px;
      min-height: 2px;
      position: relative;
    }
    #${ROOT_ID} .spark-cell.has-data {
      background: linear-gradient(180deg, #0099cc 0%, #33b0dd 100%);
    }
    #${ROOT_ID} .spark-cell.today { outline: 1.5px solid #0e6996; }
    #${ROOT_ID} .spark-axis {
      display: grid;
      grid-template-columns: repeat(14, 1fr);
      gap: 6px;
      font-size: 10px; color: #9ca3af;
      text-align: center;
    }

    /* ── Section headings ──────────────────────────────────────── */
    #${ROOT_ID} h2.ci-section-h {
      font-size: 13px; font-weight: 700; letter-spacing: 0.04em;
      text-transform: uppercase; color: #6b7280;
      margin: 28px 0 12px; padding: 0;
    }

    /* ── Pending review cards (kept from the previous version) ── */
    #${ROOT_ID} .ci-empty {
      padding: 36px 20px;
      text-align: center;
      color: #6b7280;
      font-style: italic;
      border: 1px dashed #cbd5e1;
      border-radius: 8px;
      background: #f9fafb;
    }
    #${ROOT_ID} .ci-err {
      padding: 14px 16px;
      background: rgba(239,68,68,0.08);
      border: 1px solid rgba(239,68,68,0.4);
      border-radius: 6px;
      color: #991b1b;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
      margin-bottom: 16px;
    }
    #${ROOT_ID} .ci-card {
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-left: 4px solid #facc15;
      border-radius: 8px;
      padding: 16px 18px;
      margin-bottom: 14px;
    }
    #${ROOT_ID} .ci-card.kind-detection-rule       { border-left-color: #f59e0b; }
    #${ROOT_ID} .ci-card.kind-knowledge-preamble   { border-left-color: #7c3aed; }
    #${ROOT_ID} .ci-card.kind-agent-instructions   { border-left-color: #0099cc; }
    #${ROOT_ID} .ci-head {
      display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
      margin-bottom: 10px;
    }
    #${ROOT_ID} .ci-kind {
      flex-shrink: 0;
      font-size: 10.5px; font-weight: 700; letter-spacing: 0.05em;
      text-transform: uppercase;
      padding: 2px 8px; border-radius: 999px;
      background: rgba(0,153,204,0.14); color: #1e3a8a;
    }
    #${ROOT_ID} .ci-card.kind-detection-rule     .ci-kind { background: rgba(245,158,11,0.20); color: #92400e; }
    #${ROOT_ID} .ci-card.kind-knowledge-preamble .ci-kind { background: rgba(124,58,237,0.16); color: #4c1d95; }
    #${ROOT_ID} .ci-card.kind-agent-instructions .ci-kind { background: rgba(0,153,204,0.16); color: #1e3a8a; }
    #${ROOT_ID} .ci-title {
      flex: 1; min-width: 0;
      font-size: 15px; font-weight: 700; color: #1f2937;
    }
    #${ROOT_ID} .ci-by {
      font-size: 12px; color: #6b7280;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    #${ROOT_ID} .ci-target {
      font-size: 12px;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      color: #1e3a8a;
    }
    #${ROOT_ID} .ci-rationale {
      margin: 8px 0 12px;
      font-size: 13px; color: #1f2937; line-height: 1.5;
    }
    #${ROOT_ID} .ci-section { margin-top: 12px; }
    #${ROOT_ID} .ci-label {
      font-size: 10px; font-weight: 700; letter-spacing: 0.06em;
      text-transform: uppercase; color: #6b7280; margin-bottom: 4px;
    }
    #${ROOT_ID} .ci-content {
      padding: 10px 12px;
      background: #f9fafb;
      border: 1px solid #e5e7eb;
      border-radius: 4px;
      font-size: 12.5px; line-height: 1.5;
      white-space: pre-wrap; word-break: break-word;
      color: #1f2937;
      max-height: 320px; overflow-y: auto;
    }
    #${ROOT_ID} .ci-content.proposed {
      background: rgba(34,197,94,0.06);
      border-color: rgba(34,197,94,0.30);
    }
    #${ROOT_ID} .ci-content.mono {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 12px;
    }
    #${ROOT_ID} .ci-actions {
      margin-top: 14px;
      display: flex; gap: 10px; flex-wrap: wrap; align-items: stretch;
    }
    #${ROOT_ID} .ci-actions textarea {
      flex: 1 1 100%; resize: vertical;
      min-height: 56px; max-height: 200px;
      padding: 8px 10px;
      border: 1px solid #cbd5e1; border-radius: 4px;
      font: 13px -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      box-sizing: border-box; color: #1f2937;
    }
    #${ROOT_ID} .ci-actions textarea:focus {
      outline: none; border-color: #0099cc;
      box-shadow: 0 0 0 3px rgba(0,153,204,0.18);
    }
    #${ROOT_ID} .ci-actions button {
      padding: 7px 16px; border-radius: 4px;
      font: 600 13px -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      cursor: pointer;
      border: 1px solid #cbd5e1;
      background: #f9fafb; color: #1f2937;
    }
    #${ROOT_ID} .ci-actions button:disabled { opacity: 0.5; cursor: not-allowed; }
    #${ROOT_ID} .ci-actions button.approve {
      background: #facc15; border-color: #ca8a04; color: #1f2937;
    }
    #${ROOT_ID} .ci-actions button.approve:hover:not(:disabled) { background: #eab308; }
    #${ROOT_ID} .ci-actions button.reject  { color: #991b1b; }
    #${ROOT_ID} .ci-actions button.reject:hover:not(:disabled) {
      background: rgba(239,68,68,0.10);
    }

    /* ── Recently decided table ────────────────────────────────── */
    #${ROOT_ID} table.ci-recent {
      width: 100%; border-collapse: collapse;
      font-size: 12.5px;
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      overflow: hidden;
    }
    #${ROOT_ID} table.ci-recent th,
    #${ROOT_ID} table.ci-recent td {
      padding: 8px 12px;
      text-align: left;
      border-bottom: 1px solid #f3f4f6;
    }
    #${ROOT_ID} table.ci-recent th {
      font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em;
      text-transform: uppercase; color: #6b7280;
      background: #f9fafb;
    }
    #${ROOT_ID} table.ci-recent td.kind {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 11.5px;
    }
    #${ROOT_ID} table.ci-recent td.title {
      max-width: 300px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    #${ROOT_ID} table.ci-recent .pill {
      display: inline-block;
      font-size: 10px; font-weight: 700; letter-spacing: 0.04em;
      text-transform: uppercase;
      padding: 2px 7px; border-radius: 999px;
    }
    #${ROOT_ID} table.ci-recent .pill.approved,
    #${ROOT_ID} table.ci-recent .pill.applied  { background: rgba(22,160,122,0.14); color: #065f46; }
    #${ROOT_ID} table.ci-recent .pill.rejected,
    #${ROOT_ID} table.ci-recent .pill.failed   { background: rgba(220,38,38,0.14); color: #991b1b; }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const root = document.getElementById(ROOT_ID);
  if (!root) return;

  // ── Helpers ────────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
  }
  function kindLabel(k) {
    return ({
      'detection-rule':     'Detection rule',
      'knowledge-preamble': 'Preamble',
      'agent-instructions': 'Agent prompt',
    })[k] || k || 'Change';
  }
  function asText(v) {
    if (typeof v === 'string') return v;
    if (v == null) return '';
    try { return JSON.stringify(v, null, 2); } catch (_) { return String(v); }
  }
  function fmtAgo(ts) {
    if (!ts) return 'never';
    const diff = Math.max(0, Math.floor(Date.now() / 1000 - ts));
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }
  function fmtPct(x) {
    if (x == null || isNaN(x)) return '—';
    return `${Math.round(x * 100)}%`;
  }

  // ── Stats cards (top row) ──────────────────────────────────────────
  function renderStatsCards(s) {
    const total = s.total || 0;
    const byStatus = s.by_status || {};
    const pending = byStatus.pending || 0;
    const accepted = (byStatus.approved || 0) + (byStatus.applied || 0);
    const rate = s.acceptance_rate;
    const rateCls = rate == null ? 'accent' : (rate >= 0.6 ? 'good' : (rate >= 0.3 ? 'warn' : 'bad'));

    // Top contributing agent.
    const agents = Object.entries(s.by_agent || {})
      .filter(([k]) => k && k !== 'unknown')
      .sort((a, b) => b[1] - a[1]);
    const topAgent = agents[0] ? `${agents[0][0]} (${agents[0][1]})` : '—';

    let html = '<div class="ci-stats">';
    html += `<div class="stat-card accent">`
          + `<div class="stat-label">Total proposals</div>`
          + `<div class="stat-value">${total}</div>`
          + `<div class="stat-sub">across all agents, all time</div>`
          + `</div>`;
    html += `<div class="stat-card warn">`
          + `<div class="stat-label">Pending review</div>`
          + `<div class="stat-value">${pending}</div>`
          + `<div class="stat-sub">awaiting human decision</div>`
          + `</div>`;
    html += `<div class="stat-card ${rateCls}">`
          + `<div class="stat-label">Acceptance rate</div>`
          + `<div class="stat-value">${escapeHtml(fmtPct(rate))}</div>`
          + `<div class="stat-sub">${escapeHtml(String(accepted))} of `
          + `${escapeHtml(String(s.decided_count || 0))} decided</div>`
          + `</div>`;
    html += `<div class="stat-card good">`
          + `<div class="stat-label">Top contributor</div>`
          + `<div class="stat-value" style="font-size:18px;line-height:1.3;word-break:break-word;">`
          + `${escapeHtml(topAgent)}</div>`
          + `<div class="stat-sub">most-proposing agent</div>`
          + `</div>`;
    html += '</div>';
    return html;
  }

  // ── Horizontal-bar chart ───────────────────────────────────────────
  function renderBarChart(title, items, opts) {
    opts = opts || {};
    const total = items.reduce((s, x) => s + (x.value || 0), 0);
    const max = Math.max(1, ...items.map((x) => x.value || 0));
    let html = `<div class="chart-card">`;
    html += `<div class="chart-head">${escapeHtml(title)}</div>`;
    if (!items.length || total === 0) {
      html += `<div class="chart-empty">No data yet.</div>`;
    } else {
      for (const it of items) {
        const pct = Math.max(2, Math.round((it.value / max) * 100));
        const barCls = it.barClass ? ` ${it.barClass}` : '';
        html += `<div class="bar-row">`
              + `<div class="lbl" title="${escapeHtml(it.label)}">${escapeHtml(it.label)}</div>`
              + `<div class="bar${barCls}"><div class="fill" style="width:${pct}%"></div></div>`
              + `<div class="num">${escapeHtml(String(it.value))}</div>`
              + `</div>`;
      }
    }
    html += '</div>';
    return html;
  }

  // ── 14-day activity sparkline ──────────────────────────────────────
  function renderSparkline(rows) {
    // Count proposals per day over the last 14 days (server time = client
    // time mismatch is fine for a demo; bucketise to local-day boundaries).
    const days = 14;
    const buckets = new Array(days).fill(0);
    const now = new Date();
    const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
    for (const r of rows) {
      const ts = r.proposed_at;
      if (!ts) continue;
      const diffDays = Math.floor((todayMid - ts) / 86400);
      if (diffDays < 0 || diffDays >= days) continue;
      const idx = (days - 1) - diffDays;  // newest → rightmost
      buckets[idx] += 1;
    }
    const max = Math.max(1, ...buckets);

    let html = `<div class="spark-card">`;
    html += `<div class="chart-head">Activity — last ${days} days</div>`;
    html += `<div class="spark-grid">`;
    for (let i = 0; i < days; i++) {
      const h = Math.round((buckets[i] / max) * 56);
      const has = buckets[i] > 0;
      const todayCls = i === days - 1 ? ' today' : '';
      const title = `${buckets[i]} proposal(s) — ${days - 1 - i} day(s) ago`;
      html += `<div class="spark-cell${has ? ' has-data' : ''}${todayCls}" `
            + `style="height:${Math.max(2, h)}px" `
            + `title="${escapeHtml(title)}"></div>`;
    }
    html += `</div>`;
    html += `<div class="spark-axis">`;
    for (let i = 0; i < days; i++) {
      const lbl = i === days - 1 ? 'today'
        : (i === 0 ? `-${days - 1}d` : (i % 2 === 0 ? `-${days - 1 - i}d` : ''));
      html += `<div>${escapeHtml(lbl)}</div>`;
    }
    html += `</div>`;
    html += `</div>`;
    return html;
  }

  // ── Recently-decided table ─────────────────────────────────────────
  function renderRecentTable(rows) {
    const decided = rows
      .filter((r) => r.status && r.status !== 'pending')
      .sort((a, b) => (b.reviewed_at || b.applied_at || 0) - (a.reviewed_at || a.applied_at || 0))
      .slice(0, 10);
    if (!decided.length) return '';
    let html = '<table class="ci-recent">';
    html += '<thead><tr>'
          + '<th>When</th><th>Kind</th><th>Title</th><th>By</th>'
          + '<th>Reviewer</th><th>Status</th>'
          + '</tr></thead><tbody>';
    for (const r of decided) {
      const when = r.reviewed_at || r.applied_at || r.proposed_at;
      const status = r.status || 'unknown';
      html += `<tr>`
            + `<td>${escapeHtml(fmtAgo(when))}</td>`
            + `<td class="kind">${escapeHtml(kindLabel(r.kind))}</td>`
            + `<td class="title" title="${escapeHtml(r.title || '')}">${escapeHtml(r.title || '(no title)')}</td>`
            + `<td>${escapeHtml(r.proposed_by || '—')}</td>`
            + `<td>${escapeHtml(r.reviewer || '—')}</td>`
            + `<td><span class="pill ${escapeHtml(status)}">${escapeHtml(status)}</span></td>`
            + `</tr>`;
    }
    html += '</tbody></table>';
    return html;
  }

  // ── Pending-review cards (kept from previous version) ──────────────
  function renderCard(c) {
    const id = c.id;
    const kindCls = `kind-${escapeHtml(c.kind || 'unknown')}`;
    const sending = STATE.sending.has(id);
    const note = STATE.notes[id] || '';
    const proposedText = asText(c.proposed);
    const currentText = asText(c.current);
    const monoCls = c.kind === 'detection-rule' ? ' mono' : '';

    let html = `<div class="ci-card ${kindCls}">`;
    html += `<div class="ci-head">`;
    html += `<span class="ci-kind">${escapeHtml(kindLabel(c.kind))}</span>`;
    if (c.target && c.kind !== 'knowledge-preamble') {
      html += `<span class="ci-target">${escapeHtml(c.target)}</span>`;
    }
    html += `<span class="ci-title">${escapeHtml(c.title || '(untitled change)')}</span>`;
    html += `<span class="ci-by">${escapeHtml(c.proposed_by || 'unknown')}</span>`;
    html += `</div>`;
    if (c.rationale) {
      html += `<p class="ci-rationale">${escapeHtml(c.rationale)}</p>`;
    }
    html += `<div class="ci-section">`;
    html += `<div class="ci-label">Proposed</div>`;
    html += `<div class="ci-content proposed${monoCls}">${escapeHtml(proposedText)}</div>`;
    html += `</div>`;
    if (currentText) {
      html += `<div class="ci-section">`;
      html += `<div class="ci-label">Current (for comparison)</div>`;
      html += `<div class="ci-content${monoCls}">${escapeHtml(currentText)}</div>`;
      html += `</div>`;
    } else if (c.kind === 'detection-rule') {
      html += `<div class="ci-section" style="color:#6b7280;font-size:12px;">`
            + `(net-new rule — no current state to compare against)`
            + `</div>`;
    }
    html += `<div class="ci-actions">`;
    html += `<textarea data-note="${escapeHtml(id)}" `
          + `placeholder="Optional note (sent with Approve / Reject)…" `
          + `${sending ? 'disabled' : ''}>${escapeHtml(note)}</textarea>`;
    html += `<button class="approve" data-approve="${escapeHtml(id)}" ${sending ? 'disabled' : ''}>${sending ? 'Sending…' : 'Approve'}</button>`;
    html += `<button class="reject"  data-reject="${escapeHtml(id)}"  ${sending ? 'disabled' : ''}>Reject</button>`;
    html += `</div>`;
    html += `</div>`;
    return html;
  }

  // ── Master render ──────────────────────────────────────────────────
  function render() {
    let body = '';

    if (STATE.error) {
      body += `<div class="ci-err">${escapeHtml(STATE.error)}</div>`;
    }

    // Stats first — they render even before the pending list lands.
    if (STATE.stats) {
      body += renderStatsCards(STATE.stats);

      // By-agent and by-kind side by side.
      const agentItems = Object.entries(STATE.stats.by_agent || {})
        .map(([k, v]) => ({ label: k || 'unknown', value: v }))
        .sort((a, b) => b.value - a.value);
      const kindItems = Object.entries(STATE.stats.by_kind || {})
        .map(([k, v]) => ({ label: kindLabel(k) || k, value: v, barClass: `kind-${k}` }))
        .sort((a, b) => b.value - a.value);
      body += '<div class="ci-charts">';
      body += renderBarChart('Proposals by agent', agentItems);
      body += renderBarChart('Proposals by kind',  kindItems);
      body += '</div>';

      // Status breakdown (pending vs approved/applied vs rejected/failed)
      // — single full-width card for clarity.
      const statusItems = Object.entries(STATE.stats.by_status || {})
        .map(([k, v]) => ({ label: k, value: v, barClass: `status-${k}` }))
        .sort((a, b) => b.value - a.value);
      body += '<div class="ci-charts" style="grid-template-columns: 1fr 1fr;">';
      body += renderBarChart('Decisions by status', statusItems);
      // 14-day spark goes next to it.
      body += `<div class="chart-card">`;
      body += `<div class="chart-head">Activity — last 14 days</div>`;
      // Inline a smaller version of the spark, keeping it inside .chart-card
      // so the grid keeps its two-up balance.
      body += renderSparkInline(STATE.stats.rows || []);
      body += `</div>`;
      body += '</div>';
    }

    // Pending review cards — the actionable list.
    body += `<h2 class="ci-section-h">Pending review</h2>`;
    if (!STATE.pending.length) {
      body += `<div class="ci-empty">Nothing pending right now. Proposed changes from the Detection Engineer and SOC Manager agents will appear here.</div>`;
    } else {
      for (const c of STATE.pending) body += renderCard(c);
    }

    // Recent decisions tail.
    if (STATE.stats && STATE.stats.rows && STATE.stats.rows.length) {
      const recent = renderRecentTable(STATE.stats.rows);
      if (recent) {
        body += `<h2 class="ci-section-h">Recently decided</h2>`;
        body += recent;
      }
    }

    root.innerHTML = body;

    // Wire pending-card handlers.
    root.querySelectorAll('[data-note]').forEach((ta) => {
      ta.addEventListener('input', () => {
        STATE.notes[ta.getAttribute('data-note')] = ta.value;
      });
    });
    root.querySelectorAll('[data-approve]').forEach((btn) => {
      btn.addEventListener('click', () => onDecision(btn.getAttribute('data-approve'), 'approve'));
    });
    root.querySelectorAll('[data-reject]').forEach((btn) => {
      btn.addEventListener('click', () => onDecision(btn.getAttribute('data-reject'), 'reject'));
    });
  }

  // Compact spark inline (to fit inside chart-card alongside the
  // status bars). Same shape as the full sparkline above but
  // returns the inner HTML only.
  function renderSparkInline(rows) {
    const days = 14;
    const buckets = new Array(days).fill(0);
    const now = new Date();
    const todayMid = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000;
    for (const r of rows) {
      const ts = r.proposed_at;
      if (!ts) continue;
      const diffDays = Math.floor((todayMid - ts) / 86400);
      if (diffDays < 0 || diffDays >= days) continue;
      const idx = (days - 1) - diffDays;
      buckets[idx] += 1;
    }
    const max = Math.max(1, ...buckets);
    let html = `<div class="spark-grid">`;
    for (let i = 0; i < days; i++) {
      const h = Math.round((buckets[i] / max) * 56);
      const has = buckets[i] > 0;
      const todayCls = i === days - 1 ? ' today' : '';
      const title = `${buckets[i]} proposal(s) — ${days - 1 - i} day(s) ago`;
      html += `<div class="spark-cell${has ? ' has-data' : ''}${todayCls}" `
            + `style="height:${Math.max(2, h)}px" `
            + `title="${escapeHtml(title)}"></div>`;
    }
    html += `</div>`;
    html += `<div class="spark-axis">`;
    for (let i = 0; i < days; i++) {
      const lbl = i === days - 1 ? 'today'
        : (i === 0 ? `-${days - 1}d` : (i % 3 === 0 ? `-${days - 1 - i}d` : ''));
      html += `<div>${escapeHtml(lbl)}</div>`;
    }
    html += `</div>`;
    return html;
  }

  // ── Networking ─────────────────────────────────────────────────────
  async function onDecision(id, decision) {
    if (STATE.sending.has(id)) return;
    STATE.sending.add(id);
    render();
    try {
      const note = STATE.notes[id] || '';
      const r = await fetch(
        `/api/changes/${encodeURIComponent(id)}/${decision}`,
        {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note }),
        },
      );
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        STATE.error = `Failed to ${decision} change ${id}: ${text || r.status}`;
        return;
      }
      // Optimistic remove from pending; the next poll reconciles.
      STATE.pending = STATE.pending.filter((c) => c.id !== id);
      delete STATE.notes[id];
      STATE.error = '';
    } catch (e) {
      STATE.error = `Network error: ${e.message || e}`;
    } finally {
      STATE.sending.delete(id);
      render();
    }
  }

  async function poll() {
    try {
      const [statsR, pendingR] = await Promise.all([
        fetch('/api/changes/stats',   { credentials: 'same-origin' }),
        fetch('/api/changes/pending', { credentials: 'same-origin' }),
      ]);
      if (!statsR.ok) {
        const text = await statsR.text().catch(() => '');
        STATE.error = `Failed to load stats: HTTP ${statsR.status} ${text.slice(0, 200)}`;
      } else {
        STATE.stats = await statsR.json();
      }
      if (!pendingR.ok) {
        const text = await pendingR.text().catch(() => '');
        STATE.error = `Failed to load pending changes: HTTP ${pendingR.status} ${text.slice(0, 200)}`;
      } else {
        const data = await pendingR.json();
        STATE.pending = (data && data.changes) || [];
      }
      if (statsR.ok && pendingR.ok) STATE.error = '';
      render();
    } catch (e) {
      STATE.error = `Network error: ${e.message || e}`;
      render();
    }
  }

  poll();
  setInterval(poll, POLL_MS);
})();
