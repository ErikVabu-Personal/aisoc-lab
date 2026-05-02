# Runbook — credential stuffing against the Ship Control Panel

**When to use:** the alert "Auth — Repeated login failures" (or similar)
shows ≥10 `auth.login.failure` events for the same username from the
same source IP within a 15-minute window.

## Investigator checklist

1. Confirm scope. Run the standard auth-failures KQL with a
   widened window (60 min); pivot by `username` and `clientIp`.
2. **Source-IP triage — is this an internal / managed source?**
   The burst's `clientIp` is a deployment-specific address; do
   NOT expect to find it pre-named in the KB. The KB carries org
   facts (people, roles, asset inventory), not network topology.
   Discover what the IP belongs to **from telemetry**, then look
   up identity context in the KB:

   a. **Are we receiving endpoint logs traceable to that IP?**
      Managed hosts log every outbound connection they make
      (Sysmon EID 3). If the SCP saw inbound from this IP, a
      managed host originating that traffic logged its own
      outbound at the same time — and the `Computer` field on
      those events names it.

      ```kusto
      Event
      | where TimeGenerated between (
          (datetime(<burst-start>) - 5m) ..
          (datetime(<burst-end>) + 5m))
      | where Source == "Microsoft-Windows-Sysmon" and EventID == 3
      | extend ed = parse_xml(EventData)
      | extend Data = ed.DataItem.EventData.Data
      | extend DestIp   = tostring(Data[14]["#text"])
      | extend DestPort = tostring(Data[16]["#text"])
      | where DestPort in ("80","443")
      | summarize n=count() by Computer, DestIp
      | order by n desc
      ```

      - **A `Computer` shows up** → burst comes from a managed
        internal workstation. Hold the host name and continue
        to (b).
      - **Result is empty** → no managed host was reaching the
        SCP during the burst window. Source is unmanaged / external.
        Skip (b)–(c) and continue with step 3 (success-correlation)
        and step 7 (Threat Intel).

   b. **Who was interactively signed in at that host during the
      burst?** Pivot on the discovered `Computer` against the
      `SecurityEvent` table — Windows audit events land there
      with proper columns (`AccountName`, `LogonType`,
      `IpAddress`, `WorkstationName` are first-class fields, not
      XML buried in `EventData`):

      ```kusto
      SecurityEvent
      | where Computer == "<host-from-step-2a>"
      | where TimeGenerated between (
          (datetime(<burst-start>) - 5m) ..
          (datetime(<burst-end>) + 5m))
      | where EventID == 4624
      | project TimeGenerated, AccountName, LogonType, IpAddress, WorkstationName
      ```

      A 4624 with `LogonType in (2, 10, 11)` (interactive,
      RemoteInteractive, CachedInteractive) for an account
      spanning the burst window means a human was physically (or
      RDP-)using that workstation while the SCP burst happened.

   c. **Contextualise the host and user names.** Retrieve the
      asset inventory (in the `company-policies` KB) for the
      `Computer` from (a), and the org chart (`10-org-chart.md`)
      for the `AccountName` from (b). Combine the role / owner
      meaning the KB returns with the timing evidence from (b):

        - If the workstation has a known primary user (per the
          KB), and that primary user is the same person who was
          interactively signed in during the burst, the most
          plausible explanation is that person mistyping the
          shared SCP password from their own workstation.
          Express that conclusion using the KB-supplied role
          and name in the case note even though the SCP log
          line carried only `administrator`.
        - If the workstation's primary user (or expected user
          set) does NOT match who was signed in, the burst
          becomes a compromised-workstation signal — escalate
          to L2 / L3 per the verdict mapping below.
3. Check whether **any** login succeeded for the same `username` /
   `clientIp` pair. A successful login during or right after the
   burst flips this from a brute-force attempt to a confirmed
   compromise — UNLESS step 2 already attributed the burst to a
   legitimate user mistyping at their own managed workstation, in
   which case a successful login is just that user finally
   typing it correctly.
4. Geolocate `clientIp`. Cross-check against the user's typical
   location. NVISO Cruiseways crew and bridge officers should not
   be logging in from countries outside the voyage's port-call
   list.
5. If the user is a **service account** (`svc_*`), it should have no
   interactive logins at all. Any successful login is automatic
   true-positive.
6. Pull adjacent `event` lines for the same session (15-minute
   window after success). Look for state-change events that suggest
   evasion: `security` (cameras off), `connectivity` (uplink off),
   `setSecurity {camerasEnabled: false}`.
7. Consult Threat Intel (`query_threat_intel`) for the source IP —
   credential-stuffing IPs typically appear on AbuseIPDB /
   GreyNoise block lists. **Skip this step** if step 2 already
   resolved the burst to a managed internal workstation with a
   legitimate user signed in.

## Containment steps (recommendation only — humans execute)

- **Block the source IP** at the perimeter. The bridge officer on
  watch can take this action via the Brussels NOC.
- **Force a password reset + MFA re-enrollment** for the affected
  account. For service accounts, **rotate the secret** instead.
- **Review session activity** for the successfully-logged-in
  session — focus on state changes to security, connectivity, and
  navigation subsystems.

## Verdict mapping

| Pattern                                              | Verdict             |
|------------------------------------------------------|---------------------|
| **Burst correlates (Sysmon EID 3) to a managed host AND that host's primary user (per the KB) is interactively signed in (4624) during the burst window** | **Closed (false positive — legitimate user mistyping at their own workstation). Attribute the burst to that user + workstation in the case note even though the SCP log line shows the shared `administrator` account.** |
| Burst correlates to a managed host but the interactive user is NOT that host's expected primary user | Active (escalate to L2 — internal workstation potentially compromised) |
| Burst does NOT correlate to any managed host + zero successes + IP not on watchlist | Closed (false positive — likely typo loop or scanner) |
| Burst does NOT correlate to any managed host + zero successes + IP on TI watchlist | Closed (true positive, contained — no compromise) |
| Burst + ≥1 success on `crew_*`                       | Active (escalate to L2 — possible compromise) |
| Burst + ≥1 success on `svc_*` or `admin_*`           | Active (escalate to L3 — confirmed compromise) |
| Success + post-auth state change to security/conn    | Active (escalate to incident commander — active intrusion) |

## Past incidents

- **2025-11-12**: 47 failures + 1 success on `svc_admin` from a
  Russian IP, followed by `setSecurity {camerasEnabled: false}` 51
  seconds later. Closed as confirmed compromise; root cause: legacy
  `svc_admin` credential leaked in a 2024 dump. Action: account
  decommissioned (still showing up in 2026 logs because indexer is
  slow to catch up — investigator should treat any `svc_admin`
  activity as automatic alarm).
- **2025-08-04**: 23 failures from a hotel WiFi at a port call,
  zero successes. Closed as benign — guest WiFi captive portal was
  hammering the login form.
