// default_zoom.js
// ────────────────────────────────────────────────────────────────────
// Bumps the Pixel Agents canvas zoom on first load so the office
// fills a more useful slice of the screen. The vendored bundle has
// "+" / "-" buttons in the top-left of the canvas; we just click "+"
// a few times once the bundle has mounted. Cheaper than reverse-
// engineering the bundle's zoom API.

(function () {
  'use strict';

  const TARGET_BUMPS = 3;        // how many "+" clicks to apply
  const CLICK_INTERVAL_MS = 120; // small gap so the bundle's state settles
  const POLL_INTERVAL_MS = 200;  // wait for the "+" button to mount
  const POLL_TIMEOUT_MS = 8000;  // give up if it never appears

  function findZoomInButton() {
    // The bundle's zoom buttons are plain <button>s with literal "+" /
    // "-" labels. Match by trimmed text content — robust against
    // class-name churn between bundle versions.
    return Array.from(document.querySelectorAll('button')).find(
      (b) => (b.textContent || '').trim() === '+'
    );
  }

  function applyBumps(btn) {
    let n = 0;
    function tick() {
      if (n >= TARGET_BUMPS) return;
      btn.click();
      n += 1;
      setTimeout(tick, CLICK_INTERVAL_MS);
    }
    tick();
  }

  // Don't run on every refresh — only the first time per session.
  // Otherwise re-zooming after the user has manually adjusted feels
  // hostile.
  const SESSION_KEY = 'aisoc_default_zoom_applied';
  if (sessionStorage.getItem(SESSION_KEY) === '1') return;

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  function poll() {
    const btn = findZoomInButton();
    if (btn) {
      sessionStorage.setItem(SESSION_KEY, '1');
      applyBumps(btn);
      return;
    }
    if (Date.now() >= deadline) return;  // bundle didn't render the button — nothing to do
    setTimeout(poll, POLL_INTERVAL_MS);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(poll, 400);
  } else {
    window.addEventListener('load', () => setTimeout(poll, 400));
  }
})();
