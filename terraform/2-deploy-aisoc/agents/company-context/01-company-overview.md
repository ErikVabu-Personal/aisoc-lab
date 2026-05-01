# NVISO Cruiseways — company overview

NVISO Cruiseways is a luxury cruise line operating mid-size vessels
on northern-hemisphere itineraries (Mediterranean, Norwegian fjords,
Alaskan inside passage, North Atlantic crossings).

## Fleet

| Vessel       | Class     | Pax  | Crew | Notes                                |
|--------------|-----------|------|------|--------------------------------------|
| M/S Aegir    | Aegir     | 1280 | 480  | Lead ship; the demo's monitored vessel |
| M/S Saga     | Aegir     | 1280 | 480  | Sister ship                            |
| M/S Njord    | Aegir-II  | 1640 | 540  | Newer build, same Bridge & Operations stack |

All three vessels run the same Bridge & Operations control surface
(the **Ship Control Panel** that AISOC monitors), with vessel-
specific configuration injected at boot. A finding on one ship
usually has equivalents on the others; cross-fleet correlation is
common during incident response.

## Corporate footprint

- **HQ**: Brussels, Belgium (NVISO Group HQ)
- **Operations centre (24/7 NOC + AISOC)**: Brussels, on the same
  campus as HQ. The AISOC team is part of NVISO Cruiseways Security
  Operations.
- **Crew operations**: Bergen, Norway (manning, scheduling)
- **Port calls**: rotating; voyage manifests determine which ports
  are "expected" for crew sign-on/off in any given month.

## SOC team

Three-tier model:
- **L1 (triage)**: 6 analysts on rotating shifts; covers the
  AISOC triage agent's work for true-positive cases that need
  human attention.
- **L2 (investigation)**: 4 senior analysts; the AISOC investigator
  agent escalates here.
- **L3 (incident commander / SOC manager)**: 2 leads; receives the
  reporter's case notes and is the only role that approves
  agent-instruction or detection-rule changes.
- **Threat-intel analyst**: 1 dedicated analyst; the AISOC
  threat-intel agent posts to this human's queue when external
  context is needed.

## Compliance + reporting cadence

- Internal SOC report: weekly, every Monday 09:00 CET, to the CISO.
- External: ad-hoc per regulator request (PSA, CESM, IMO 2021
  cyber-resilience guidance).
- Customer-facing data breach notice: 72h max from confirmed
  exposure (GDPR Art. 33).
