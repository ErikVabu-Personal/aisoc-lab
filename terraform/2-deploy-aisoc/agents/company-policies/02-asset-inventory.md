# IT asset inventory — corporate estate

**Owner:** Group IT, Brussels HQ
**Last reviewed:** 2026-09-28
**Audience:** SOC, NOC, IT staff.

This page captures the monitored **corporate estate** at a level of
detail useful for SOC triage. The full CMDB lives in ServiceNow at
the IT SharePoint; this is the working copy synced nightly so the
AISOC agents have an offline-readable reference.

## Application inventory

| Asset | Tier | Owner | Notes |
|-------|------|-------|-------|
| Maison Miró (web store) | T0 | Group IT | Public-facing e-commerce site; **the web victim, monitored by AISOC**. Emits `[EVENT]` lines to `ContainerAppConsoleLogs_CL` (`ContainerName_s == "maison-miro"`). Has a built-in auto-SOAR (`/soc/*`). |
| Azure Monitor Agent + Sysmon | T1 | Group IT | Telemetry pipeline on every GOAD host → Sentinel. Heartbeats + forwarded events are normal background. |

## Endpoint inventory — GOAD Active Directory estate

All hosts run the Azure Monitor Agent + Sysmon; audit events flow to
`SecurityEvent`, Sysmon / Application / System to `Event`.
**Monitored by AISOC.**

| Hostname | Tier | Role | Domain |
|----------|------|------|--------|
| `dc01` | T0 | Domain controller | `sevenkingdoms.local` |
| `dc02` | T0 | Domain controller | `north.sevenkingdoms.local` |
| `dc03` | T0 | Domain controller | `essos.local` (separate forest) |
| `srv02` | T1 | Member server (SQL / web) | `north.sevenkingdoms.local` |
| `srv03` | T1 | Member server (IIS / web) | `sevenkingdoms.local` |

(Host names can differ per deployment — verify against the live
estate; the roles don't change. Full estate detail in
`12-goad-ad-attacks.md`.)

**Tier definitions (Group IT standard):**
- **T0** — crown-jewel / identity-critical system: a domain
  controller, or the customer data behind the store. Loss = domain
  or customer-data compromise. No experimental changes.
- **T1** — operational support. Loss = degraded operations,
  recoverable in <1h.
- **T2** — back-office / convenience. No immediate operational impact.

## Network

| Segment | Purpose | Access |
|---------|---------|--------|
| GOAD domain network | The AD domains (`dc0x`, `srv0x`) + the jumpbox that fronts them | Domain admins + SOC, via the jumpbox |
| Web tier | Maison Miró Container App (public ingress) | Public — it is the internet-facing victim |

Any cross-segment traffic on a non-approved port is logged and
alert-worthy.

## Identity providers

- **GOAD Active Directory** — three domains across two forests with
  a deliberately-misconfigured trust (this is a training range).
  Naming conventions in `03-account-naming.md`; attack-relevant
  principals in `12-goad-ad-attacks.md`.
- **Maison Miró** — the store has its own application-level auth. It
  is intentionally vulnerable (SQL-injection login, forgeable
  session cookie), so a "username" seen in a Maison event is
  attacker-controlled input — attribute activity by `source_ip`, not
  by the name in the log.

## How the SOC uses this inventory

When triaging an alert that mentions a specific host or account,
agents reference this page to confirm:

1. The host / account is **expected to exist** (it's in the
   inventory).
2. Its **tier** (drives severity escalation — T0 incidents jump
   straight to L3).
3. Its **expected behaviour** (is interactive login expected? what
   should it touch?).

Anything not in this inventory acting on the estate is treated as
unauthorised until proven otherwise.
