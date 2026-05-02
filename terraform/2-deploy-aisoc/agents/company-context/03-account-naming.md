# Account naming conventions

The Ship Control Panel uses a single auth realm. Account names follow
these conventions — useful when triaging an alert against a username
without other context.

## Shared bridge operational account

**`administrator`** is the bridge's shared operational account on
the SCP. Every officer on watch — captain, staff captain, watch
officers — signs into the panel under this single username. The
SCP itself was built before the realm migration, and per-person
SCP logins were out of scope at the time. As a result, the
**SCP username on its own does NOT identify the human at the
keyboard**.

To attribute an SCP event to a specific person, the SOC has to
cross-reference the source IP (`detail.client` field) against the
asset inventory (workstation-IP map in the `company-policies` KB)
and the Windows authentication logs on that workstation
(`Event` table, Source = `Security`, EID 4624). The
"Captain-on-`BRIDGE-WS` pattern" in `10-org-chart.md` walks the
canonical example end-to-end.

## Prefixes (per-person SCP accounts, where they exist)

| Prefix      | Meaning                          | Example          | Notes |
|-------------|----------------------------------|------------------|-------|
| `crew_`     | Crew (non-bridge, interactive)   | `crew_lindgren`  | Hospitality. |
| `eng_`      | Engineering crew (interactive)   | `eng_yusuf`      | Engineering officers; flagged separately because they have engine-room privileges. |
| `svc_`      | **Service account** (automation) | `svc_telemetry`  | Should never have an interactive login. Any `auth.login.*` event for a `svc_*` account from a non-allow-listed IP is **alert-worthy**. |
| `admin_`    | Admin / IT (rare)                | `admin_lkr`      | Any login is logged AND reviewed. |
| `vendor_`   | External vendor (scheduled)      | `vendor_starl`   | Vendor accounts; only legitimate during scheduled maintenance windows. |

## Service-account inventory (don't expect interactive logins)

- `svc_telemetry`        — pushes telemetry to Brussels
- `svc_health`           — runs the health-check probe
- `svc_indexer`          — feeds the search index
- `svc_admin`            — **legacy** service account; deprecated but
                            still around. Any login attempt is
                            suspicious by default.
- `svc_backup`           — nightly backup uploads

## VIP / sensitive accounts

These accounts get extra-careful triage. A failed-login burst against
any of them should escalate to L2 immediately, not stay at L1.

- **`administrator`** (SCP) — the shared bridge operational account
  (see top of this page). Failed-login bursts AGAINST `administrator`
  are common-but-noisy; the verdict turns on the **source IP** of
  the burst, not on the username. See "Captain-on-`BRIDGE-WS`
  pattern" in `10-org-chart.md` for the canonical IP-driven
  attribution chain.
- `admin_lkr` — IT admin at HQ, reaches every vessel.
- `svc_admin` — the legacy service account. Any login is suspicious;
  a successful one is a near-certain compromise indicator.

## Cross-system identity mappings

A single person often appears under different account names across
the systems we monitor. The org-chart page (`10-org-chart.md`) is
the authoritative roster; this is the cheat sheet most relevant for
triage.

| Person | SCP (shared) | Workstation (Windows) | Workstation host |
|--------|--------------|------------------------|------------------|
| Jack Sparrow (Captain) | `administrator` (the shared bridge account) | `jack.sparrow` | `BRIDGE-WS` |

`jack.sparrow` is the **only** account that legitimately signs in
interactively on `BRIDGE-WS`. The corollary is the high-signal
pattern documented in the runbook + org-chart pages: **failed-login
bursts on the SCP for `administrator` that originate from
`BRIDGE-WS`'s public IP while `jack.sparrow` has an active Windows
session on that host are usually the captain mistyping** — verify
the IP-and-Windows-session correlation before flagging as malicious.

## What to do with an unknown account

Treat any account that is NOT `administrator` and does not match
one of the documented prefixes (`crew_`, `eng_`, `svc_`, `admin_`,
`vendor_`) as untrusted until an analyst can verify it. Examples
seen in past incidents that turned out to be attackers: `root`,
`sa`, `test`, `user1`. Any login attempt against those is hostile.
