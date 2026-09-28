# Org chart — who's who at NVISO Cruiseways

Authoritative roster for NVISO Cruiseways. Used by the SOC agents
to (a) route human-in-the-loop questions to the right person via
`ask_human`, and (b) map identities seen in logs back to real
people where a name is ambiguous.

This page is curated by the SOC Manager + HR. When a staffing
change happens it shows up here first; the AISOC agents pick it up
on their next KB retrieval.

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

## Business / crew roster

Context for staff identities that may surface in company systems.
NVISO Cruiseways operates the M/S Aegir; the shipboard crew are
staff, not SOC operators.

| Person | Role |
|--------|------|
| Jack Sparrow | Master / Captain |
| Anneke Lindgren | Staff Captain (also SOC L2 — see above) |
| Ryotaro Kobayashi | Chief Officer (also SOC L2 — see above) |
| Lukas Akkermans | Second Officer (also SOC deputy IC — see above) |
| Mira Eikholt | Third Officer (most recently signed on, CR-2614) |
| Hassan Yusuf | Chief Engineer |
| Sara Pellegrini | Second Engineer |

(Lindgren / Kobayashi / Akkermans appear on both rosters because
the SOC analyst rotation is filled in part by senior officers
between voyages — a quirk of NVISO Cruiseways' small SOC headcount.)

## Mapping log identities to people

The two monitored surfaces name identities in different ways —
resolve them against the right page, not against this roster:

- **GOAD Active Directory users** (the Windows domains behind the
  business) use fictional Game-of-Thrones names — `eddard.stark`,
  `cersei.lannister`, `daenerys.targaryen`, plus service accounts.
  The naming conventions and per-domain user lists are in
  `03-account-naming.md`; the attack-relevant principals
  (Kerberoast targets, DCSync-capable accounts) are called out in
  `12-goad-ad-attacks.md`. These are **not** the staff above.
- **Maison Miró** (the public web store) has its own customer
  accounts. An attacker there is identified by `source_ip` — the
  correlation key for the whole incident — not by a staff
  identity. See `13-maison-logging.md`.

When a log line names a username, first decide which surface it
came from (Windows host → `SecurityEvent`/`Event`; web store →
`ContainerAppConsoleLogs_CL`), then resolve it against that
surface's page above. This roster is for HITL routing and
staff-name lookups, not for attributing attacker activity.

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
