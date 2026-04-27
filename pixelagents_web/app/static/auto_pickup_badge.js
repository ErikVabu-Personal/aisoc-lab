// auto_pickup_badge.js
// ────────────────────────────────────────────────────────────────────
// Read-only badge for the Live Agent View. Shows the current state of
// the auto-pickup feature so the analyst can see at a glance whether
// the system is auto-triggering on new Sentinel incidents. The toggle
// itself lives on /config — this is a status indicator only.

(function () {
  'use strict';

  const POLL_MS = 5000;

  const css = `
    #aisoc-auto-pickup-badge {
      position: fixed;
      bottom: 16px;
      left: 16px;
      z-index: 50;
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      border-radius: 999px;
      font: 600 12px -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      background: rgba(31, 41, 55, 0.85);
      color: #ffffff;
      box-shadow: 0 4px 12px rgba(0,0,0,0.18);
      backdrop-filter: blur(6px);
      cursor: default;
      user-select: none;
      pointer-events: auto;
      transition: background 0.2s ease;
    }
    #aisoc-auto-pickup-badge.on { background: rgba(16, 185, 129, 0.92); }
    #aisoc-auto-pickup-badge.off { background: rgba(107, 114, 128, 0.85); }
    #aisoc-auto-pickup-badge .ap-led {
      width: 8px; height: 8px;
      border-radius: 50%;
      background: #ffffff;
      box-shadow: 0 0 0 0 rgba(255,255,255,0.6);
    }
    #aisoc-auto-pickup-badge.on .ap-led {
      animation: ap-pulse 1.6s ease-out infinite;
    }
    @keyframes ap-pulse {
      0%   { box-shadow: 0 0 0 0 rgba(255,255,255,0.7); }
      70%  { box-shadow: 0 0 0 8px rgba(255,255,255,0); }
      100% { box-shadow: 0 0 0 0 rgba(255,255,255,0); }
    }
    #aisoc-auto-pickup-badge .ap-link {
      margin-left: 4px;
      color: #ffffff;
      text-decoration: underline;
      text-decoration-color: rgba(255,255,255,0.4);
      text-underline-offset: 2px;
      cursor: pointer;
    }
    #aisoc-auto-pickup-badge .ap-link:hover {
      text-decoration-color: #ffffff;
    }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const badge = document.createElement('div');
  badge.id = 'aisoc-auto-pickup-badge';
  badge.className = 'off';
  badge.innerHTML =
    '<span class="ap-led"></span>'
    + '<span class="ap-text">Auto-pickup: …</span>'
    + '<a class="ap-link" href="/config" title="Configure auto-pickup">configure</a>';
  document.body.appendChild(badge);

  const textEl = badge.querySelector('.ap-text');

  async function poll() {
    try {
      const r = await fetch('/api/auto_pickup', { credentials: 'same-origin' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const state = await r.json();
      const on = !!state.enabled;
      badge.classList.toggle('on', on);
      badge.classList.toggle('off', !on);
      textEl.textContent = on ? 'Auto-pickup: ON' : 'Auto-pickup: OFF';
      if (on && state.last_event) {
        badge.title = `${state.last_event}`;
      } else {
        badge.title = on
          ? 'Continuously monitoring Sentinel for new incidents.'
          : 'Auto-pickup is disabled. Workflows must be triggered manually.';
      }
    } catch (e) {
      textEl.textContent = 'Auto-pickup: ?';
      badge.classList.remove('on');
      badge.classList.add('off');
      badge.title = 'Could not load auto-pickup state.';
    }
  }

  poll();
  setInterval(poll, POLL_MS);
})();
