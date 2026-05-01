# Monitored systems — Ship Control Panel subsystems

The **Ship Control Panel** (Bridge & Operations) is the only system
currently in scope for AISOC monitoring. It's the operations surface
the bridge officer uses while the ship is at sea. The application
runs on each vessel's operations network and forwards its logs to
the Brussels Sentinel workspace via Container Apps.

The panel groups its functionality into the following subsystems —
each is a distinct tab in the UI and emits its own log events.

## Subsystems

### Navigation
Heading, throttle, destination plotting on a chart. Throttle changes
emit `event="navigation.throttle"`; destination drags emit
`event="navigation.destination"`. The collision-detection toggle
(`event="collision"`) is part of this subsystem in the UI but logs
under its own event name.

### Anchor
Four states — `HOME`, `PAYING_OUT`, `HOLDING`, `DRAGGING`. State
transitions emit `event="anchor"` with `from`/`to` payloads. A
`DRAGGING` state during a holding watch is alert-worthy — it means
the anchor isn't holding bottom and the ship is drifting.

### Stabilizers
`OFF / STANDBY / AUTO / MANUAL` modes. Fin angles are normally driven
by `AUTO` based on observed roll. Switching to `MANUAL` and pinning
extreme fin angles is unusual outside drydock prep — flag for
investigation.

### Connectivity
Starlink uplink + simulated speedtest. Disabling connectivity
(`event="connectivity"` with `enabled: false`) cuts the ship off from
shore-side systems, including remote logging and remote support.
This is highly suspicious during normal sailing.

### Climate
Per-room AC. Climate changes (`event="climate"`) are usually noise.
Rooms that matter for incidents: **Bridge** (loss of climate at the
helm is an HSE issue), **Engine room** (overheat risk).

### Entertainment
Pool, sauna, music zones, lighting scenes. Mostly informational
events. The `scene` and `volume` fields are the most-changed data
points — high-traffic, low signal value.

### Security (CCTV)
2x3 grid of camera feeds. Disabling cameras
(`event="security"` with `severity:"warn"`, `to.camerasEnabled:false`)
is **textbook attacker tradecraft** — cuts off recording before a
physical or social-engineering action. Treat as high-confidence
indicator of compromise.

## What "normal" looks like

- Sustained `auth.login.success` for known crew accounts during
  watch handover (08:00 / 16:00 / 00:00 ship local).
- Throttle changes at port arrivals/departures (consult the voyage
  schedule).
- Climate adjustments during weather changes.
- Anchor state cycling at port calls (`HOME` → `PAYING_OUT` →
  `HOLDING` and back).
- Stabilizer auto-mode all the time at sea.
- Cameras `enabled: true`, full 24/7.

## What "abnormal" looks like

- Sustained `auth.login.failure` against a single account from a
  single source IP — credential stuffing.
- `security` event with `to.camerasEnabled: false` — cameras off.
- `connectivity` event with `enabled: false` mid-voyage — uplink
  disabled.
- Stabilizer flipped to `MANUAL` with extreme fin angles outside
  drydock prep.
- Anchor `DRAGGING` while underway is impossible (UI bug, not an
  alert); `DRAGGING` while supposed to be `HOLDING` at a port call
  is a real alarm.
