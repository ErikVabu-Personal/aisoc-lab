# Ship Control Panel — logging schema (canonical reference)

The agents query the SCP's logs through the `ContainerAppConsoleLogs_CL`
table in Sentinel. Every state-changing API call on the SCP emits a
single JSON line on stdout from the Container App; AMA forwards it to
Log Analytics. This page is the canonical reference — when in doubt
about a field name or what events exist, **retrieve this page first**
before guessing.

## Scope warning — SCP auth events live HERE, not in SecurityEvent

Sentinel ingests TWO independent auth-failure data streams in this
deployment, and they are easy to confuse:

| Stream | Table | What it is |
|--------|-------|------------|
| **Ship Control Panel** application auth failures | `ContainerAppConsoleLogs_CL` | The events the `Control Panel: multiple failed logins (user + IP)` rule fires on. |
| **Windows OS** auth failures on `BRIDGE-WS` | `SecurityEvent` (EventID 4625) | Internet-exposed `BRIDGE-WS` gets unrelated brute-force attempts at the OS / RDP layer. NOT what SCP rules are about. |

**For incidents from the SCP analytic rule, you query
`ContainerAppConsoleLogs_CL` only. Period.** Do not summarise
SecurityEvent 4625 rows; do not correlate Windows-side usernames
(`-\SYSTEM` / `-\ADMIN` / `-\ADMINISTRADOR` / `-\ADMINISTRATOR`)
into an SCP triage. Those are real attacks but they're against a
different surface (Windows RDP/SMB, not the SCP web app), they
came in via a different rule (or none — if no Windows-side rule
is configured), and they're not the evidence the SCP incident was
created from.

The unambiguous signal that an event came from the SCP and not
from Windows: the username is the SCP shared account
`administrator` (no domain prefix, no backslash) and the source
IP is in `j.detail.client`. Anything else — domain-prefixed
usernames, backslashes, hosts in `Computer` field — is a
SecurityEvent / Event row that belongs to a different
investigation.

## Server-side vs client-side events — only server-side reaches Sentinel

The SCP is a Next.js app with both server-side handlers (server
actions, API routes) and client-side React components. Log lines
written from server-side code go to the Container App's stdout and
flow into Sentinel; log lines written from client-side components
go to the browser's DevTools console and **do not** reach Sentinel.

The server-side surface — and therefore the events Sentinel can see
— is:

- **`app/login/actions.ts`** — login / logout server actions.
- **`app/api/state/route.ts`** — `GET` / `PATCH` / `POST` handlers
  for the in-memory state store that backs every UI tab.

Anything emitted from `app/components/*.tsx` files (which are all
`'use client'`) is NOT in the table. Notably: the engine-room view
emits local `engine.clutch` and `engine.fuelMix` events for visual
feedback — those events DO NOT reach Sentinel and you cannot detect
on them.

## Table + base filter

```kusto
ContainerAppConsoleLogs_CL
| where Stream_s == "stdout"
| extend j = parse_json(Log_s)
| where j.service == "ship-control-panel"
```

`j` then exposes the structured event. From here you `extend` the
specific fields you care about.

`Stream_s == "stdout"` filters out stderr (Node startup banners,
warnings) so `parse_json(Log_s)` is reliable. `j.service ==
"ship-control-panel"` disambiguates SCP events from any future
neighbour app in the same Container App environment.

## Two log shapes you'll encounter

There are **two** emission paths in the SCP, and they wrap the
client/UA fields in slightly different places. This matters because
KQL extracting `client` from the wrong path returns nulls.

### Shape A — auth events (`auth.*`)

Emitted from `app/login/actions.ts`. The function signature is
`logEvent(event, detail)` — there is **no `meta` object**, and
`client` / `userAgent` live inside `detail`.

```json
{
  "time": "2026-05-02T13:08:11Z",
  "service": "ship-control-panel",
  "event": "auth.login.failure",
  "detail": {
    "username": "administrator",
    "client": "203.0.113.42",
    "userAgent": "Mozilla/5.0 (...) Firefox/124.0"
  }
}
```

### Shape B — state events (everything else)

Emitted from `app/api/state/route.ts`. The function signature is
`logEvent(event, detail, meta)` — `client` and `userAgent` live in
the **separate `meta` object**, and `detail` carries the state
delta (`changed` keys + `from` / `to` sub-state snapshots).

```json
{
  "time": "2026-05-02T13:09:42Z",
  "service": "ship-control-panel",
  "event": "security",
  "meta": {
    "client": "203.0.113.42",
    "userAgent": "Mozilla/5.0 (...) Firefox/124.0"
  },
  "detail": {
    "changed": ["camerasEnabled"],
    "from": {"camerasEnabled": true},
    "to":   {"camerasEnabled": false},
    "severity": "warn"
  }
}
```

### Source-IP extraction — the rule that matters

| Event family | Path |
|--------------|------|
| `auth.login.success` / `auth.login.failure` / `auth.logout` | `j.detail.client` |
| Everything else (state events) | `j.meta.client` |

