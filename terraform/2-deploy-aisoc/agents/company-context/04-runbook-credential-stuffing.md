# Runbook — credential stuffing against the Ship Control Panel

**When to use:** the alert "Auth — Repeated login failures" (or similar)
shows ≥10 `auth.login.failure` events for the same username from the
same source IP within a 15-minute window.

## Investigator checklist

1. Confirm scope. Run the standard auth-failures KQL with a
   widened window (60 min); pivot by `username` and `clientIp`.
2. Check whether **any** login succeeded for the same `username` /
   `clientIp` pair. A successful login during or right after the
   burst flips this from a brute-force attempt to a confirmed
   compromise.
3. Geolocate `clientIp`. Cross-check against the user's typical
   location. NVISO Cruiseways crew and bridge officers should not be
   logging in from countries outside the voyage's port-call list.
4. If the user is a **service account** (`svc_*`), it should have no
   interactive logins at all. Any successful login is automatic
   true-positive.
5. Pull adjacent `event` lines for the same session (15-minute
   window after success). Look for state-change events that suggest
   evasion: `security` (cameras off), `connectivity` (uplink off),
   `setSecurity {camerasEnabled: false}`.
6. Consult Threat Intel (`query_threat_intel`) for the source IP —
   credential-stuffing IPs typically appear on AbuseIPDB / GreyNoise
   block lists.

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
| Burst + zero successes + IP not on watchlist         | Closed (false positive — likely typo loop or scanner) |
| Burst + zero successes + IP on TI watchlist          | Closed (true positive, contained — no compromise) |
| Burst + ≥1 success on `bo_*` / `crew_*`              | Active (escalate to L2 — possible compromise) |
| Burst + ≥1 success on `svc_*` or `admin_*` or VIP    | Active (escalate to L3 — confirmed compromise) |
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
