# Monitored systems

The following assets are in scope for AISOC monitoring:

1. **Maison Miró** — the public-facing web store (the corporate e-commerce
   site). The web victim. Runs as an Azure Container App; its structured
   `[EVENT] {json}` log lines flow into Sentinel via the
   `ContainerAppConsoleLogs_CL` table (`ContainerName_s == "maison-miro"`).
   This is where web attacks (SQL-injection login, auth bypass, forged
   session, IDOR, bulk PII exfiltration, checkout fraud, stored XSS) show
   up. The full logging schema, event catalogue, and attack runbook are in
   **`13-maison-logging.md`**.
2. **`BRIDGE-WS`** — the **bridge workstation**, a Windows 11
   host with the Azure Monitor Agent and Sysmon installed.
   Physically on the bridge of M/S Aegir; the captain
   (Jack Sparrow) is its only interactive user. Endpoint
   telemetry (Application / System / Security event logs +
   Sysmon) flows into the `Event` table where it appears as
   `Computer == "BRIDGE-WS"`. See `09-endpoint-telemetry.md`
   for the schema, base filters, and pivot patterns; the
   captain ↔ host pairing is in `10-org-chart.md`.
3. The **corporate Active Directory estate (GOAD)** — the
   shore-side Windows domains behind the fleet: domain
   controllers `dc01` / `dc02` / `dc03` and member servers
   `srv02` / `srv03`, all with the Azure Monitor Agent + Sysmon.
   Their audit + Sysmon telemetry flows into `SecurityEvent`
   and `Event`. This is where identity attacks (Kerberoasting,
   DCSync, password spray, AS-REP roasting) show up. The EID
   reference, detection logic, and AD runbooks are in
   **`12-goad-ad-attacks.md`**.

## Maison Miró — the store

Maison Miró is an intentionally-vulnerable storefront. Every security-relevant
action emits one `[EVENT] {json}` line to stdout with a dotted `type`, a
`severity` (`info`→`critical`), the client `source_ip` (the incident
correlation key), and a `message`. It also has a **built-in SOC** (`/soc/*`,
auto-SOAR): when armed, a `critical` event auto-triggers containment.

Key event families (full catalogue in `13-maison-logging.md`):

- **Recon** — `recon.disallowed_path` (low): scanning `/api*`, `/admin`,
  `/invoice*`. The precursor.
- **Break-in** (high) — `auth.sqli_attempt`, `auth.login_bypass` (SQL-injection
  auth bypass), `auth.session_forged` (forged privilege cookie),
  `xss.stored_attempt`.
- **Impact** (critical) — `data.exfil_attempt` (bulk PII pull),
  `data.honeytoken_touched` (the decoy record was read — **zero false
  positives**), `data.idor_access` (someone else's order/invoice),
  `fraud.price_mismatch` (checkout tampering).
- **Response** (info) — `containment.engaged` / `containment.blocked`: the
  built-in auto-SOAR contained a source. These are the "response worked" signals.

### What "normal" looks like
- Browsing / product views / successful logins for real customers.
- No `high`/`critical` events; occasional low-severity noise.

### What "abnormal" looks like
- Any `critical` event (`data.*`, `fraud.price_mismatch`) — theft or fraud.
  `data.honeytoken_touched` is definitive: no legitimate flow reads it.
- A `high` break-in event (`auth.login_bypass` / `auth.session_forged`)
  followed by a `critical` from the **same `source_ip`** — the full kill chain.
- A burst of `recon.disallowed_path` from one IP — enumeration before a break-in.
