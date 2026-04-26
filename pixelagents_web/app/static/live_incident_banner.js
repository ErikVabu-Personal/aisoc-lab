// live_incident_banner.js
// ────────────────────────────────────────────────────────────────────
// Small floating banner on the Live Agent View that surfaces the
// incident currently being orchestrated. Polls /api/current_incident
// and shows / hides itself. Kept deliberately minimal — the goal is
// "you can see what the agents are working on at a glance," not a
// full incident detail panel (that's the Dashboard).

(function () {
  'use strict';

  const POLL_MS = 2000;
  const ROOT_ID = 'aisoc-live-incident';

  const css = `
    #${ROOT_ID} {
      position: fixed;
      top: 70px;       /* below the sticky top nav */
      left: 50%;
      transform: translateX(-50%);
      z-index: 998;
      padding: 8px 18px;
      background: rgba(0,153,204,0.10);
      border: 2px solid #0099cc;
      border-radius: 999px;
      font: 13px -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      color: #0e2a47;
      display: none;
      align-items: center;
      gap: 10px;
      box-shadow: 0 2px 12px rgba(0,153,204,0.15);
    }
    #${ROOT_ID}.visible { display: inline-flex; }
    #${ROOT_ID} .pulse {
      width: 8px; height: 8px; border-radius: 50%;
      background: #0099cc;
      animation: aisoc-live-pulse 1.4s ease-in-out infinite;
    }
    @keyframes aisoc-live-pulse {
      0%, 100% { box-shadow: 0 0 0 0 rgba(0,153,204,0.6); }
      50%      { box-shadow: 0 0 0 8px rgba(0,153,204,0);  }
    }
    #${ROOT_ID} b { color: #0099cc; }
    #${ROOT_ID} .elapsed { color: #6b7280; font-variant-numeric: tabular-nums; }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.id = ROOT_ID;
  root.innerHTML = `
    <span class="pulse"></span>
    <span>Agents are working on incident <b id="aisoc-li-num">—</b></span>
    <span class="elapsed" id="aisoc-li-elapsed"></span>
  `;
  document.body.appendChild(root);

  const numEl = root.querySelector('#aisoc-li-num');
  const elapsedEl = root.querySelector('#aisoc-li-elapsed');

  function fmtElapsed(secs) {
    if (secs < 60) return `${Math.floor(secs)}s`;
    const m = Math.floor(secs / 60), s = Math.floor(secs % 60);
    return `${m}m${String(s).padStart(2, '0')}s`;
  }

  async function tick() {
    try {
      const r = await fetch('/api/current_incident', { credentials: 'same-origin' });
      if (!r.ok) {
        root.classList.remove('visible');
        return;
      }
      const data = await r.json();
      if (data && data.incident_number != null) {
        numEl.textContent = `#${data.incident_number}`;
        if (data.started_at) {
          const elapsed = (Date.now() / 1000) - data.started_at;
          elapsedEl.textContent = `· running ${fmtElapsed(elapsed)}`;
        } else {
          elapsedEl.textContent = '';
        }
        root.classList.add('visible');
      } else {
        root.classList.remove('visible');
      }
    } catch (_) {
      // Network blip — keep current visibility.
    }
  }

  tick();
  setInterval(tick, POLL_MS);
})();
