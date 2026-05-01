# IT Acceptable Use Policy (NVISO Cruiseways)

**Owner:** Group IT, Brussels HQ
**Last reviewed:** 2026-02-14
**Audience:** all NVISO Cruiseways employees and on-vessel crew with
operations-network access (bridge officers, engineers, hospitality
managers, IT staff, vendor maintenance personnel).

This page is the SOC's working copy of the AUP. The authoritative
version lives on the HR SharePoint at
`https://nvisocruiseways.sharepoint.com/sites/HR/Policies/AUP`. If
the two diverge, that one wins — but the SOC keeps a copy here so
the AISOC agents can ground responses against it without depending
on a live SharePoint connector.

## Permitted

- Use of the Ship Control Panel and other operations systems
  **strictly for authorised work duties**.
- Personal use of the **crew WiFi** during off-duty hours, subject
  to the company's separate AUP for crew personal devices.
- Use of vendor maintenance accounts (`vendor_*`) **during the
  scheduled maintenance window referenced in the corresponding
  change ticket**, no other times.

## Prohibited

- Sharing of credentials of any account, including service
  accounts (`svc_*`).
- Connecting personal devices to the **operations network**. The
  guest WiFi is segregated and separately monitored.
- Disabling, bypassing, or evading any security control,
  including but not limited to:
  - Camera systems (CCTV)
  - Connectivity (Starlink uplink)
  - Collision-detection
  - Authentication / multi-factor enrolment
- Installing software not on the IT-approved list (the approved
  list lives on the HR SharePoint; ask Group IT if unsure).
- Using NVISO accounts to access non-company systems. Cross-tenant
  use is explicitly forbidden.

## Reporting requirements

- **Suspected compromise** of any account: report immediately to
  the SOC via the Brussels NOC (24/7) or by email to
  `soc@nviso-cruiseways.eu`.
- **Phishing email** received: forward to `phishing@nviso-cruiseways.eu`
  with full headers, then delete.
- **Lost / stolen device** with NVISO credentials: report to the
  Brussels NOC within 1 hour. The NOC will trigger the SOC to
  rotate credentials.

## Consequences

Breach of this AUP can lead to:

- **Verbal warning** for first-time minor breaches (e.g. forgotten
  password reset, shared credential with a teammate during a
  hand-over).
- **Written warning + mandatory re-training** for repeated minor
  breaches or first-time moderate breaches.
- **Suspension or termination** for breaches involving deliberate
  evasion of security controls, sharing of admin credentials, or
  unauthorised access.
- **Criminal referral** for breaches involving the disabling of
  safety-of-life systems (navigation, anchor, stabilizers,
  collision-detection).

## How the SOC uses this AUP

When the AISOC agents triage an incident that involves a specific
user action, they reference this page to establish whether the
action was **policy-permitted** or **policy-violating**. A
policy-violating action that's also security-significant is treated
as a confirmed insider threat indicator and routed to the SOC
manager for human review.

Examples that have come up in past incidents:

- A bridge officer disabling collision-detection during a port
  approach: **policy-permitted with caveats** — the AUP allows
  operational decisions, but the SOC manager flagged it because
  there was no logged justification. Resolution: process change to
  require a comment on every safety-toggle event.
- A `vendor_*` account connecting outside the agreed maintenance
  window: **policy-violating, automatic compromise alarm**.
- A crew member using their interactive account to invoke a service
  account flow: **policy-violating, automatic compromise alarm**
  (see also 03-account-naming.md in the company-context corpus).
