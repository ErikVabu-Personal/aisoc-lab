# IT asset inventory — operations network

**Owner:** Group IT, Brussels HQ
**Last reviewed:** 2026-04-22
**Audience:** SOC, NOC, vessel IT staff.

This page captures the **operations-network** asset inventory at a
level of detail useful for SOC triage. The full CMDB lives in
ServiceNow at the IT SharePoint; this is the working copy synced
nightly so the AISOC agents have an offline-readable reference.

## Application inventory (vessel-side)

| Asset                          | Tier | Owner          | Notes                                |
|--------------------------------|------|----------------|--------------------------------------|
| Ship Control Panel             | T0   | Vessel IT      | The bridge & operations surface; **monitored by AISOC**. |
| HealthCheck probe              | T1   | Group IT       | Every 5 min synthetic login as `svc_health`. |
| NVISO Telemetry agent          | T1   | Group IT       | Logs forwarder. Authenticates as `svc_telemetry`. |
| NVISO Indexer                  | T1   | Group IT       | Search indexer. Authenticates as `svc_indexer`. |
| Maintenance agent              | T2   | Group IT       | Pull-only firmware updates. Runs under `svc_backup`. |

**Tier definitions (Group IT standard):**
- **T0** — safety-of-life or revenue-of-voyage system. Loss = ship
  cannot sail safely. No experimental changes.
- **T1** — operational support. Loss = degraded operations.
  Recoverable in <1h.
- **T2** — back-office / convenience. Loss = inconvenient. No
  immediate operational impact.

## Network segments (vessel-side)

| Segment              | Purpose                              | Access           |
|----------------------|--------------------------------------|------------------|
| `OPS-NET`            | Ship Control Panel + bridge systems  | Bridge officers + engineers |
| `MAINT-NET`          | Vendor maintenance VLAN              | Vendor accounts only, scheduled |
| `CREW-NET`           | Crew WiFi (off-duty personal use)    | All crew         |
| `GUEST-NET`          | Passenger WiFi                       | Passengers       |

Segments are firewalled from each other. Any cross-segment traffic
on a non-approved port is logged and alert-worthy.

## Identity providers

The Ship Control Panel uses a **vessel-local realm** for now (single
auth realm, see 03-account-naming.md in the company-context corpus
for naming conventions). Group IT plans a migration to Entra ID for
2026 H2; tracked in change ticket `CR-2026-0414`.

Until that migration lands:

- Service accounts (`svc_*`) are managed by Group IT and rotated
  quarterly. The rotation procedure is documented in the IT
  SharePoint runbook `IT-RB-014`.
- The `svc_admin` legacy account is **decommissioned** but still
  exists in the realm because the realm doesn't support hard
  deletion until the Entra ID migration. Any login attempt against
  `svc_admin` is automatic alarm (see 03-account-naming.md).

## How the SOC uses this inventory

When triaging an alert that mentions a specific service account or
host, agents reference this page to confirm:

1. The account/host is **expected to exist** (it's in the
   inventory).
2. Its **owner** (who to contact for clarification).
3. Its **tier** (drives severity escalation — T0 incidents jump
   straight to L3).
4. Its **expected behaviour** (is interactive login expected for
   this account? what segments should it touch?).

Anything not in this inventory connecting to OPS-NET is treated as
unauthorised until proven otherwise.
