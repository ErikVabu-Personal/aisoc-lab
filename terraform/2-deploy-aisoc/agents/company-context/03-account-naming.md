# Account naming conventions

The Ship Control Panel uses a single auth realm. Account names follow
these conventions — useful when triaging an alert against a username
without other context.

## Prefixes

| Prefix      | Meaning                          | Example          | Notes |
|-------------|----------------------------------|------------------|-------|
| `bo_`       | Bridge officer (interactive)     | `bo_eikholt`     | Interactive logins only; never automation. |
| `crew_`     | Crew (non-bridge, interactive)   | `crew_lindgren`  | Hospitality, engineering, etc. |
| `eng_`      | Engineering crew (interactive)   | `eng_yusuf`      | Subset of `crew_`; flagged separately because they have engine-room privileges. |
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

- `bo_captain` — vessel master; the highest-privilege bridge account.
  **Currently held by Jack Sparrow** (see `10-org-chart.md`). His
  personal Windows account on the lab VM is `jack.sparrow` —
  cross-reference when the source IP of a Ship Control Panel
  login is the lab VM's public IP.
- `bo_staff_captain` — second-in-command; full bridge privileges.
- `admin_lkr` — IT admin at HQ, reaches every vessel.
- `svc_admin` — the legacy service account. Any login is suspicious;
  a successful one is a near-certain compromise indicator.

## Cross-system identity mappings

A single person often appears under different account names across
the systems we monitor. The org-chart page (`10-org-chart.md`) is
the authoritative roster; this is the cheat sheet most relevant for
triage.

| Person | Ship Control Panel | Lab VM (Windows) |
|--------|---------------------|-------------------|
| Jack Sparrow (Captain) | `bo_captain` | `jack.sparrow` |

The captain is the **only** person who legitimately logs into the
lab VM. Any successful Windows login as `jack.sparrow` is the
captain. The corollary is the high-signal pattern documented in
the runbook + org-chart pages: **failed-login bursts on the Ship
Control Panel that originate from the lab VM's IP while Jack is
signed into Windows are usually him mistyping** — verify the
session correlation before flagging as malicious.

## What to do with an unknown prefix

Treat the account as untrusted until an analyst can verify it.
Examples seen in past incidents that turned out to be attackers:
`administrator`, `root`, `sa`, `test`, `user1`. None of these match
NVISO conventions and any login attempt against them is hostile.
