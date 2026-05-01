// rules.js
// ────────────────────────────────────────────────────────────────────
// Rule performance dashboard.
//
// Aggregates Sentinel incidents by analytic-rule name (using incident
// title as the grouping key) and renders trigger volume + a TP / FP
// breakdown derived from how analysts classified each closed incident.
//
// Data source: /api/rules/stats — gated server-side to soc-manager,
// detection-engineer, threat-intel-analyst.

(function () {
  'use strict';

  const ROOT_ID = 'aisoc-rules-root';
  const POLL_MS = 30_000;

  const STATE = {
    payload: null,
    error: '',
    sortBy: 'count',  // 'count' | 'tp_rate' | 'fp_rate' | 'last'
    sortDir: 'desc',
  };

  // ── Styles ─────────────────────────────────────────────────────────
  const css = `
    #${ROOT_ID} { font: 14px -apple-system, BlinkMacSystemFont, system-ui, sans-serif; }

    #${ROOT_ID} .rl-stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 18px;
    }
    @media (max-width: 900px) {
      #${ROOT_ID} .rl-stats { grid-template-columns: repeat(2, 1fr); }
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

    #${ROOT_ID} .rl-card {
      background: #ffffff;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 14px 16px;
      margin-bottom: 18px;
    }
    #${ROOT_ID} .rl-card-head {
      font-size: 11px; font-weight: 700; letter-spacing: 0.06em;
      text-transform: uppercase; color: #6b7280;
      margin-bottom: 10px;
    }

    #${ROOT_ID} table.rl-tbl {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    #${ROOT_ID} table.rl-tbl th,
    #${ROOT_ID} table.rl-tbl td {
      padding: 10px 12px;
      border-bottom: 1px solid #f3f4f6;
      text-align: left;
      vertical-align: middle;
    }
    #${ROOT_ID} table.rl-tbl th {
      font-size: 10.5px; font-weight: 700; letter-spacing: 0.06em;
      text-transform: uppercase; color: #6b7280;
      background: #f9fafb;
      cursor: pointer; user-select: none;
    }
    #${ROOT_ID} table.rl-tbl th[data-sort].active::after {
      content: '';
      display: inline-block;
      margin-left: 5px;
      border: 4px solid transparent;
      vertical-align: middle;
    }
    #${ROOT_ID} table.rl-tbl th[data-sort].active.desc::after {
      border-top-color: #6b7280; margin-bottom: -4px;
    }
    #${ROOT_ID} table.rl-tbl th[data-sort].active.asc::after  {
      border-bottom-color: #6b7280; margin-top: -4px;
    }
    #${ROOT_ID} table.rl-tbl td.rule {
      font-weight: 600; color: #1f2937;
      max-width: 380px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    #${ROOT_ID} table.rl-tbl td.num {
      font-variant-numeric: tabular-nums;
      text-align: right;
      font-weight: 600;
    }
    #${ROOT_ID} table.rl-tbl td.ratio {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }

    /* TP/FP stacked bar — visual breakdown per rule. */
    #${ROOT_ID} .rl-stack {
      display: flex; height: 14px; border-radius: 3px; overflow: hidden;
      background: #e5e7eb; min-width: 140px;
    }
    #${ROOT_ID} .rl-stack .seg-tp           { background: #16a07a; }
    #${ROOT_ID} .rl-stack .seg-fp           { background: #dc2626; }
    #${ROOT_ID} .rl-stack .seg-benign       { background: #0099cc; }
    #${ROOT_ID} .rl-stack .seg-undetermined { background: #d1d5db; }
    #${ROOT_ID} .rl-legend {
      display: flex; gap: 14px; flex-wrap: wrap;
      font-size: 11px; color: #6b7280;
      margin-top: 8px;
    }
    #${ROOT_ID} .rl-legend .dot {
      display: inline-block; width: 10px; height: 10px;
      border-radius: 2px; vertical-align: middle; margin-right: 4px;
    }

    #${ROOT_ID} .rl-empty {
      padding: 36px 20px; text-align: center;
      color: #6b7280; font-style: italic;
      border: 1px dashed #cbd5e1; border-radius: 8px;
      background: #f9fafb;
    }
    #${ROOT_ID} .rl-err {
      padding: 14px 16px;
      background: rgba(239,68,68,0.08);
      border: 1px solid rgba(239,68,68,0.4);
      border-radius: 6px;
      color: #991b1b;
      font-size: 12.5px;
      margin-bottom: 16px;
    }
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
  function fmtPct(x) {
    if (x == null || isNaN(x)) return '—';
    return `${Math.round(x * 100)}%`;
  }
  function fmtAgo(iso) {
    if (!iso) return '—';
    const t = Date.parse(iso);
    if (!t) return '—';
    const diff = Math.max(0, Math.floor((Date.now() - t) / 1000));
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }

  function sortRules(rules) {
    const cmp = {
      count:    (a, b) => (a.count || 0) - (b.count || 0),
      tp_rate:  (a, b) => (a.tp_rate || 0) - (b.tp_rate || 0),
      fp_rate:  (a, b) => (a.fp_rate || 0) - (b.fp_rate || 0),
      last:     (a, b) => (Date.parse(a.last_triggered || 0) || 0)
                         - (Date.parse(b.last_triggered || 0) || 0),
    }[STATE.sortBy] || (() => 0);
    const out = [...rules].sort(cmp);
    if (STATE.sortDir === 'desc') out.reverse();
    return out;
  }

  // ── Render ─────────────────────────────────────────────────────────
  function renderStatsCards(p) {
    const rules = p.rules || [];
    const totalIncidents = p.total_incidents || 0;
    const totalRules = p.total_rules || 0;
    let tp = 0, fp = 0, benign = 0, undet = 0;
    for (const r of rules) {
      tp += r.tp || 0; fp += r.fp || 0;
      benign += r.benign || 0; undet += r.undetermined || 0;
    }
    const decided = tp + fp + benign;
    const tpRate = decided > 0 ? tp / decided : null;
    const fpRate = decided > 0 ? fp / decided : null;

    let html = '<div class="rl-stats">';
    html += `<div class="stat-card accent">`
          + `<div class="stat-label">Active rules</div>`
          + `<div class="stat-value">${totalRules}</div>`
          + `<div class="stat-sub">distinct rules with at least one trigger</div>`
          + `</div>`;
    html += `<div class="stat-card accent">`
          + `<div class="stat-label">Total incidents</div>`
          + `<div class="stat-value">${totalIncidents}</div>`
          + `<div class="stat-sub">across all rules + statuses</div>`
          + `</div>`;
    html += `<div class="stat-card good">`
          + `<div class="stat-label">Overall TP rate</div>`
          + `<div class="stat-value">${escapeHtml(fmtPct(tpRate))}</div>`
          + `<div class="stat-sub">${tp} TP / ${decided} closed-and-classified</div>`
          + `</div>`;
    html += `<div class="stat-card bad">`
          + `<div class="stat-label">Overall FP rate</div>`
          + `<div class="stat-value">${escapeHtml(fmtPct(fpRate))}</div>`
          + `<div class="stat-sub">${fp} FP / ${decided} closed-and-classified</div>`
          + `</div>`;
    html += '</div>';
    return html;
  }

  function renderTable(rules) {
    if (!rules.length) {
      return '<div class="rl-empty">No incidents yet — run a Sentinel rule to populate this view.</div>';
    }
    let html = '<div class="rl-card">';
    html += '<div class="rl-card-head">By rule</div>';
    html += '<table class="rl-tbl">';
    html += '<thead><tr>';
    const cols = [
      ['rule',    'Rule',           false],
      ['count',   'Triggers',       true],
      ['stack',   'Outcomes',       false],
      ['tp_rate', 'TP rate',        true],
      ['fp_rate', 'FP rate',        true],
      ['last',    'Last triggered', true],
    ];
    for (const [key, label, sortable] of cols) {
      const isActive = sortable && STATE.sortBy === key;
      const dir = STATE.sortDir;
      const cls = sortable
        ? `data-sort="${key}" class="${isActive ? 'active ' + dir : ''}"`
        : '';
      html += `<th ${cls}>${escapeHtml(label)}</th>`;
    }
    html += '</tr></thead><tbody>';
    for (const r of rules) {
      const total = (r.tp || 0) + (r.fp || 0) + (r.benign || 0) + (r.undetermined || 0) + (r.open || 0);
      const segTp = total > 0 ? (r.tp || 0) / total * 100 : 0;
      const segFp = total > 0 ? (r.fp || 0) / total * 100 : 0;
      const segBn = total > 0 ? (r.benign || 0) / total * 100 : 0;
      const segUd = total > 0 ? (r.undetermined || 0) / total * 100 : 0;
      const segOpen = Math.max(0, 100 - segTp - segFp - segBn - segUd);
      html += `<tr>`
            + `<td class="rule" title="${escapeHtml(r.rule)}">${escapeHtml(r.rule)}</td>`
            + `<td class="num">${r.count || 0}</td>`
            + `<td><div class="rl-stack" title="`
            +   `TP ${r.tp||0} · FP ${r.fp||0} · Benign ${r.benign||0} · Undetermined ${r.undetermined||0} · Open ${r.open||0}`
            +   `">`
            +     (segTp > 0 ? `<div class="seg-tp"           style="flex:0 0 ${segTp.toFixed(2)}%"></div>` : '')
            +     (segFp > 0 ? `<div class="seg-fp"           style="flex:0 0 ${segFp.toFixed(2)}%"></div>` : '')
            +     (segBn > 0 ? `<div class="seg-benign"       style="flex:0 0 ${segBn.toFixed(2)}%"></div>` : '')
            +     (segUd > 0 ? `<div class="seg-undetermined" style="flex:0 0 ${segUd.toFixed(2)}%"></div>` : '')
            +     (segOpen > 0 ? `<div style="flex:0 0 ${segOpen.toFixed(2)}%; background: rgba(245,158,11,0.55);"></div>` : '')
            +   `</div></td>`
            + `<td class="ratio">${escapeHtml(fmtPct(r.tp_rate))}</td>`
            + `<td class="ratio">${escapeHtml(fmtPct(r.fp_rate))}</td>`
            + `<td>${escapeHtml(fmtAgo(r.last_triggered))}</td>`
            + `</tr>`;
    }
    html += '</tbody></table>';
    html += '<div class="rl-legend">';
    html += '<span><span class="dot" style="background:#16a07a"></span>True positive</span>';
    html += '<span><span class="dot" style="background:#dc2626"></span>False positive</span>';
    html += '<span><span class="dot" style="background:#0099cc"></span>Benign positive</span>';
    html += '<span><span class="dot" style="background:#d1d5db"></span>Undetermined</span>';
    html += '<span><span class="dot" style="background:rgba(245,158,11,0.55)"></span>Still open</span>';
    html += '</div>';
    html += '</div>';
    return html;
  }

  function render() {
    let body = '';
    if (STATE.error) {
      body += `<div class="rl-err">${escapeHtml(STATE.error)}</div>`;
    }
    if (STATE.payload) {
      body += renderStatsCards(STATE.payload);
      const sorted = sortRules(STATE.payload.rules || []);
      body += renderTable(sorted);
    } else if (!STATE.error) {
      body += '<div class="rl-empty">Loading rule performance…</div>';
    }
    root.innerHTML = body;

    // Wire sort headers.
    root.querySelectorAll('th[data-sort]').forEach((th) => {
      th.addEventListener('click', () => {
        const k = th.getAttribute('data-sort');
        if (STATE.sortBy === k) {
          STATE.sortDir = (STATE.sortDir === 'desc' ? 'asc' : 'desc');
        } else {
          STATE.sortBy = k;
          STATE.sortDir = (k === 'tp_rate' || k === 'last' ? 'desc' : 'desc');
        }
        render();
      });
    });
  }

  async function poll() {
    try {
      const r = await fetch('/api/rules/stats', { credentials: 'same-origin' });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        STATE.error = `Failed to load rule stats: HTTP ${r.status} ${text.slice(0, 200)}`;
        render();
        return;
      }
      STATE.payload = await r.json();
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
