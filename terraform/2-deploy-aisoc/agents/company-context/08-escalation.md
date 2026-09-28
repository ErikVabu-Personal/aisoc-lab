# Escalation matrix + on-call

## When to escalate (cheat sheet)

- **L1 → L2** (triage to investigator): every alert that triage
  decides isn't an obvious false-positive. The AISOC pipeline does
  this automatically; humans escalate manually when they think the
  agent missed something.
- **L2 → L3** (investigator to incident commander):
  - Confirmed compromise of a VIP / service / admin account
  - Confirmed data theft or crown-jewel access on **Maison Miró**
    (`data.honeytoken_touched`, bulk PII exfiltration, IDOR on
    invoices / orders, checkout fraud)
  - Domain-level compromise on **GOAD** (DCSync, or a user added to
    Domain / Enterprise Admins outside a change window)
  - A cross-surface kill chain (a Maison web break-in followed by AD
    attack activity attributable to the same actor)
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

## Approved tooling / expected automation

The following are explicitly **expected** to be active on the
monitored surfaces and should NOT be flagged as anomalous on their
own:

- **Azure Monitor Agent + Sysmon** on every GOAD host — the
  telemetry pipeline into Sentinel. Heartbeats and forwarded audit /
  Sysmon events are normal background.
- **Maison health probe** — periodic `/healthz` hits keep the
  Container App warm. These do not emit `[EVENT]` security lines.
- **Maison auto-SOAR** — Maison's own `/soc/*` responder. When
  armed, `containment.engaged` / `containment.blocked` events with
  `by: "auto-soar"` are the platform responding to a critical event,
  not attacker activity.

Anything outside this list acting on the monitored surfaces —
interactive logons by service / machine accounts, an unrecognised
process on a domain controller, or privileged actions on Maison from
a new `source_ip` — should be treated as suspect.
