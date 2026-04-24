/*
 * AISOC agent activity cleanup shim.
 *
 * The vendored Pixel Agents UI accumulates tool chips as agents call
 * tools — each distinct toolId is added to the agent's list and marked
 * "done" when the call ends, but nothing ever clears the list. After a
 * workflow the reporter/investigator end up displaying every tool they
 * ever invoked, which reads as a flip-flop between idle and the stale
 * "last active" tool name even when no events are currently firing.
 *
 * This script polls /api/agents/state and, whenever an agent transitions
 * from active (reading/typing) to idle, dispatches an `agentToolsClear`
 * postMessage for that agent's numeric id. That's a message the vendored
 * useExtensionMessages hook already handles — it wipes the agent's tool
 * list and clears the active-tool overlay on the character.
 *
 * Relies on `window.__aisoc.dispatch` + `window.__aisoc.nameToId`, which
 * the browserMock adapter exposes once it's ready.
 */

(function () {
  'use strict';

  const lastStatus = new Map(); // agent slug -> previous status

  function isActive(status) {
    return status === 'reading' || status === 'typing';
  }

  async function tick() {
    const bridge = window.__aisoc;
    if (!bridge || !bridge.nameToId || !bridge.dispatch) {
      // Adapter not ready yet; try again on the next tick.
      return;
    }

    let data;
    try {
      const res = await fetch('/api/agents/state');
      if (!res.ok) return;
      data = await res.json();
    } catch (_) {
      return;
    }

    const agents = (data && data.agents) || [];
    for (const a of agents) {
      const name = a.id;
      const cur = a.status;
      const prev = lastStatus.get(name);
      lastStatus.set(name, cur);

      if (prev == null) continue; // first tick — no transition to react to

      const id = bridge.nameToId.get(name);
      if (id == null) continue; // character not mounted yet

      if (isActive(prev) && !isActive(cur)) {
        // Active -> idle. Clear lingering tool chips so the next
        // workflow run starts with a clean overlay.
        bridge.dispatch({ type: 'agentToolsClear', id });
      }
    }
  }

  // Poll at roughly the same cadence as the adapter (750ms) so we don't
  // lag behind state transitions.
  setInterval(tick, 750);
})();