A query that wants the source IP for ANY event regardless of family
should `coalesce` both:

```kusto
| extend clientIp = tostring(coalesce(j.detail.client, j.meta.client))
```

This is the form to default to in any general-purpose KQL.

## Complete event catalogue

Authoritative — derived directly from the source. Anything not in
this table is not emitted by the SCP, full stop.

### Auth events (Shape A — `client`/`userAgent` in `detail`)

| `event` | When emitted | `detail.*` fields |
|---------|--------------|-------------------|
| `auth.login.success` | Username + password matched the demo creds (`administrator` / current password). Server action sets the auth cookie and redirects to `/`. | `username`, `client`, `userAgent` |
| `auth.login.failure` | Username + password did not match. Server action clears any auth cookie and redirects to `/login?error=1`. | `username`, `client`, `userAgent` |
| `auth.logout` | User explicitly clicked sign-out. Cookie cleared, redirect to `/login`. | `client`, `userAgent` (no `username` — the cookie carried no identity by design) |

### State events (Shape B — `client`/`userAgent` in `meta`)

All emitted from the `POST /api/state` action handler unless
otherwise noted. Each carries `detail.changed` (array of changed
sub-keys), `detail.from` (sub-state before), `detail.to` (sub-state
after).

| `event` | Triggered by UI action | What changes (sub-state shape `from` / `to`) |
|---------|------------------------|---------------------------------------------|
| `state.changed` | `PATCH /api/state` (bulk update; rarely used by the UI). | `detail.version` (new version), `detail.keys` (top-level keys touched). NO `from` / `to`. |
| `anchor` | Anchor tab buttons / chain payout slider. | `state` ∈ {`HOME`, `PAYING_OUT`, `HOLDING`, `DRAGGING`}, `chainPct` (0–100) |
| `connectivity` | Connectivity tab uplink toggle. **Signal drift is filtered out** — only enable/disable changes log. | `enabled` (bool). |
| `collision` | Collision-detection toggle (Navigation tab). | `enabled` (bool). |
| `security` | Security tab "Disable cameras" toggle. **Adds a `detail.severity` field**: `"warn"` when cameras go OFF, `"info"` when they come back ON. | `camerasEnabled` (bool). |
| `navigation.throttle` | Throttle telegraph (Navigation tab). | `throttle` (0–100). The full `from`/`to` carry the whole `navigation` sub-state, including the destination — but `changed` only lists `throttle`. |
| `navigation.destination` | Destination drag on the chart (Navigation tab). | `destination.lng`, `destination.lat`. |
| `entertainment` | Any change in the Entertainment tab. | One or more of: `scene` (`SUNSET_DECK`/`AURORA`/`DEEP_SEA`), `poolTempC`, `poolJets`, `poolLights` (`OFF`/`AMBIENT`/`PARTY`), `saunaTempC`, `steamHumidityPct`, `gymBoost`, `zone` (`LOUNGE`/`BALLROOM`/`CABINS`), `playing`, `volume` (0–100), `trackId`, `progress` (0–1), `scheduleNotify` (per-row map). |
| `stabilizers` | Stabilizers panel mode change or manual fin slider. **Auto-mode fin drift is filtered out** — only user-driven changes (mode, seaState, manual fin moves) log. | `mode` ∈ {`OFF`, `STANDBY`, `AUTO`, `MANUAL`}, `seaState` (0–6), `finPortDeg` / `finStbdDeg` (-25..25). |
| `climate` | Per-room AC change (Climate tab). | `detail.room` is the room name (`Bridge` / `Engine room` / `Cabins` / `Ballroom` / `Dining room`). `from`/`to` carry the room sub-state: `enabled`, `targetC`, `fan` (`AUTO`/`LOW`/`MED`/`HIGH`). |

### Severity field on `security` events

The Security tab has one toggle: enable/disable cameras. The event
emits with `detail.severity` set explicitly:

- `severity: "warn"` when `to.camerasEnabled === false` — the
  textbook attacker-tradecraft signal, surfaced for Sentinel rules
  to filter on.
- `severity: "info"` when cameras come back on.

This is the only event family that adds `severity`; all others
omit the field.

## Canonical KQL by question

### "All failed logins for a user, last 2 hours"

```kusto
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(2h)
| where Stream_s == "stdout"
| extend j = parse_json(Log_s)
| where j.service == "ship-control-panel"
| extend event    = tostring(j.event),
         username = tostring(j.detail.username),
         clientIp = tostring(j.detail.client),
         ua       = tostring(j.detail.userAgent)
| where event == "auth.login.failure"
| project TimeGenerated, username, clientIp, ua
| order by TimeGenerated desc
```

### "Failed-login summary by user + IP, last hour"

