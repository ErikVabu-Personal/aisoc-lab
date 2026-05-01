// Threat Horizon — standing TI dashboard.
//
// Fetches /api/threat_horizon every 30s and renders a four-section
// dashboard: posture banner, headline threats, new + notable, and
// watchlist + recommendations. The Threat Intel agent produces the
// payload on a server-side timer (default 5 minutes); this page is
// read-only for the dashboard data, with a soc-manager-only refresh
// interval input + manual "Refresh now" button at the bottom.
//
// Self-contained: scoped CSS injected into the head, all state local
// to the IIFE, no shared dependencies with the other config pages.

(() => {
  const ROOT_ID = 'aisoc-threat-horizon-root';
  const POLL_MS = 30_000;     // dashboard payload
  const STATE = {
    payload: null,            // server response: {report, last_attempt_ts, ...}
    error: '',                // top-level fetch error message
    intervalDraft: null,      // soc-manager: in-flight edit of refresh interval (seconds)
    savingInterval: false,
    intervalStatus: '',
    intervalStatusKind: '',   // 'ok' | 'error' | 'saving'
    refreshing: false,        // manual refresh in flight
    refreshStatus: '',
    refreshStatusKind: '',
  };

  // ── Helpers ────────────────────────────────────────────────────────
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }
  function fmtAgo(ts) {
    if (!ts) return 'never';
    const diff = Math.max(0, Math.floor(Date.now() / 1000 - ts));
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return `${Math.floor(diff / 86400)}d ago`;
  }
  function fmtIn(ts) {
    if (!ts) return '—';
    const diff = Math.floor(ts - Date.now() / 1000);
    if (diff <= 0) return 'now';
    if (diff < 60) return `in ${diff}s`;
    if (diff < 3600) return `in ${Math.floor(diff / 60)}m ${diff % 60}s`;
    return `in ${Math.floor(diff / 3600)}h${Math.floor((diff % 3600) / 60)}m`;
  }
  function fmtIntervalLabel(secs) {
    if (!secs || secs <= 0) return 'Disabled (manual refresh only)';
    if (secs < 60) return `Every ${secs}s`;
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    return s ? `Every ${m}m ${s}s` : `Every ${m}m`;
  }

  // ── Styles (scoped to #aisoc-threat-horizon-root) ─────────────────
  function injectStyles() {
    if (document.getElementById('aisoc-threat-horizon-styles')) return;
    const css = `
      #${ROOT_ID} {
        --th-fg: #1f2937;
        --th-muted: #6b7280;
        --th-border: #e5e7eb;
        --th-card-bg: #ffffff;
        --th-accent: #0099cc;
        --th-accent-bg: rgba(0,153,204,0.08);
      }
      #${ROOT_ID} .th-banner {
        position: relative;
        padding: 18px 22px;
        border-radius: 8px;
        margin-bottom: 20px;
        color: #fff;
        background: linear-gradient(135deg, #0e6996 0%, #0099cc 100%);
        box-shadow: 0 2px 8px rgba(0,0,0,0.06);
      }
      #${ROOT_ID} .th-banner.posture-elevated  { background: linear-gradient(135deg, #b65316 0%, #d97706 100%); }
      #${ROOT_ID} .th-banner.posture-critical  { background: linear-gradient(135deg, #921f1f 0%, #dc2626 100%); }
      #${ROOT_ID} .th-banner.posture-calm      { background: linear-gradient(135deg, #1e6650 0%, #16a07a 100%); }
      #${ROOT_ID} .th-banner .th-banner-row {
        display: flex; align-items: baseline; gap: 12px; flex-wrap: wrap;
      }
      #${ROOT_ID} .th-banner .th-posture {
        font-size: 11px; font-weight: 700; letter-spacing: 0.10em;
        text-transform: uppercase;
        background: rgba(255,255,255,0.20);
        padding: 3px 9px;
        border-radius: 999px;
      }
      #${ROOT_ID} .th-banner .th-meta {
        margin-left: auto;
        font-size: 12px;
        opacity: 0.9;
      }
      #${ROOT_ID} .th-banner h2 {
        font-size: 18px; font-weight: 700; margin: 8px 0 0; color: #fff;
        text-transform: none; letter-spacing: 0;
      }
      #${ROOT_ID} .th-banner.in-flight::after {
        content: '';
        position: absolute; left: 0; right: 0; bottom: 0; height: 3px;
        background: linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.6) 50%, transparent 100%);
        background-size: 200% 100%;
        animation: th-shimmer 1.4s linear infinite;
        border-radius: 0 0 8px 8px;
      }
      @keyframes th-shimmer {
        0%   { background-position: 100% 0; }
        100% { background-position: -100% 0; }
      }

      /* Two-column grid below the banner. Top row: headline threats.
         Then new+notable. Bottom row: watchlist + recommendations
         side by side. Collapses to single-column on narrow screens. */
      #${ROOT_ID} .th-grid {
        display: grid;
        grid-template-columns: 1.4fr 1fr;
        gap: 16px;
        margin-bottom: 16px;
      }
      #${ROOT_ID} .th-grid.full { grid-template-columns: 1fr; }
      @media (max-width: 900px) {
        #${ROOT_ID} .th-grid { grid-template-columns: 1fr; }
      }

      #${ROOT_ID} .th-card {
        background: var(--th-card-bg);
        border: 1px solid var(--th-border);
        border-radius: 8px;
        padding: 16px 18px;
      }
      #${ROOT_ID} .th-card-head {
        font-size: 11px; font-weight: 700; letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--th-muted);
        margin-bottom: 10px;
      }
      #${ROOT_ID} .th-empty {
        color: var(--th-muted);
        font-style: italic;
        padding: 8px 0;
      }

      /* Headline threats — list of severity-tagged cards. */
      #${ROOT_ID} .th-threat {
        border-left: 3px solid #cbd5e1;
        padding: 8px 0 8px 12px;
        margin-bottom: 12px;
      }
      #${ROOT_ID} .th-threat:last-child { margin-bottom: 0; }
      #${ROOT_ID} .th-threat.sev-critical { border-left-color: #dc2626; }
      #${ROOT_ID} .th-threat.sev-high     { border-left-color: #ea580c; }
      #${ROOT_ID} .th-threat.sev-medium   { border-left-color: #d97706; }
      #${ROOT_ID} .th-threat.sev-low      { border-left-color: #16a07a; }
      #${ROOT_ID} .th-threat .th-threat-head {
        display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap;
      }
      #${ROOT_ID} .th-threat .th-threat-title {
        font-size: 14px; font-weight: 700; color: var(--th-fg);
      }
      #${ROOT_ID} .th-threat .th-sev-pill {
        font-size: 10px; font-weight: 700; letter-spacing: 0.06em;
        text-transform: uppercase;
        padding: 2px 7px; border-radius: 999px;
        background: rgba(107,114,128,0.12);
        color: #374151;
      }
      #${ROOT_ID} .th-threat .th-sev-pill.sev-critical { background: rgba(220,38,38,0.14); color: #991b1b; }
      #${ROOT_ID} .th-threat .th-sev-pill.sev-high     { background: rgba(234,88,12,0.14); color: #9a3412; }
      #${ROOT_ID} .th-threat .th-sev-pill.sev-medium   { background: rgba(217,119,6,0.14); color: #92400e; }
      #${ROOT_ID} .th-threat .th-sev-pill.sev-low      { background: rgba(22,160,122,0.14); color: #065f46; }
      #${ROOT_ID} .th-threat .th-summary {
        font-size: 13px; line-height: 1.45; color: #374151;
        margin: 4px 0 0;
      }
      #${ROOT_ID} .th-sources {
        margin-top: 6px;
        font-size: 11px;
        color: var(--th-muted);
      }
      #${ROOT_ID} .th-sources a {
        color: var(--th-accent);
        text-decoration: none;
        margin-right: 8px;
      }
      #${ROOT_ID} .th-sources a:hover { text-decoration: underline; }

      /* New + notable — a compact list with kind pill on the left. */
      #${ROOT_ID} .th-notable {
        display: flex; gap: 10px; padding: 8px 0;
        border-bottom: 1px dashed var(--th-border);
      }
      #${ROOT_ID} .th-notable:last-child { border-bottom: none; }
      #${ROOT_ID} .th-kind-pill {
        flex: 0 0 auto;
        align-self: flex-start;
        font-size: 10px; font-weight: 700; letter-spacing: 0.06em;
        text-transform: uppercase;
        padding: 2px 7px; border-radius: 3px;
        background: var(--th-accent-bg);
        color: var(--th-accent);
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
      }
      #${ROOT_ID} .th-notable-body {
        flex: 1; min-width: 0;
        font-size: 13px; line-height: 1.4; color: #374151;
      }
      #${ROOT_ID} .th-notable-body strong {
        color: var(--th-fg); font-weight: 700;
      }

      /* Watchlist — table-like, IOC + rationale. */
      #${ROOT_ID} .th-watch {
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: 4px 12px;
        align-items: baseline;
      }
      #${ROOT_ID} .th-watch-ind {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px;
        color: var(--th-fg);
        background: #f3f4f6;
        padding: 2px 7px;
        border-radius: 3px;
        white-space: nowrap;
      }
      #${ROOT_ID} .th-watch-rat {
        font-size: 12px; color: #4b5563; line-height: 1.4;
      }
      #${ROOT_ID} .th-watch-kind {
        font-size: 10px;
        color: var(--th-muted);
        text-transform: uppercase;
        letter-spacing: 0.04em;
        margin-right: 4px;
      }

      /* Recommendations — bulletted list. */
      #${ROOT_ID} ul.th-recs {
        margin: 0; padding-left: 18px;
      }
      #${ROOT_ID} ul.th-recs li {
        font-size: 13px; line-height: 1.5; color: #374151;
        margin-bottom: 6px;
      }
      #${ROOT_ID} ul.th-recs li:last-child { margin-bottom: 0; }

      /* Footer: refresh-interval config + manual refresh. */
      #${ROOT_ID} .th-footer {
        margin-top: 24px;
        padding: 16px 18px;
        background: #f9fafb;
        border: 1px solid var(--th-border);
        border-radius: 8px;
      }
      #${ROOT_ID} .th-footer-head {
        font-size: 11px; font-weight: 700; letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--th-muted);
        margin-bottom: 10px;
      }
      #${ROOT_ID} .th-footer-row {
        display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
      }
      #${ROOT_ID} .th-footer label {
        font-size: 12px; color: #374151;
      }
      #${ROOT_ID} .th-footer input[type="number"] {
        width: 90px;
        font-size: 13px;
        padding: 5px 8px;
        border: 1px solid #cbd5e1;
        border-radius: 4px;
      }
      #${ROOT_ID} .th-footer input[type="number"]:focus {
        outline: none; border-color: var(--th-accent);
      }
      #${ROOT_ID} .th-footer button {
        font-size: 12px;
        padding: 6px 14px;
        border-radius: 4px;
        border: 1px solid #cbd5e1;
        background: #fff;
        color: var(--th-fg);
        cursor: pointer;
      }
      #${ROOT_ID} .th-footer button.primary {
        background: var(--th-accent); color: #fff; border-color: #0088bb;
      }
      #${ROOT_ID} .th-footer button.primary:hover:not(:disabled) {
        background: #0088bb;
      }
      #${ROOT_ID} .th-footer button:disabled {
        opacity: 0.55; cursor: wait;
      }
      #${ROOT_ID} .th-footer .th-status {
        font-size: 11px; padding: 4px 8px; border-radius: 3px;
      }
      #${ROOT_ID} .th-footer .th-status.ok      { color: #065f46; background: rgba(16,185,129,0.10); }
      #${ROOT_ID} .th-footer .th-status.saving  { color: var(--th-muted); font-style: italic; }
      #${ROOT_ID} .th-footer .th-status.error   { color: #991b1b; background: rgba(239,68,68,0.10); }
      #${ROOT_ID} .th-footer .th-readonly {
        font-size: 11px; color: var(--th-muted);
        font-style: italic;
      }

      /* Last-error banner — renders above the dashboard if the most
         recent attempt failed but we still have an old report to show. */
      #${ROOT_ID} .th-warn {
        background: rgba(217,119,6,0.10);
        border: 1px solid rgba(217,119,6,0.40);
        border-radius: 6px;
        padding: 10px 14px;
        font-size: 13px; color: #92400e;
        margin-bottom: 16px;
      }
      #${ROOT_ID} .th-warn code {
        background: rgba(217,119,6,0.18);
        padding: 1px 4px; border-radius: 3px;
        font-size: 12px;
      }
    `;
    const style = document.createElement('style');
    style.id = 'aisoc-threat-horizon-styles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  // ── Render ─────────────────────────────────────────────────────────
  function render() {
    const root = document.getElementById(ROOT_ID);
    if (!root) return;

    if (STATE.error && !STATE.payload) {
      root.innerHTML = `
        <div class="th-card">
          <div class="th-card-head">Threat Horizon</div>
          <div class="th-empty">Failed to load: ${escapeHtml(STATE.error)}</div>
        </div>`;
      return;
    }

    const p = STATE.payload || {};
    const report = p.report || null;
    const cfg = (p.config || {});
    const intervalSec = Number(cfg.value_sec || 0);
    const inFlight = !!p.in_flight;
    const lastErr = p.last_error;
    const lastSuccess = p.last_success_ts;
    const lastAttempt = p.last_attempt_ts;
    const nextRefresh = p.next_refresh_at;

    let html = '';

    // Posture banner.
    const posture = (report && report.posture) || 'normal';
    const headline = (report && report.headline)
      || 'Awaiting first refresh — the Threat Intel agent has not yet produced a horizon report.';
    html += `<div class="th-banner posture-${escapeHtml(posture)}${inFlight ? ' in-flight' : ''}">`;
    html += '<div class="th-banner-row">';
    html += `<span class="th-posture">${escapeHtml(posture)}</span>`;
    html += `<span class="th-meta">`
          + `Last updated <strong>${escapeHtml(fmtAgo(lastSuccess))}</strong>`
          + (intervalSec > 0
              ? ` · next refresh <strong>${escapeHtml(fmtIn(nextRefresh))}</strong>`
              : ' · auto-refresh disabled')
          + (inFlight ? ' · <strong>refreshing…</strong>' : '')
          + `</span>`;
    html += '</div>';
    html += `<h2>${escapeHtml(headline)}</h2>`;
    html += '</div>';

    // Stale-data warning when the last attempt failed but we have
    // an older report still cached.
    if (lastErr && report) {
      html += `<div class="th-warn">`
            + `Most recent refresh failed: <code>${escapeHtml(lastErr)}</code>. `
            + `Showing the last successful report from ${escapeHtml(fmtAgo(lastSuccess))}.`
            + `</div>`;
    }

    // ── Headline threats (left col, big card) ────────────────────────
    html += '<div class="th-grid">';
    html += '<div class="th-card">';
    html += '<div class="th-card-head">Headline threats</div>';
    const threats = (report && report.headline_threats) || [];
    if (!threats.length) {
      html += '<div class="th-empty">No headline threats reported.</div>';
    } else {
      for (const t of threats) html += renderThreat(t);
    }
    html += '</div>';

    // ── New + notable (right col) ────────────────────────────────────
    html += '<div class="th-card">';
    html += '<div class="th-card-head">New &amp; notable</div>';
    const notable = (report && report.new_and_notable) || [];
    if (!notable.length) {
      html += '<div class="th-empty">Nothing new flagged this cycle.</div>';
    } else {
      for (const n of notable) html += renderNotable(n);
    }
    html += '</div>';
    html += '</div>';  // /.th-grid

    // ── Watchlist + recommendations row ──────────────────────────────
    html += '<div class="th-grid">';
    html += '<div class="th-card">';
    html += '<div class="th-card-head">Watchlist</div>';
    const watch = (report && report.watchlist) || [];
    if (!watch.length) {
      html += '<div class="th-empty">No active watchlist entries.</div>';
    } else {
      html += '<div class="th-watch">';
      for (const w of watch) html += renderWatch(w);
      html += '</div>';
    }
    html += '</div>';

    html += '<div class="th-card">';
    html += '<div class="th-card-head">Recommendations</div>';
    const recs = (report && report.recommendations) || [];
    if (!recs.length) {
      html += '<div class="th-empty">No standing recommendations.</div>';
    } else {
      html += '<ul class="th-recs">';
      for (const r of recs) html += `<li>${escapeHtml(r)}</li>`;
      html += '</ul>';
    }
    html += '</div>';
    html += '</div>';  // /.th-grid

    // ── Footer: refresh interval + manual refresh ────────────────────
    html += '<div class="th-footer">';
    html += '<div class="th-footer-head">Refresh cadence</div>';
    html += '<div class="th-footer-row">';
    html += `<label>Every</label>`;
    const draftMin = STATE.intervalDraft != null
      ? STATE.intervalDraft
      : (intervalSec > 0 ? Math.round(intervalSec / 60) : 0);
    html += `<input type="number" min="0" max="1440" step="1" `
          + `value="${escapeHtml(String(draftMin))}" `
          + `data-th-interval="1" `
          + `${STATE.savingInterval ? 'disabled' : ''}>`;
    html += `<label>minutes</label>`;
    html += `<button class="primary" data-th-interval-save="1" `
          + `${STATE.savingInterval ? 'disabled' : ''}>`
          + `${STATE.savingInterval ? 'Saving…' : 'Save'}</button>`;
    html += `<span style="color:#6b7280;font-size:12px;margin-left:6px;">`
          + `${escapeHtml(fmtIntervalLabel(intervalSec))}`
          + (cfg.last_event ? ` — ${escapeHtml(cfg.last_event)} ${escapeHtml(fmtAgo(cfg.last_event_ts))}` : '')
          + `</span>`;
    if (STATE.intervalStatus) {
      html += `<span class="th-status ${escapeHtml(STATE.intervalStatusKind || 'ok')}">`
            + `${escapeHtml(STATE.intervalStatus)}</span>`;
    }
    html += '</div>';

    html += '<div class="th-footer-row" style="margin-top:10px;">';
    html += `<button class="primary" data-th-refresh="1" `
          + `${STATE.refreshing || inFlight ? 'disabled' : ''}>`
          + `${STATE.refreshing ? 'Refreshing…' : (inFlight ? 'Refresh in flight…' : 'Refresh now')}</button>`;
    html += `<span style="font-size:12px;color:#6b7280;">`
          + `Last attempt ${escapeHtml(fmtAgo(lastAttempt))}.`
          + `</span>`;
    if (STATE.refreshStatus) {
      html += `<span class="th-status ${escapeHtml(STATE.refreshStatusKind || 'ok')}">`
            + `${escapeHtml(STATE.refreshStatus)}</span>`;
    }
    html += `<span class="th-readonly" style="margin-left:auto;">`
          + `Cadence + manual refresh require the SOC manager role.`
          + `</span>`;
    html += '</div>';
    html += '</div>';  // /.th-footer

    root.innerHTML = html;

    // Wire handlers.
    const intInput = root.querySelector('[data-th-interval]');
    if (intInput) {
      intInput.addEventListener('input', () => {
        const v = parseInt(intInput.value, 10);
        STATE.intervalDraft = isNaN(v) ? 0 : v;
      });
    }
    const intSaveBtn = root.querySelector('[data-th-interval-save]');
    if (intSaveBtn) {
      intSaveBtn.addEventListener('click', () => onSaveInterval());
    }
    const refreshBtn = root.querySelector('[data-th-refresh]');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', () => onManualRefresh());
    }
  }

  function renderThreat(t) {
    if (!t || typeof t !== 'object') return '';
    const sev = String(t.severity || 'low').toLowerCase();
    const sevSafe = sev.replace(/[^a-z0-9-]/g, '');
    const title = t.title || '(untitled)';
    const summary = t.summary || '';
    const sources = Array.isArray(t.sources) ? t.sources : [];
    let html = `<div class="th-threat sev-${escapeHtml(sevSafe)}">`;
    html += '<div class="th-threat-head">';
    html += `<span class="th-threat-title">${escapeHtml(title)}</span>`;
    html += `<span class="th-sev-pill sev-${escapeHtml(sevSafe)}">${escapeHtml(sev)}</span>`;
    html += '</div>';
    if (summary) html += `<div class="th-summary">${escapeHtml(summary)}</div>`;
    if (sources.length) {
      html += '<div class="th-sources">Sources: ';
      html += sources.slice(0, 4).map((u) => {
        const url = String(u || '').trim();
        if (!url) return '';
        let host = url;
        try { host = new URL(url).hostname; } catch (_) {}
        return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(host)}</a>`;
      }).join('');
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function renderNotable(n) {
    if (!n || typeof n !== 'object') return '';
    const kind = (n.kind || 'item').toString();
    const title = n.title || '(untitled)';
    const summary = n.summary || '';
    const sources = Array.isArray(n.sources) ? n.sources : [];
    let html = '<div class="th-notable">';
    html += `<span class="th-kind-pill">${escapeHtml(kind)}</span>`;
    html += '<div class="th-notable-body">';
    html += `<strong>${escapeHtml(title)}</strong>`;
    if (summary) html += ` — ${escapeHtml(summary)}`;
    if (sources.length) {
      html += '<div class="th-sources">';
      html += sources.slice(0, 3).map((u) => {
        const url = String(u || '').trim();
        if (!url) return '';
        let host = url;
        try { host = new URL(url).hostname; } catch (_) {}
        return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(host)}</a>`;
      }).join('');
      html += '</div>';
    }
    html += '</div></div>';
    return html;
  }

  function renderWatch(w) {
    if (!w || typeof w !== 'object') return '';
    const ind = w.indicator || '';
    const kind = w.kind || '';
    const rat = w.rationale || '';
    if (!ind) return '';
    let html = '';
    html += `<div class="th-watch-ind" title="${escapeHtml(kind)}">${escapeHtml(ind)}</div>`;
    html += `<div class="th-watch-rat">`;
    if (kind) html += `<span class="th-watch-kind">${escapeHtml(kind)}</span>`;
    html += escapeHtml(rat);
    html += `</div>`;
    return html;
  }

  // ── Networking ─────────────────────────────────────────────────────
  async function fetchHorizon() {
    try {
      const r = await fetch('/api/threat_horizon', { credentials: 'same-origin' });
      if (!r.ok) {
        if (r.status === 401) {
          // Browser session expired — let the user re-auth manually.
          STATE.error = 'Session expired — please reload the page to sign in again.';
          STATE.payload = null;
          render();
          return;
        }
        throw new Error(`HTTP ${r.status}`);
      }
      STATE.payload = await r.json();
      STATE.error = '';
      render();
    } catch (e) {
      STATE.error = String(e.message || e);
      render();
    }
  }

  async function onSaveInterval() {
    const draft = STATE.intervalDraft;
    if (draft == null) return;
    const valSec = Math.max(0, Math.min(86400, Math.round(Number(draft) * 60)));
    STATE.savingInterval = true;
    STATE.intervalStatus = 'Saving…';
    STATE.intervalStatusKind = 'saving';
    render();
    try {
      const r = await fetch('/api/threat_horizon/config', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value_sec: valSec }),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(text || `HTTP ${r.status}`);
      }
      STATE.intervalStatus = 'Saved.';
      STATE.intervalStatusKind = 'ok';
      STATE.intervalDraft = null;
      // Pick up the new interval immediately.
      await fetchHorizon();
    } catch (e) {
      STATE.intervalStatus = String(e.message || e);
      STATE.intervalStatusKind = 'error';
    } finally {
      STATE.savingInterval = false;
      render();
    }
  }

  async function onManualRefresh() {
    if (STATE.refreshing) return;
    STATE.refreshing = true;
    STATE.refreshStatus = 'Refreshing…';
    STATE.refreshStatusKind = 'saving';
    render();
    try {
      const r = await fetch('/api/threat_horizon/refresh', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        throw new Error(text || `HTTP ${r.status}`);
      }
      STATE.payload = await r.json();
      STATE.refreshStatus = 'Refreshed.';
      STATE.refreshStatusKind = 'ok';
    } catch (e) {
      STATE.refreshStatus = String(e.message || e);
      STATE.refreshStatusKind = 'error';
    } finally {
      STATE.refreshing = false;
      render();
    }
  }

  // ── Boot ───────────────────────────────────────────────────────────
  injectStyles();
  fetchHorizon();
  setInterval(fetchHorizon, POLL_MS);

  // Re-render every 5s so the "last updated X ago" / "next refresh
  // in Y" counters tick down without needing a fresh fetch.
  setInterval(() => {
    if (STATE.payload) render();
  }, 5_000);
})();
