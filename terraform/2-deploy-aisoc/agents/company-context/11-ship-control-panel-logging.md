# Ship Control Panel — logging schema (canonical reference)

The agents query the SCP's logs through the `ContainerAppConsoleLogs_CL`
table in Sentinel. Every state-changing API call on the SCP emits a
single JSON line on stdout; AMA forwards it to Log Analytics, which
parses it into the table below. This page is the canonical schema
reference — when in doubt, **retrieve this page first** before
guessing field names.

## Table + base filter

```kusto
ContainerAppConsoleLogs_CL
| where Stream_s == "stdout"
| extend j = parse_json(Log_s)
| where j.service == "ship-control-panel"
```

`j` then exposes the structured event. From here you `extend` the
specific fields you care about (`event`, `detail.username`,
`detail.client`, etc.).

### Why `Stream_s == "stdout"`

The Container App's stderr also forwards into the same table but
carries non-JSON noise (Node startup banners, warnings). Filtering
to stdout is what keeps `parse_json(Log_s)` reliable.

### Why `j.service == "ship-control-panel"`

The Container App environment hosts more than one app over time;
the `service` field disambiguates SCP events from any future
neighbour.

## Field reference

Every SCP log line has this top-level shape:

| Field | Type | Meaning |
|-------|------|---------|
| `time` | ISO 8601 | Wall-clock at the SCP (use `TimeGenerated` for KQL — it's the AMA-stamped ingestion time and easier to filter on). |
| `service` | `"ship-control-panel"` | Always this string for SCP events. |
| `event` | string | The event name. See the catalogue below. |
| `detail` | object | Event-specific payload. Per-event shape below. |
| `meta` | object | Optional. Carries `client` (source IP), `userAgent` when relevant. |

## Event catalogue

| `event` value | What it represents | Key `detail.*` fields |
|---------------|--------------------|------------------------|
| `auth.login.success` | A user signed in successfully. | `username`, `client` (source IP), `userAgent` |
| `auth.login.failure` | A user attempted to sign in and failed. | `username`, `client`, `userAgent` |
| `auth.logout` | A user explicitly signed out. | `username`, `client` |
| `navigation.throttle` | Throttle telegraph moved. | `from`, `to` (numeric, 0–100) |
| `navigation.destination` | Destination dragged on chart. | `from`, `to` (lat/lon) |
| `anchor` | Anchor state transition. | `from`, `to` (`HOME` / `PAYING_OUT` / `HOLDING` / `DRAGGING`) |
| `stabilizers` | Stabilizer state / fin angle change. | `mode` (`OFF`/`STANDBY`/`AUTO`/`MANUAL`), `port_angle`, `starboard_angle` |
| `connectivity` | Starlink uplink toggle. | `enabled` (bool) |
| `climate` | Per-room AC change. | `room`, `setpoint_c`, `mode` |
| `entertainment` | Pool / sauna / lighting / music. | `subsystem`, `scene`, `volume` |
| `security` | Camera / surveillance state change. | `severity` (`info` / `warn`), `changed` (array), `from`, `to` |
| `collision` | Collision-detection toggle. | `enabled` (bool) |

## Where the source IP lives

The `client` field — accessible as `j.detail.client` — is the **source
IP** the SCP received on the inbound HTTP request. This is the canonical
field for source-IP triage (see the credential-stuffing runbook,
`04-runbook-credential-stuffing.md`).

For events triggered server-side (HealthCheck synthetic logins, etc.)
`client` may be the loopback/internal IP of the probe. Cross-reference
the `username` against the service-account inventory in
`02-asset-inventory.md` (in the `company-policies` KB) to recognise
synthetic traffic.

## Sample log line — failed login

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

After base-filtering, you'd extract those fields like this:

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

## Time-window guidance

The investigator's default is `ago(60m)`, which is fine for live
incidents but **too narrow** for incidents created an hour or more
before the agent runs. Start broader if you're not finding events
the alert claims to have triggered on:

- `ago(2h)` is a safer default for incidents that arrived via
  auto-pickup with any delay between incident creation and the
  workflow run.
- `ago(24h)` for any incident where you don't immediately spot
  the event the alert was based on. The alert's `firstActivityTime`
  / `lastActivityTime` (in `INCIDENT_REF`) is your authoritative
  bracket — the agent should run KQL anchored to that window
  rather than to wall-clock-now.

## When the table looks empty

If the base filter (`Stream_s == "stdout"` + `j.service == "ship-control-panel"`)
returns zero rows for a window where you'd expect events:

1. Drop the `Stream_s` filter and check what's there:
   ```kusto
   ContainerAppConsoleLogs_CL
   | where TimeGenerated > ago(15m)
   | summarize count() by ContainerName_s, Stream_s
   ```
   Confirms the SCP container is producing logs.

2. Drop the `j.service` filter:
   ```kusto
   ContainerAppConsoleLogs_CL
   | where TimeGenerated > ago(15m)
   | where Stream_s == "stdout"
   | extend j = parse_json(Log_s)
   | summarize count() by service = tostring(j.service)
   ```
   Confirms the `service` field actually equals `"ship-control-panel"`
   (deploys with a renamed service would show a different value here).

3. Drop the `parse_json` and look at raw `Log_s`:
   ```kusto
   ContainerAppConsoleLogs_CL
   | where TimeGenerated > ago(15m)
   | where ContainerName_s contains "ship-control-panel"
   | project TimeGenerated, Stream_s, Log_s
   | take 5
   ```
   Confirms log lines are reaching the workspace at all, and shows
   their literal shape so you can adapt the parsing.

If step 3 returns nothing, the Container App's diagnostic settings
aren't pointed at the workspace — escalate to the operator; not a
SOC fix.

## Editing this page

This file is part of the `company-context` corpus. To change it:

1. Edit `terraform/2-deploy-aisoc/agents/company-context/11-ship-control-panel-logging.md`.
2. Run `./upload_company_context.sh` from that folder to push it
   to blob.
3. Wait up to 30 min for the indexer (or force a manual run via
   `az search indexer run`).
