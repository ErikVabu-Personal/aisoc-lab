# Runbook — credential stuffing against the Ship Control Panel

**When to use:** the alert "Auth — Repeated login failures" (or similar)
shows ≥10 `auth.login.failure` events for the same username from the
same source IP within a 15-minute window.

## Investigator checklist

1. Confirm scope. Run the standard auth-failures KQL with a
   widened window (60 min); pivot by `username` and `clientIp`.
2. **Source-IP triage — is this an internal / managed source?**
   The burst's `clientIp` is a deployment-specific address; do
   NOT expect to find it pre-named in the KB. Discover what it
   belongs to **from telemetry**:

   a. Query `Event` (Sysmon network connections, EID 3) for any
      managed host making outbound connections to the SCP around
      the burst window:

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

      - **Result has a `Computer`:** the burst is from a managed
        internal workstation; that `Computer` is the source. Hold
        onto the host name and continue to (b).
      - **Result is empty:** no managed host was reaching the SCP
        during the burst — treat as a genuine external source.
        Continue to step 3 below (success-correlation) and step 7
        (Threat Intel).

   b. Pivot on the discovered `Computer` and check who was
      interactively signed in at the same time:

      ```kusto
      Event
      | where Computer == "<host-from-step-2a>"
      | where TimeGenerated between (
          (datetime(<burst-start>) - 5m) ..
          (datetime(<burst-end>) + 5m))
      | where Source == "Security" and EventID == 4624
      | project TimeGenerated, AccountName, LogonType
      ```

      A 4624 with `LogonType in (2, 10, 11)` (interactive,
      RemoteInteractive, CachedInteractive) for an account
      spanning the burst window means a human was physically (or
      RDP-)using that workstation while the SCP burst happened.

   c. **Now** retrieve the org chart (`10-org-chart.md`) and the
      asset inventory (in the `company-policies` KB) to put role
      meaning on the names you found:
        - the `Computer` from (a) → workstation role / owner
        - the `AccountName` from (b) → person + role
      The classic match is `Computer = BRIDGE-WS` +
      `AccountName = jack.sparrow` → **the captain at the
      captain's workstation**, mistyping the shared `administrator`
      password. See "Captain-on-`BRIDGE-WS` pattern" in the org
      chart.
3. Check whether **any** login succeeded for the same `username` /
   `clientIp` pair. A successful login during or right after the
   burst flips this from a brute-force attempt to a confirmed
   compromise — UNLESS the source-IP triage in step 2 puts the
   burst on a captain-on-`BRIDGE-WS` session, in which case a
   successful login is just the captain finally typing it
   correctly.
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
   resolved the burst as the captain-on-`BRIDGE-WS` pattern.

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
| **Burst against `administrator` correlates (Sysmon EID 3) to managed host `BRIDGE-WS`, with `jack.sparrow` interactively signed in (4624) during the burst** | **Closed (false positive — captain mistyping at his bridge workstation; see `10-org-chart.md`)** |
| Burst correlates to a managed host that is NOT `BRIDGE-WS`, OR a different interactive user | Active (escalate to L2 — internal workstation potentially compromised) |
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
