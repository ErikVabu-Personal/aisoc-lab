// bottom_bar_layout.js
// ────────────────────────────────────────────────────────────────────
// Center the bundle's bottom button cluster (Agent / Layout /
// Settings) horizontally beneath the office. The chat-drawer button
// is positioned (via its own CSS) to sit visually next to the
// centered cluster.
//
// Strategy:
//   1. Wait for the bundle to mount its bottom buttons.
//   2. Find them by text content ("Agent", "Layout", "Settings").
//   3. Walk up to their common parent.
//   4. Tag that parent with .aisoc-bottom-bar — CSS rule below
//      then anchors it to bottom-center of the viewport.

(function () {
  'use strict';

  const POLL_INTERVAL_MS = 250;
  const POLL_TIMEOUT_MS = 10000;

  // Inject CSS once. The override wins thanks to !important; using a
  // class instead of a generated selector keeps things stable across
  // bundle versions. The bundle's `#root` is now constrained to the
  // viewport width minus the right-side Agent Communication sidebar
  // (var(--aisoc-sidebar-width)), so we centre the button row at the
  // *midpoint of the constrained area*, not the full viewport.
  const css = `
    .aisoc-bottom-bar {
      left: calc((100vw - var(--aisoc-sidebar-width, 0px)) / 2) !important;
      right: auto !important;
      transform: translateX(-50%) !important;
      display: flex !important;
      gap: 6px !important;
      align-items: center !important;
    }
  `;
  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  function matchesBundleButton(el) {
    const t = (el.textContent || '').trim();
    // The bundle's "+ Agent" button has a leading plus + space; match
    // forgivingly.
    return t === 'Layout' || t === 'Settings' || /^\+?\s*Agent$/i.test(t);
  }

  function findBundleButtons() {
    const all = document.querySelectorAll('button, [role="button"]');
    return Array.from(all).filter(matchesBundleButton);
  }

  function findCommonParent(els) {
    if (!els.length) return null;
    let parent = els[0].parentElement;
    while (parent && !els.every((b) => parent.contains(b))) {
      parent = parent.parentElement;
    }
    return parent;
  }

  function tryCenter() {
    const buttons = findBundleButtons();
    if (buttons.length < 2) return false;
    const parent = findCommonParent(buttons);
    if (!parent) return false;
    if (parent.classList.contains('aisoc-bottom-bar')) return true;
    parent.classList.add('aisoc-bottom-bar');
    return true;
  }

  const deadline = Date.now() + POLL_TIMEOUT_MS;
  function poll() {
    if (tryCenter()) return;
    if (Date.now() >= deadline) return;
    setTimeout(poll, POLL_INTERVAL_MS);
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(poll, 400);
  } else {
    window.addEventListener('load', () => setTimeout(poll, 400));
  }
})();
