// default_zoom.js
// ────────────────────────────────────────────────────────────────────
// Bumps the Pixel Agents canvas zoom on first load so the office
// fills a more useful slice of the screen. The vendored bundle has
// "+" / "-" controls in the top-left corner; we just click "+" once
// after the bundle has mounted.

(function () {
  'use strict';

  const TARGET_BUMPS = 1;        // one bump is plenty
  const CLICK_INTERVAL_MS = 120;
  const POLL_INTERVAL_MS = 200;
  const POLL_TIMEOUT_MS = 8000;

  function findZoomInButton() {
    // The bundle could render the zoom-in button several ways. Try them
    // in order of specificity:
    //   1. Plain text "+"
    //   2. aria-label / title containing "zoom" + "in"
    //   3. A button whose only text *child* is "+" (e.g. wrapped in a span)
    const candidates = document.querySelectorAll('button, [role="button"]');
    let plus = null;
    for (const el of candidates) {
      const text = (el.textContent || '').trim();
      const aria = (el.getAttribute('aria-label') || '').toLowerCase();
      const title = (el.getAttribute('title') || '').toLowerCase();
      if (text === '+') return el;
      if ((aria.includes('zoom') && (aria.includes('in') || aria.includes('+'))) ||
          (title.includes('zoom') && (title.includes('in') || title.includes('+')))) {
        return el;
      }
      // Fallback: first button with just "+" text content (might match later)
      if (!plus && text === '+') plus = el;
    }
    return plus;
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

  // Don't re-zoom on every refresh — only the first time per session.
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
    if (Date.now() >= deadline) return;
    setTimeout(poll, POLL_INTERVAL_MS);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(poll, 400);
  } else {
    window.addEventListener('load', () => setTimeout(poll, 400));
  }
})();
