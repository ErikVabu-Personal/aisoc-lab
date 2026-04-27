// auto_pickup_badge.js
// ────────────────────────────────────────────────────────────────────
// Read-only badges for the Live Agent View. Shows the current state of
// the auto-pickup and auto-close features so the analyst can see at a
// glance how the system is configured. The toggles themselves live on
// /config — these are status indicators only.

(function () {
  'use strict';

  const POLL_MS = 5000;

  const css = `
    #aisoc-auto-badges {
      position: fixed;
      bottom: 16px;
      left: 16px;
      z-index: 50;
      display: flex;
      flex-direction: column;
      gap: 6px;
      pointer-events: none;
    }
    #aisoc-auto-badges .ap-badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 6px 12px;
      border-radius: 999px;
      font: 600 11px -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: #ffffff;
      box-shadow: 0 4px 12px rgba(0,0,0,0.18);
      backdrop-filter: blur(6px);
      cursor: default;
      user-select: none;
      pointer-events: auto;
      transition: background 0.2s ease;
    }
    #aisoc-auto-badges .ap-badge.on  { background: rgba(16, 185, 129, 0.92); }
    #aisoc-auto-badges .ap-badge.off { background: rgba(107, 114, 128, 0.85); }
    #aisoc-auto-badges .ap-badge.unknown { background: rgba(31, 41, 55, 0.85); }
    #aisoc-auto-badges .ap-led {
      width: 7px; height: 7px;
      border-radius: 50%;
      background: #ffffff;
      box-shadow: 0 0 0 0 rgba(255,255,255,0.6);
    }
    #aisoc-auto-badges .ap-badge.on .ap-led {
      animation: ap-pulse 1.6s ease-out infinite;
    }
    @keyframes ap-pulse {
      0%   { box-shadow: 0 0 0 0 rgba(255,255,255,0.7); }
      70%  { box-shadow: 0 0 0 7px rgba(255,255,255,0); }
      100% { box-shadow: 0 0 0 0 rgba(255,255,255,0); }
    }
    #aisoc-auto-badges .ap-link {
      margin-left: 4px;
      color: #ffffff;
      text-decoration: underline;
      text-decoration-color: rgba(255,255,255,0.4);
      text-underline-offset: 2px;
      cursor: pointer;
    }
    #aisoc-auto-badges .ap-link:hover {
      text-decoration-color: #ffffff;
    }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const wrap = document.createElement('div');
  wrap.id = 'aisoc-auto-badges';
  wrap.innerHTML = `
    <div class="ap-badge unknown" data-key="pickup">
      <span class="ap-led"></span>
      <span class="ap-text">Auto-pickup: …</span>
    </div>
    <div class="ap-badge unknown" data-key="close">
      <span class="ap-led"></span>
      <span class="ap-text">Auto-close: …</span>
      <a class="ap-link" href="/config" title="Configure auto-pickup and auto-close">configure</a>
    </div>
  `;
  document.body.appendChild(wrap);

  function setBadge(key, state, label, helpText) {
    const el = wrap.querySelector(`.ap-badge[data-key="${key}"]`);
    if (!el) return;
    el.classList.remove('on', 'off', 'unknown');
    el.classList.add(state);
    const txt = el.querySelector('.ap-text');
    if (txt) txt.textContent = label;
    if (helpText) el.title = helpText;
  }

  async function fetchJson(path) {
    const r = await fetch(path, { credentials: 'same-origin' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  }

  async function pollPickup() {
    try {
      const s = await fetchJson('/api/auto_pickup');
      const on = !!s.enabled;
      setBadge('pickup', on ? 'on' : 'off',
        on ? 'Auto-pickup: ON' : 'Auto-pickup: OFF',
        on
          ? (s.last_event || 'Continuously monitoring Sentinel for new incidents.')
          : 'Auto-pickup is disabled. Workflows must be triggered manually.');
    } catch (_) {
      setBadge('pickup', 'unknown', 'Auto-pickup: ?', 'Could not load auto-pickup state.');
    }
  }

  async function pollClose() {
    try {
      const s = await fetchJson('/api/auto_close');
      const on = !!s.enabled;
      setBadge('close', on ? 'on' : 'off',
        on ? 'Auto-close: ON' : 'Auto-close: OFF',
        on
          ? (s.last_event || 'Reporter may close incidents in Sentinel when confident.')
          : 'Auto-close is disabled. Every run hands back to the analyst.');
    } catch (_) {
      setBadge('close', 'unknown', 'Auto-close: ?', 'Could not load auto-close state.');
    }
  }

  function pollAll() {
    pollPickup();
    pollClose();
  }

  pollAll();
  setInterval(pollAll, POLL_MS);
})();
