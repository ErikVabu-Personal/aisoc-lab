# Ship Control Panel

The "victim" web app for the AISOC demo — a Next.js 15 bridge-and-
operations console for the fictional NVISO Cruiseways fleet. Every
state change emits a structured JSON line to stdout; the Container
App ships stdout to Log Analytics, where Sentinel's analytic rules
pick it up. Two demo-friendly attack triggers:

1. Hit `/login` repeatedly with bad credentials → fires the
   "repeated login failures" rule.
2. Sign in once, open the Security tab, click "Disable cameras" →
   emits a `severity:warn` `event:"security"` line that Sentinel
   rules treat as textbook attacker tradecraft.

## Demo credentials

- username: `administrator`
- password: `pirates`

These are **demo-only** — no real auth, intentionally minimal so the
"how the panel got compromised" part of a demo doesn't get in the
way of "what AISOC does next". `administrator` is a deliberately
generic / shared account; the demo's identity-mapping narrative
leans on cross-source correlation (SCP failed-login source IP →
known workstation `BRIDGE-WS` → `jack.sparrow` interactively
logged in on that host per Windows auth logs) rather than on the
SCP username itself.

## Subsystems (one tab each)

- **Navigation** — chart with destination drag, throttle telegraph,
  collision-detection toggle.
- **Anchor** — four states (`HOME` / `PAYING_OUT` / `HOLDING` /
  `DRAGGING`) with state-transition events.
- **Stabilizers** — port + starboard fin angles, OFF / STANDBY /
  AUTO / MANUAL modes.
- **Connectivity** — Starlink uplink toggle + simulated speedtest.
- **Climate** — per-room AC.
- **Entertainment** — pool / sauna / steam, lighting scenes,
  ship-wide media.
- **Security** — 2x3 CCTV grid (placeholder GIFs in
  `public/security/`) with a "Disable cameras" toggle. The toggle
  emits `event:"security"` with `severity:"warn"` when cameras go
  off — that's the alert family the Investigator's runbook in the
  `company-context` KB is written around.

The shell (header + status strip + tab nav + footer) is in
`app/page.tsx`; each subsystem is one component under
`app/components/`. The CSS lives in `app/globals.css` — light
theme, navy + steel-blue, monospace numerical readouts.

## Structured event log

Every state-changing API hit emits one line of JSON to stdout.
Examples:

```json
{"time":"…","service":"ship-control-panel","event":"auth.login.success",
 "detail":{"username":"administrator","client":"203.0.113.42"}}

{"time":"…","service":"ship-control-panel","event":"security",
 "detail":{"changed":["camerasEnabled"],"severity":"warn",
   "from":{"camerasEnabled":true},"to":{"camerasEnabled":false}},
 "meta":{"client":"203.0.113.42","userAgent":"…"}}
```

The KQL base filter the AISOC agents use to read these lines:

```kusto
ContainerAppConsoleLogs_CL
| where Stream_s == "stdout"
| extend j = parse_json(Log_s)
| where j.service == "ship-control-panel"
```

Event names worth knowing for triage:

| Event | Severity hint |
|-------|---------------|
| `auth.login.success` | info |
| `auth.login.failure` | info → warn (when bursting) |
| `state.changed` | info |
| `navigation.throttle` | info |
| `navigation.destination` | info |
| `anchor` | info |
| `stabilizers` | info (manual mode = warn) |
| `connectivity` | warn when `enabled:false` |
| `collision` | warn when `enabled:false` |
| `security` | warn when `camerasEnabled:false` |
| `climate` / `entertainment` | info — usually noise |

## Run locally

```bash
npm install
npm run dev
# open http://localhost:3000
```

## Build

```bash
npm run build
npm run start
```

`next.config.js` sets `output: 'standalone'` so the Dockerfile build
copies just the runtime payload.

## Container build

```bash
docker build -t ship-control-panel:local .
docker run --rm -p 3000:3000 ship-control-panel:local
```

Production lives as a public Container App, deployed via Phase 1
Terraform (`ship_control_panel.tf`) and the
`deploy-ship-control-panel.yml` GitHub Actions workflow on every
push under `ship-control-panel/**`.

## Camera GIFs

The Security tab tries to load `/security/{bridge,atrium,engine,
promenade,pooldeck,gangway}.gif`. The repo ships hand-generated
placeholder loops; the generator is at
`scripts/generate_camera_gifs.py` (Pillow, ~1.5-second loops,
~150 KB each). To swap the placeholders for real footage, drop your
own files at the same paths.
