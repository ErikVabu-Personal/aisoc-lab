# Escalation matrix + on-call

## When to escalate (cheat sheet)

- **L1 → L2** (triage to investigator): every alert that triage
  decides isn't an obvious false-positive. The AISOC pipeline does
  this automatically; humans escalate manually when they think the
  agent missed something.
- **L2 → L3** (investigator to incident commander):
  - Confirmed compromise of a VIP / service / admin account
  - State changes affecting safety-of-life systems (navigation,
    stabilizers in manual at sea, anchor at sea)
  - Confirmed disabling of cameras or uplink
  - Cross-vessel pattern (same indicator on >1 ship)
- **L3 → CISO**: any incident that triggers a regulator
  notification (PSA, GDPR Art. 33, IMO 2021 cyber-resilience
  reporting).

## On-call rotation (illustrative — the real schedule lives in PagerDuty)

| Tier | Primary                | Secondary           | Phone hours (CET) |
|------|------------------------|---------------------|-------------------|
| L1   | rotating shifts (24/7) | n/a                 | 24/7              |
| L2   | Anneke L. (this week)  | Ryotaro K.          | 09:00–22:00       |
| L3   | Erik V. (incident cmdr)| Lukas A. (deputy)   | 24/7 oncall       |
| TI   | Asha M. (Mon–Fri)      | shared L2 fallback  | 09:00–17:00       |

## How AISOC routes to humans

- The agent's `ask_human` call posts to the **PixelAgents Web** UI's
  "Incident input needed" sidebar.
- If the orchestrator was triggered by a specific user (manual run),
  the question routes to that user's queue (`target` field).
- If the orchestrator picked the incident up automatically
  (auto-pickup), the question is broadcast to every signed-in
  analyst with the matching role.
- **Role-routing**: the agent's slug determines which role sees the
  question. `triage` / `investigator` / `reporter` → `soc-analyst`;
  `detection-engineer` → `detection-engineer`; `soc-manager` →
  `soc-manager`; `threat-intel` → `threat-intel-analyst`.

## Approved tooling

The following tools are explicitly **expected** to be active on the
Ship Control Panel:

- **NVISO Telemetry agent** — runs on every vessel, pushes logs to
  the Container App. Authenticates as `svc_telemetry`.
- **HealthCheck probe** — synthetic login attempts every 5 minutes
  to validate the auth path. Authenticates as `svc_health`.
  These succeed; they will appear in `auth.login.success` and
  should NOT be flagged as anomalous.
- **NVISO Indexer** — feeds the search index. Authenticates as
  `svc_indexer`. No interactive login expected.

Anything outside this list calling the auth endpoint should be
treated as suspect.
