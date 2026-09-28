# Glossary — SOC / AISOC terms

## SOC terms (NVISO-specific shorthand)

- **AISOC** — the AI SOC pipeline (this project). Triage →
  Investigator → Reporter, with Detection Engineer + SOC Manager +
  Threat Intel as horizontal agents.
- **Brussels NOC** — 24/7 network operations centre at HQ. Has
  remote-override authority on the corporate estate.
- **HITL** — human-in-the-loop. The agent calls `ask_human` and
  blocks until a human at the SOC desk replies in free text.
- **CONFIDENCE_THRESHOLD** — the operator-set 0–100 dial that biases
  how readily an agent reaches for `ask_human` (low → ask more
  often; high → push through).

## Monitored-surface shorthand

- **Maison Miró** — the public-facing web store; the web victim.
  Emits `[EVENT]` lines to `ContainerAppConsoleLogs_CL`
  (`ContainerName_s == "maison-miro"`). Correlate by `source_ip`.
  Schema + attack catalogue in `13-maison-logging.md`.
- **GOAD** — "Game of Active Directory": the corporate Windows
  domains (three domains / two forests, `dc01`–`dc03` + `srv02`/`srv03`).
  Audit events land in `SecurityEvent`, Sysmon in `Event`. AD-attack
  reference in `12-goad-ad-attacks.md`; endpoint telemetry + Sysmon
  pivots in `09-endpoint-telemetry.md`.
- **honeytoken** — a decoy customer record on Maison's
  `/api/customers` that no legitimate flow reads. A
  `data.honeytoken_touched` event is a **zero-false-positive** theft
  signal.
- **auto-SOAR** — Maison's built-in `/soc/*` control plane. When
  armed, a `critical` event auto-triggers containment; the follow-on
  `containment.engaged` / `containment.blocked` events are the
  "response worked" evidence.

## NVISO-specific abbreviations

- **NVISO Cruiseways** = the operating brand. (Not a typo for
  "NVISO Cruises" — the legal entity uses the longer form.)
- **CR-NNNN** = voyage code. CR-2614 was the demo voyage; M/S Aegir
  on its 11-day Mediterranean loop.
- **PSA** = the Belgian Federal Public Service Authority that
  oversees flagged-vessel cyber compliance.
