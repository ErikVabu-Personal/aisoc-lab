# Org chart — who's who on M/S Aegir

Authoritative roster for the M/S Aegir's current crew. Used by the
SOC agents to map identities seen in logs (Ship Control Panel
usernames, bridge-workstation logins, Sentinel incident "owner"
assignments) back to actual people.

This page is curated by the SOC Manager + HR. When a crew change
happens (promotion, sign-on, sign-off) the change shows up here
first; the AISOC agents pick it up on their next KB retrieval.

## Bridge officers

The Ship Control Panel itself uses a small set of **shared
operational accounts** for the bridge — the panel was built before
the realm migration, and per-person SCP accounts didn't exist when
it shipped. The bridge's primary operational account is
`administrator`. Per-person identity is recovered from
**workstation logs** (Windows auth on the workstation a session
came from), not from the SCP username; the procedure is in
`04-runbook-credential-stuffing.md` and is reusable for any alert
that names a source IP.

| Person | Role | Workstation account | Notes |
|--------|------|---------------------|-------|
| **Jack Sparrow** | **Master / Captain** | **`jack.sparrow`** (local admin on **`BRIDGE-WS`**, the bridge workstation) | Highest authority on board. The captain works almost exclusively at `BRIDGE-WS` while in port; while at sea he operates the SCP from the bridge under the shared `administrator` account. |
| Anneke Lindgren | Staff Captain | — | Second-in-command. Full bridge privileges; operates SCP under `administrator` from the bridge during her watches. |
| Ryotaro Kobayashi | Chief Officer | — | Navigation watch lead. Same shared-account pattern. |
| Lukas Akkermans | Second Officer | — | Watchkeeper, in alternation with the staff captain. |
| Mira Eikholt | Third Officer | — | Watchkeeper. Most recently signed on (CR-2614). |

## Engineering officers

| Person | Role | Ship Control Panel account | Notes |
|--------|------|----------------------------|-------|
| Hassan Yusuf | Chief Engineer | `eng_yusuf` | Engine-room lead, full privileges on engine + stabiliser subsystems. |
| Sara Pellegrini | Second Engineer | `eng_pellegrini` | Watchkeeper. |

## SOC team (Brussels HQ)

These are the humans the AISOC agents route HITL questions to via
`ask_human`. Roles map to the role gate on the PixelAgents Web UI.

| Person | SOC role | Email |
|--------|----------|-------|
| Erik Van Buggenhout | Incident commander (L3) | `erik.vanbuggenhout@nviso.eu` |
| Lukas Akkermans | Deputy incident commander | `lukas.akkermans@nviso-cruiseways.eu` |
| Anneke Lindgren | L2 senior analyst (this week's primary) | `anneke.lindgren@nviso-cruiseways.eu` |
| Ryotaro Kobayashi | L2 senior analyst (secondary) | `ryotaro.kobayashi@nviso-cruiseways.eu` |
| Asha Mansfield | Threat-intel analyst | `asha.mansfield@nviso-cruiseways.eu` |

(Note: Lindgren / Kobayashi / Akkermans appear in both lists
because the SOC analyst rotation is filled in part by senior
bridge officers between voyages — a quirk of NVISO Cruiseways'
small SOC headcount.)

## Identity-mapping cheat sheet for the SOC

When a log line names a username, **first** retrieve this page and
the naming-conventions page (`03-account-naming.md`), then resolve:

- **`administrator`** on the Ship Control Panel → a SHARED bridge
  operational account. The username alone does NOT identify the
  human at the keyboard. To attribute, pivot on the `client`
  (source IP) of the SCP event and cross-reference Windows logon
  events on the workstation owning that IP at the same time.
- Windows local logon for **`jack.sparrow`** on **`BRIDGE-WS`** →
  **Jack Sparrow** working at the bridge workstation. He's the
  only person who legitimately uses that account, and `BRIDGE-WS`
  is the only host that account legitimately appears on.
- `eng_<lastname>` → engineering officer in the table above.
- `svc_*`, `vendor_*`, `admin_*` → see naming-conventions page.

## Workstation-to-person facts the KB owns

The KB does not pre-bake conclusions for specific incident
patterns; it owns the facts an investigator needs to interpret
what the telemetry showed. The relevant facts here:

- **`BRIDGE-WS`** is the bridge workstation — physically on the
  bridge of M/S Aegir, in scope for AISOC monitoring (asset
  inventory in the `company-policies` KB).
- The only human who interactively logs into `BRIDGE-WS` under
  `jack.sparrow` is Jack Sparrow, the master / captain.
- The Ship Control Panel does NOT carry per-person SCP accounts
  for the bridge. All bridge officers — captain included — sign
  in as the shared `administrator` account (see `03-account-
  naming.md`). This means the SCP `username` field by itself
  cannot identify the human; identity has to be reconstructed
  from other sources.

How the SOC reconstructs identity from those facts is a generic
investigation pattern, documented in `04-runbook-credential-
stuffing.md` (source-IP triage) and `09-endpoint-telemetry.md`
(IP-to-host pivot). The KB doesn't hardcode the captain example;
the agent assembles it from the facts above plus the runbook.

## Editing this page

This file is part of the `company-context` corpus. To change it:

1. Edit `terraform/2-deploy-aisoc/agents/company-context/10-org-chart.md`.
2. Run `./upload_company_context.sh` from that folder to push it
   to blob.
3. Wait up to 30 min for the indexer (or force a manual run via
   `az search indexer run`).

OR, on a live deployment, ask the SOC Manager agent to propose the
edit via `propose_change_to_company_context` — the change goes into
the queue, a human approves it, and the SOC manager applies it.

In production this page would typically live in SharePoint instead
of blob (HR already curates org-chart docs there). Foundry IQ
abstracts the source — swapping requires only adding a SharePoint
connection in the Foundry portal; the `10-org-chart.md` content
stays the same.
