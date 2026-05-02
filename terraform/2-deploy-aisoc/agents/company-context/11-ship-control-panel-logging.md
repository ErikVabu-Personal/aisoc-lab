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

## Authoritative reference query (mirrors the live analytic rule)

The single most reliable way to find the events the SCP analytic
rule fired on is to run the rule's own query. The
`Control Panel: multiple failed logins (user + IP)` analytic rule
uses this exact pattern:

```kusto
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(15m)
| where Log_s has "auth.login.failure"
| extend j = parse_json(Log_s)
| where isnotnull(j)
| extend event    = tostring(j.event),
         username = tostring(j.detail.username),
         clientIp = tostring(j.detail.client),
         userAgent= tostring(j.detail.userAgent)
| where event == "auth.login.failure"
```

**This is the canonical investigation query.** The rule fires
when this returns rows, so by definition any incident from the
SCP rule has rows visible to it. If you run a variant of this
query in the alert's time window and get zero rows, your variant
has drifted from the rule — find the difference, don't conclude
"there's no data."

Note what this query does NOT do:

- **No `Stream_s == "stdout"` filter.** Container Apps log
  forwarding does populate `Stream_s`, but several configurations
  route Next.js server-action output to stderr (or leave the
  field nulled) and the filter then drops every auth event. The
  detection rule sidesteps this by not using the filter at all
  and relying on the `Log_s has "auth.login.failure"` substring
  pre-filter to be cheap enough.
- **No `j.service == "ship-control-panel"` filter.** The
  `Log_s has "auth.login.failure"` substring is already specific
  enough to the SCP — no other service emits that string.
  Filtering on `j.service` is fine for queries with a broader
  pre-filter (e.g. when you don't have a tight `Log_s has`
  match), but isn't load-bearing here.

## Generic base filter (for queries that DON'T have a specific
substring to pre-filter on)

When you're hunting for state events (anchor / connectivity /
security / climate / …) — none of which have a single substring
as distinctive as `auth.login.failure` — the safer base filter is
broader:

```kusto
ContainerAppConsoleLogs_CL
| where TimeGenerated > <bound>
| extend j = parse_json(Log_s)
| where isnotnull(j) and tostring(j.service) == "ship-control-panel"
```

This parses every log line in the window, then filters on the
parsed `service` field. More expensive than the auth pattern
(parses every row, including stderr) but not query-disqualifying;
the SCP volume is low.

**Avoid `Stream_s == "stdout"` as a base filter.** It's a
plausible-looking optimization but in practice the field's value
varies between Container App revisions and Next.js versions, and
the safe assumption is that filtering on it will silently drop
real data. The detection rule didn't use it for a reason — neither
should you.

## "Why is my query returning nothing when the alert fires?" — meta rule

If the SCP analytic rule has fired (an incident exists, status
"New" or "Active"), the rule's KQL DEFINITIVELY found rows in the
alert's evaluation window. So:

- Your investigation query in the same window must also return
  rows. If it doesn't, the difference between your query and the
  authoritative reference query above IS the bug.
- The most common drift is an extra filter you've added that the
  rule doesn't have. `Stream_s == "stdout"`, an `ago(60m)` window
  too narrow for a delayed auto-pickup, a `j.service` filter
  that's slightly miscased — any of these can zero-out a query
  that should be finding rows.
- Strip your query down to the authoritative reference above.
  Run it. If THAT returns rows, re-introduce your filters one at
  a time until you find the one that drops everything. That's
  your bug.

This is the single most valuable diagnostic move when the table
"looks empty." Don't conclude "no data" until you've reproduced
the rule's own query and confirmed it also returns nothing.

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

Mirrors the analytic rule's pattern (`Log_s has` pre-filter, no
`Stream_s` filter, `isnotnull(j)` guard):

