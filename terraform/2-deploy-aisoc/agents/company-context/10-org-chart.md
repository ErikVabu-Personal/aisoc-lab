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
**workstation logs** (Windows auth on the bridge workstation
`BRIDGE-WS`), not from the SCP username — see "Captain-on-`BRIDGE-WS`
pattern" below.

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

## Captain-on-`BRIDGE-WS` pattern (frequent demo signal)

The bridge workstation (`BRIDGE-WS`) is **the captain's
workstation**: physically on the bridge of M/S Aegir, and the only
human who interactively logs in is Jack Sparrow under the local
account `jack.sparrow`.

The SCP itself does NOT distinguish the captain from any other
bridge officer — they all sign in as the shared `administrator`
account. So a Ship Control Panel log line by itself can't tell you
*who* the human was. The trick is **data-driven correlation**:
the source IP of the burst is some address — random, deployment-
specific, and NOT something the KB knows in advance. The agent
discovers what that IP belongs to from telemetry, then uses the KB
to attach role / identity meaning to what it finds.

  SCP event (auth.login.failure for `administrator`)
    └─ has a `detail.client` field — some source IP X.X.X.X
        └─ Is X.X.X.X a managed host? (data check: are we
           receiving endpoint telemetry traceable to it?)
            └─ If yes, which `Computer` is producing the logs that
               correlate with that IP, and who is interactively
               signed in there? (data check: Windows 4624 +
               Sysmon network events around the burst window)
                └─ KB lookup: what is that user's role, and what
                   is that workstation's role? (`jack.sparrow` →
                   captain, `BRIDGE-WS` → captain's workstation)

The KB is consulted only at the **last** step — to interpret what
the data already revealed. The IP-to-host link is never in the KB;
it can't be (it changes every deployment). The role-and-identity
context is.

**Verdict path for a credential-stuffing-looking burst against
`administrator`:**

  1. From the SCP `auth.login.failure` events, take the source IP
     (`detail.client` field). Call it X.X.X.X.

  2. **Is X.X.X.X a managed / internal host?** Check whether the
     `Event` table is receiving endpoint telemetry traceable to
     X.X.X.X around the burst window. The cleanest signal is
     Sysmon network events (EID 3) where the destination is the
     SCP — the `Computer` column on those events names the host
     making the connection:

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
     | summarize n=count(), ports=make_set(DestPort) by Computer, DestIp
     | order by n desc
     ```

     If a `Computer` shows up here making outbound connections to
     the SCP during the burst window, that's the host the burst
     came from. (Confirmation: the burst's source IP X.X.X.X
     should correspond to the egress NAT of the segment that
     `Computer` is on — typically inferable from the asset
     inventory in the `company-policies` KB, but the
     `Computer` field is the authoritative answer.) If no host
     shows up, the source is unmanaged — proceed with the normal
     credential-stuffing runbook.

  3. **Who was interactively signed in at that host during the
     burst?** Pivot on the `Computer` discovered in step 2:

     ```kusto
     Event
     | where Computer == "<host-from-step-2>"
     | where TimeGenerated between (
         (datetime(<burst-start>) - 5m) ..
         (datetime(<burst-end>) + 5m))
     | where Source == "Security" and EventID == 4624
     | project TimeGenerated, AccountName, LogonType
     ```

     A 4624 with `LogonType in (2, 10, 11)` for the same account
     spanning the burst window means a human was physically (or
     RDP-)using that workstation while the SCP burst happened.

  4. **KB lookup — role and identity context.** Now retrieve this
     org chart and the asset inventory (in the `company-policies`
     KB):
     - Look up the `Computer` from step 2 in the asset inventory.
       If it's `BRIDGE-WS`, this org chart says it's the
       **captain's workstation**.
     - Look up the `AccountName` from step 3 in this org chart.
       If it's `jack.sparrow`, this page says it's the **master
       (Jack Sparrow)**.

  5. Verdict:
     - **Captain-on-`BRIDGE-WS` (host = `BRIDGE-WS`, user =
       `jack.sparrow`):** Closed (false positive — the captain
       mistyped the shared `administrator` password at his
       workstation). Attribute the burst to "Jack Sparrow @
       `BRIDGE-WS`" in the case note even though the SCP log line
       said `administrator`.
     - **Managed host but a different identity:** treat as a
       compromised internal workstation; escalate.
     - **Unmanaged source (step 2 returned nothing):** treat as a
       real external burst; proceed with the credential-stuffing
       runbook.

This pattern is the cleanest demonstration of why the SOC agents
benefit from a KB. The data answers most of the question — *which*
host, *which* user — without needing the KB at all. The KB is
what turns a username and a hostname into "the captain at the
captain's workstation". Without the KB, the agent stops at "user
`jack.sparrow` on `BRIDGE-WS`" and lacks the organisational
context to express the verdict in human terms.

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
