# Org chart — who's who on M/S Aegir

Authoritative roster for the M/S Aegir's current crew. Used by the
SOC agents to map identities seen in logs (Ship Control Panel
usernames, bridge-workstation logins, Sentinel incident "owner"
assignments) back to actual people.

This page is curated by the SOC Manager + HR. When a crew change
happens (promotion, sign-on, sign-off) the change shows up here
first; the AISOC agents pick it up on their next KB retrieval.

## Bridge officers

| Person | Role | Ship Control Panel account | Workstation account | Notes |
|--------|------|----------------------------|---------------------|-------|
| **Jack Sparrow** | **Master / Captain** | `bo_captain` | **`jack.sparrow`** (local admin on **`BRIDGE-WS`**, the bridge workstation) | Highest authority on board. Holds the master's account on the Ship Control Panel; uses his personal Windows account when working at the bridge workstation. |
| Anneke Lindgren | Staff Captain | `bo_lindgren` | — | Second-in-command. Full bridge privileges. |
| Ryotaro Kobayashi | Chief Officer | `bo_kobayashi` | — | Navigation watch lead. |
| Lukas Akkermans | Second Officer | `bo_akkermans` | — | Watchkeeper, in alternation with the staff captain. |
| Mira Eikholt | Third Officer | `bo_eikholt` | — | Watchkeeper. Most recently signed on (CR-2614). |

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

- `bo_captain` → **Jack Sparrow** (master). Highest-privilege
  bridge account; activity on it is high signal.
- Windows local logon for `jack.sparrow` on **`BRIDGE-WS`** → **Jack Sparrow**
  working at the bridge workstation. He's the only person
  who legitimately uses that account, and `BRIDGE-WS` is the
  only host that account legitimately appears on.
- `bo_<lastname>` → bridge officer in the table above. Cross-
  reference to confirm the person is currently on watch
  (consult voyage schedule when in scope).
- `eng_<lastname>` → engineering officer in the table above.
- `svc_*`, `vendor_*`, `admin_*` → see naming-conventions page.

## Captain-on-`BRIDGE-WS` pattern (frequent demo signal)

The bridge workstation (`BRIDGE-WS`) is **the captain's
workstation**: physically on the bridge of M/S Aegir, and the only
human who interactively logs in is Jack Sparrow under the local
account `jack.sparrow`. That means:

- Any **`auth.login.success`** on `BRIDGE-WS` for `jack.sparrow` —
  the captain is on the workstation. Cross-reference the
  timestamp against bridge activity.
- A **failed-login burst on the Ship Control Panel originating
  from `BRIDGE-WS`'s public IP** while `jack.sparrow` has an
  active Windows session is overwhelmingly likely to be the
  captain mistyping his password — **not** an external
  brute-force.
  Verdict path:
  1. Retrieve this page + `04-runbook-credential-stuffing.md`.
  2. Confirm the source IP belongs to `BRIDGE-WS` (check the
     workstation's `public_ip` output, or KQL on Windows logon
     events at the same source).
  3. Confirm `jack.sparrow` was logged into `BRIDGE-WS` during
     the burst window (Sysmon EID 1 / Security 4624 with
     `Computer == "BRIDGE-WS"`).
  4. Verdict: **Closed (false positive — captain mistyped at a
     workstation he was actively using).** Note the captain's
     name + `BRIDGE-WS` in the case note.

This pattern is the cleanest demonstration of why the SOC agents
benefit from a KB: the data alone says "47 failed logins from a
public IP" — looks like an attack. The KB is what tells the
investigator that source IP belongs to `BRIDGE-WS`, that
`BRIDGE-WS` is the captain's workstation, and that the captain
was actively logged in at the time.

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
