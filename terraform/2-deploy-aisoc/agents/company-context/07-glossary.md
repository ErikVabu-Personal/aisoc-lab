# Glossary — maritime + Ship Control Panel terms

## Maritime

- **Bridge** — the navigation deck, where the captain / officer of
  the watch operates the ship.
- **Bridge officer** — a licensed officer on watch. The Ship Control
  Panel is their primary interface.
- **Watch** — a rotating duty shift. Standard pattern is 4-on / 8-off
  in three watches per 24h: `08:00–12:00 / 12:00–16:00`,
  `16:00–20:00 / 20:00–00:00`, `00:00–04:00 / 04:00–08:00`. Watch
  handovers are a common time for `auth.login.success` clusters.
- **Master** — the captain. Highest authority on board. Account name
  is `bo_captain`.
- **Staff captain** — second-in-command, usually handles
  administrative and security functions. Account `bo_staff_captain`.
- **Helm** — the steering position. The throttle slider in the
  Navigation tab is the helm telegraph.
- **Stabilizers / fins** — retractable underwater wings that reduce
  roll. Auto mode is normal; manual is unusual at sea.
- **Anchor watch** — keeping eyes on a set anchor, including the
  AIS / GPS feed, to detect drag.
- **Drydock** — when a ship is in dry dock for maintenance. The
  only window where cameras / connectivity / stabilizers can
  legitimately be in unusual states for extended periods.
- **Port call** — a scheduled stop at a port. Throttle drops, anchor
  cycles, crew sign-on/off, vendor activity.
- **Sea state** — Beaufort scale 0–6. Ship Control Panel exposes the
  current sea state in its bridge header.

## Ship Control Panel events (most-seen)

| Event name                  | Severity / sensitivity | Notes |
|-----------------------------|------------------------|-------|
| `auth.login.success`        | Info                   | High volume during watch handover. |
| `auth.login.failure`        | Info → Warn            | Watch for bursts. |
| `state.changed`             | Info                   | PATCH-style log; coarse-grained. |
| `navigation.throttle`       | Info                   | Throttle slider moved. |
| `navigation.destination`    | Info                   | Destination map drag. |
| `anchor`                    | Info                   | Anchor state transition. |
| `stabilizers`               | Info                   | Mode change (AUTO/MANUAL). |
| `connectivity`              | Warn (when disabled)   | Uplink toggle. |
| `collision`                 | Warn (when disabled)   | Collision detection toggle. |
| `security`                  | Warn (when disabled)   | Cameras toggle — high signal. |
| `entertainment`             | Info                   | Lots of noise; usually skip. |
| `climate`                   | Info                   | Lots of noise; per-room AC. |

## SOC terms (NVISO-specific shorthand)

- **AISOC** — the AI SOC pipeline (this project). Triage →
  Investigator → Reporter, with Detection Engineer + SOC Manager +
  Threat Intel as horizontal agents.
- **Brussels NOC** — 24/7 network operations centre at HQ. Has
  remote-override authority on every vessel.
- **HITL** — human-in-the-loop. The agent calls `ask_human` and
  blocks until a human at the SOC desk replies in free text.
- **CONFIDENCE_THRESHOLD** — the operator-set 0–100 dial that biases
  how readily an agent reaches for `ask_human` (low → ask more
  often; high → push through).

## NVISO-specific abbreviations

- **NVISO Cruiseways** = the operating brand. (Not a typo for
  "NVISO Cruises" — the legal entity uses the longer form.)
- **CR-NNNN** = voyage code. CR-2614 was the demo voyage; M/S Aegir
  on its 11-day Mediterranean loop.
- **PSA** = the Belgian Federal Public Service Authority that
  oversees flagged-vessel cyber compliance.