```kusto
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(1h)
| where Stream_s == "stdout"
| extend j = parse_json(Log_s)
| where j.service == "ship-control-panel"
| extend event    = tostring(j.event),
         username = tostring(j.detail.username),
         clientIp = tostring(j.detail.client)
| where event == "auth.login.failure"
| summarize failures   = count(),
            first_seen = min(TimeGenerated),
            last_seen  = max(TimeGenerated)
    by username, clientIp
| order by failures desc
```

### "Did cameras go off in the last 30 minutes?"

```kusto
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(30m)
| where Stream_s == "stdout"
| extend j = parse_json(Log_s)
| where j.service == "ship-control-panel"
| where tostring(j.event) == "security"
| where tostring(j.detail.severity) == "warn"
| extend clientIp = tostring(j.meta.client)   // Shape B!
| project TimeGenerated, clientIp,
          to_camerasEnabled = tobool(j.detail.to.camerasEnabled)
```

### "Any state change from a given IP, last 30 minutes" (mixed shapes)

```kusto
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(30m)
| where Stream_s == "stdout"
| extend j = parse_json(Log_s)
| where j.service == "ship-control-panel"
// Coalesce both shapes — auth events keep client in detail; state
// events keep it in meta.
| extend clientIp = tostring(coalesce(j.detail.client, j.meta.client)),
         event    = tostring(j.event)
| where clientIp == "<ip>"
| project TimeGenerated, event, clientIp
| order by TimeGenerated asc
```

### "What did the user do post-login from this IP?"

Pivot on time + clientIp from the `auth.login.success` to the
state-changing events that followed:

```kusto
let burstStart = datetime("<success-event-time>");
let ip = "<source-ip>";
ContainerAppConsoleLogs_CL
| where TimeGenerated between (burstStart .. (burstStart + 15m))
| where Stream_s == "stdout"
| extend j = parse_json(Log_s)
| where j.service == "ship-control-panel"
| extend event    = tostring(j.event),
         clientIp = tostring(coalesce(j.detail.client, j.meta.client))
| where clientIp == ip
| project TimeGenerated, event, detail = j.detail
| order by TimeGenerated asc
```

## Time-window guidance

The investigator's default window is `ago(60m)`. That's fine for a
live alert that just fired; it's **too narrow** for an incident that
sat in Sentinel's queue for tens of minutes before auto-pickup ran.

- **Always anchor to `INCIDENT_REF` when present.** The orchestrator
  passes the incident JSON in your prompt — `properties.firstActivityTime`
  and `properties.lastActivityTime` give you the actual evidence
  window. Use that, not wall-clock-now:

  ```kusto
  let t0 = todatetime("<firstActivityTime>") - 5m;
  let t1 = todatetime("<lastActivityTime>")  + 5m;
  ContainerAppConsoleLogs_CL
  | where TimeGenerated between (t0 .. t1)
  | ...
  ```

- **`ago(60m)` only as a last-resort fallback** — when an
  interactive operator triggered a run with no incident attached.

- **`ago(24h)` for retro investigations** — when the human is
  asking "did this happen at all today?".

## When the table looks empty

If the base filter (`Stream_s == "stdout"` + `j.service ==
"ship-control-panel"`) returns zero rows for a window where you'd
expect events, walk this ladder in order — drop one filter at a
time until you see rows, then you've found the culprit:

1. **Drop the time window** first. Try `ago(24h)` — confirms
   whether the ingestion is alive at all and just events haven't
   reached the narrow window you tried.

2. **Drop the `j.service` filter:**
   ```kusto
   ContainerAppConsoleLogs_CL
   | where TimeGenerated > ago(15m)
   | where Stream_s == "stdout"
   | extend j = parse_json(Log_s)
   | summarize count() by service = tostring(j.service)
   ```
   Confirms what `service` values are actually present. If the SCP
   was deployed under a different service string, the filter is
   why you're seeing nothing.

3. **Drop the `Stream_s` filter:**
   ```kusto
   ContainerAppConsoleLogs_CL
   | where TimeGenerated > ago(15m)
   | summarize count() by ContainerName_s, Stream_s
   ```
   Confirms which streams are producing logs. If only stderr is
   producing rows, the SCP isn't running cleanly — read the
   stderr text to see why.

4. **Drop `parse_json` and look at raw `Log_s`:**
   ```kusto
   ContainerAppConsoleLogs_CL
   | where TimeGenerated > ago(15m)
   | where ContainerName_s contains "ship-control-panel"
   | project TimeGenerated, Stream_s, Log_s
   | take 5
   ```
   Confirms log lines are reaching the workspace at all, and shows
   their literal shape so you can adapt the parsing.

If step 4 returns nothing, the Container App's diagnostic settings
aren't pointed at the workspace — escalate to the operator; not a
SOC fix.

## Editing this page

This file is part of the `company-context` corpus. To change it:

1. Edit `terraform/2-deploy-aisoc/agents/company-context/11-ship-control-panel-logging.md`.
2. Run `./upload_company_context.sh` from that folder to push it
   to blob.
3. Wait up to 30 min for the indexer (or force a manual run via
   `az search indexer run`).
