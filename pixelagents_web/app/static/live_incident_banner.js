// live_incident_banner.js
// ────────────────────────────────────────────────────────────────────
// Banner on the Live Agent View that surfaces (a) which incident the
// agents are working on right now, (b) its title, and (c) how many
// other open incidents are still in the queue. Polls
// /api/current_incident for the live state and /api/sentinel/incidents
// for the title + backlog count.

(function () {
  'use strict';

  const POLL_MS = 2000;
  const ROOT_ID = 'aisoc-live-incident';

  const css = `
    #${ROOT_ID} {
      position: fixed;
      top: 72px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 998;
      padding: 12px 22px;
      background: rgba(0,153,204,0.10);
      border: 2px solid #0099cc;
      border-radius: 14px;
      font: 16px -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
      color: #0e2a47;
      display: none;
      align-items: center;
      gap: 14px;
      box-shadow: 0 2px 14px rgba(0,153,204,0.18);
      max-width: 80vw;
    }
    #${ROOT_ID}.visible { display: inline-flex; }
    #${ROOT_ID} .pulse {
      width: 12px; height: 12px; border-radius: 50%;
      background: #0099cc;
      animation: aisoc-live-pulse 1.6s ease-in-out infinite;
      flex-shrink: 0;
    }
    @keyframes aisoc-live-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(0,153,204,0.65); }
      50%      { box-shadow: 0 0 0 10px rgba(0,153,204,0);  }
    }
    #${ROOT_ID} .stack {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;       /* allow children to ellipsis-truncate */
    }
    #${ROOT_ID} .line1 { font-weight: 700; font-size: 17px; }
    #${ROOT_ID} .line1 .num { color: #0099cc; }
    #${ROOT_ID} .title {
      font-weight: 500;
      font-size: 15px;
      color: #1f2937;
      max-width: 60vw;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    #${ROOT_ID} .meta {
      font-size: 13px; color: #6b7280;
      font-variant-numeric: tabular-nums;
    }
    #${ROOT_ID} .meta .sep { margin: 0 6px; color: #cbd5e1; }
    #${ROOT_ID} .meta .backlog {
      color: #1f2937; font-weight: 600;
    }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.innerHTML = `
    <span class="pulse"></span>
    <div class="stack">
      <div class="line1">Agents are working on Incident <span class="num" id="aisoc-li-num">—</span></div>
      <div class="title" id="aisoc-li-title">—</div>
      <div class="meta">
        <span class="elapsed" id="aisoc-li-elapsed">—</span>
        <span class="sep">·</span>
        <span><span class="backlog" id="aisoc-li-backlog">0</span> in queue</span>
      </div>
    </div>
  `;
  document.body.appendChild(root);

  const numEl     = root.querySelector('#aisoc-li-num');
  const titleEl   = root.querySelector('#aisoc-li-title');
  const elapsedEl = root.querySelector('#aisoc-li-elapsed');
  const backlogEl = root.querySelector('#aisoc-li-backlog');

  let incidentsCache = [];
  let incidentsCacheTs = 0;
  const INCIDENTS_CACHE_TTL_MS = 6000;

  function fmtElapsed(secs) {
    if (secs < 60) return `${Math.floor(secs)}s`;
    const m = Math.floor(secs / 60), s = Math.floor(secs % 60);
    return `${m}m${String(s).padStart(2, '0')}s`;
  }

  async function getIncidents() {
    const now = Date.now();
    if (incidentsCache.length && (now - incidentsCacheTs) < INCIDENTS_CACHE_TTL_MS) {
      return incidentsCache;
    }
    try {
      const r = await fetch('/api/sentinel/incidents', { credentials: 'same-origin' });
      if (!r.ok) return incidentsCache;
      const data = await r.json();
      incidentsCache = (data && data.incidents) || [];
      incidentsCacheTs = now;
    } catch (_) { /* swallow */ }
    return incidentsCache;
  }

  function findIncident(num) {
    return incidentsCache.find((i) => Number(i.number) === Number(num)) || null;
  }

  function backlogCount(activeNum) {
    // Backlog = open (non-Closed) incidents excluding the one currently
    // being worked on. Captures "other things waiting for attention."
    return incidentsCache.filter((i) => {
      const status = String(i.status || '').toLowerCase();
      if (status === 'closed') return false;
      return Number(i.number) !== Number(activeNum);
    }).length;
  }

  async function tick() {
    try {
      const r = await fetch('/api/current_incident', { credentials: 'same-origin' });
      if (!r.ok) { root.classList.remove('visible'); return; }
      const data = await r.json();
      if (!data || data.incident_number == null) {
        root.classList.remove('visible');
        return;
      }

      // Refresh the incidents list (cached) so we can render title +
      // backlog without each banner tick hammering ARM.
      const incidents = await getIncidents();
      void incidents;  // ensure cache populated

      const num = data.incident_number;
      const inc = findIncident(num);

      numEl.textContent = `#${num}`;
      titleEl.textContent = (inc && inc.title) ? inc.title : '(title unavailable)';
      if (data.started_at) {
        const elapsed = (Date.now() / 1000) - data.started_at;
        elapsedEl.textContent = `Running ${fmtElapsed(elapsed)}`;
      } else {
        elapsedEl.textContent = 'Starting…';
      }
      backlogEl.textContent = String(backlogCount(num));
      root.classList.add('visible');
    } catch (_) {
      // Network blip — keep current visibility.
    }
  }

  tick();
  setInterval(tick, POLL_MS);
})();