```kusto
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(2h)
| where Log_s has "auth.login.failure"
| extend j = parse_json(Log_s)
| where isnotnull(j)
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
| where Log_s has "auth.login.failure"
| extend j = parse_json(Log_s)
| where isnotnull(j)
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

### "Did any logins succeed for that user/IP pair?"

When the investigator wants to know whether the brute-force ever
got in. Same `Log_s has` pre-filter pattern, broadened to capture
both outcomes:

```kusto
let u  = "<username>";
let ip = "<clientIp>";
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(2h)
| where Log_s has "auth.login."
| extend j = parse_json(Log_s)
| where isnotnull(j)
| extend event    = tostring(j.event),
         username = tostring(j.detail.username),
         clientIp = tostring(j.detail.client)
| where username == u and clientIp == ip
| where event in ("auth.login.success", "auth.login.failure")
| summarize count() by event
```

### "Did cameras go off in the last 30 minutes?"

State-event query — note `clientIp` is in `j.meta.client`, not
`j.detail.client` (Shape B; see "Two log shapes you'll
encounter" above):

```kusto
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(30m)
| where Log_s has "\"event\":\"security\""
| extend j = parse_json(Log_s)
| where isnotnull(j)
| where tostring(j.event) == "security"
| where tostring(j.detail.severity) == "warn"
| extend clientIp = tostring(j.meta.client)
| project TimeGenerated, clientIp,
          to_camerasEnabled = tobool(j.detail.to.camerasEnabled)
```

### "Any state change from a given IP, last 30 minutes" (mixed shapes)

For broader queries that span both auth and state events, drop
the `Log_s has` substring pre-filter and use the generic base
filter — pay the cost of parsing every row:

```kusto
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(30m)
| extend j = parse_json(Log_s)
| where isnotnull(j) and tostring(j.service) == "ship-control-panel"
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
| extend j = parse_json(Log_s)
| where isnotnull(j) and tostring(j.service) == "ship-control-panel"
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

If your query returns zero rows for a window where the analytic
rule has fired (or you have other reason to expect events), walk
this ladder. **Order matters** — drop filters one at a time,
starting with the one most likely to be wrong.

1. **Drop `Stream_s` first.** This is the #1 cause of "agent
   queries return nothing while the rule fires." Run:
   ```kusto
   ContainerAppConsoleLogs_CL
   | where TimeGenerated > ago(15m)
   | summarize count() by Stream_s
   ```
   If you see rows under `Stream_s == ""` (empty) or
   `Stream_s == "stderr"` and not under `Stream_s == "stdout"`,
   that's exactly the gotcha. **Drop the Stream_s filter from
   your query and re-run.** Several Next.js / Container Apps
   combinations route server-action `console.log` output to
   stderr, or leave the field nulled — the live analytic rule
   sidesteps this by not filtering on `Stream_s` at all.

2. **Drop the time window.** Try `ago(24h)`. Confirms whether
   the ingestion is alive at all and just events haven't reached
   the narrow window you tried.

3. **Drop the `j.service` filter:**
   ```kusto
   ContainerAppConsoleLogs_CL
   | where TimeGenerated > ago(15m)
   | extend j = parse_json(Log_s)
   | summarize count() by service = tostring(j.service)
   ```
   Confirms what `service` values are actually present. If the
   SCP was deployed under a different service string, the filter
   is why you're seeing nothing.

4. **Run the authoritative reference query** (the auth-failure
   one at the top of this page) verbatim. If THAT returns rows,
   diff it against your query field-by-field — your extra
   filter is your bug.

5. **Drop `parse_json` and look at raw `Log_s`:**
   ```kusto
   ContainerAppConsoleLogs_CL
   | where TimeGenerated > ago(15m)
   | where ContainerName_s contains "ship-control-panel"
   | project TimeGenerated, Stream_s, Log_s
   | take 5
   ```
   Confirms log lines are reaching the workspace at all, and shows
   their literal shape so you can adapt the parsing.

If step 5 returns nothing, the Container App's diagnostic settings
aren't pointed at the workspace — escalate to the operator; not a
SOC fix.

## Editing this page

This file is part of the `company-context` corpus. To change it:

1. Edit `terraform/2-deploy-aisoc/agents/company-context/11-ship-control-panel-logging.md`.
2. Run `./upload_company_context.sh` from that folder to push it
   to blob.
3. Wait up to 30 min for the indexer (or force a manual run via
   `az search indexer run`).
