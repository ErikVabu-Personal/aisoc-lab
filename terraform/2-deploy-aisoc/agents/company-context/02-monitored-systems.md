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
2. The **corporate Active Directory estate (GOAD)** — the
   Windows domains behind the business: domain controllers
   `dc01` / `dc02` / `dc03` and member servers `srv02` / `srv03`,
   all with the Azure Monitor Agent + Sysmon installed. Their
   audit telemetry flows into `SecurityEvent` and their Sysmon /
   Application / System logs into `Event`. This is where both
   host-level activity (logons, process creation, network
   connections) and identity attacks (Kerberoasting, DCSync,
   password spray, AS-REP roasting) show up. The Windows event
   schema, base filters, and Sysmon pivot patterns are in
   **`09-endpoint-telemetry.md`**; the AD-attack EID reference,
   detection logic, and runbooks are in **`12-goad-ad-attacks.md`**.

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
