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
pivot on the source IP recorded on the SCP event (`detail.client`),
check whether endpoint telemetry maps that IP to a managed host
(Sysmon EID 3 outbound to the SCP), and check who was interactively
signed in there at the time (Security 4624). The "Source-IP triage"
step in `04-runbook-credential-stuffing.md` is the canonical
procedure; the KB then provides role / identity context for the
host and user names that emerge.

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
  the burst, not on the username. The Source-IP triage step in
  `04-runbook-credential-stuffing.md` is the canonical procedure.
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
interactively on `BRIDGE-WS`. Combined with the SCP shared-account
note at the top of this page, the implication for any
investigation is generic: an SCP `administrator` event by itself
identifies neither the human nor the source machine. The standard
pivot is data-driven — find the source IP in the SCP event, check
whether endpoint telemetry maps it to a managed host (Sysmon EID 3
to the SCP), and check who was interactively signed in there
(Security 4624). The KB then attaches role / identity meaning to
those names; the "Source-IP triage" step in
`04-runbook-credential-stuffing.md` walks the procedure.

## What to do with an unknown account

Treat any account that is NOT `administrator` and does not match
one of the documented prefixes (`crew_`, `eng_`, `svc_`, `admin_`,
`vendor_`) as untrusted until an analyst can verify it. Examples
seen in past incidents that turned out to be attackers: `root`,
`sa`, `test`, `user1`. Any login attempt against those is hostile.
