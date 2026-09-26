# Phase 4 — Onboard GOAD into the AISOC Sentinel

Attaches the **GOAD** Active Directory lab (its 5 Windows Servers) to the Sentinel
workspace from Phase 1, so real AD attacks (Kerberoasting, DCSync, password spray,
AS-REP roasting) become Sentinel incidents that the existing Foundry agents triage —
**no new workspace, no new DCR, no agent/runner code changes**.

GOAD itself is deployed separately with `goad.sh -p azure` (its own state); this phase
only *discovers* GOAD's VMs and wires them in.

## How it works

Per GOAD Windows VM (discovered by name in `var.goad_resource_group`):
1. **Azure Monitor Agent** — `azurerm_virtual_machine_extension` (`AzureMonitorWindowsAgent`).
2. **Sysmon + AD audit policy** — `azurerm_virtual_machine_run_command` running
   `scripts/onboard_goad_endpoint.ps1` (installs Sysmon + the SwiftOnSecurity config and
   enables the audit subcategories the AD detections need: Kerberos Ticket/Auth Service,
   Credential Validation, Directory Service Access/Changes, Certification Services).
   *Not* a `CustomScriptExtension` — GOAD already puts one on these VMs and only one is
   allowed per VM; `run_command` coexists and re-runs when the script changes.
3. **DCR association** — `azurerm_monitor_data_collection_rule_association` to **Phase 1's
   existing DCR** (`dcr_id`, read via `terraform_remote_state`). That DCR already forwards
   `Security!*` → `SecurityEvent` (all AD-attack EIDs) and Sysmon → `Event`.

Then it deploys a starter set of **AD analytic rules** (`rules.tf` +
`scripts/rules/*.kql`, via `az rest` PUT — same idempotent pattern as Phase 1):
Kerberoast (4769/RC4), DCSync (4662 replication GUIDs), password spray (4625/4771),
AS-REP roast (4768 no-preauth/RC4). Firing rules create incidents the Foundry
Triage → Investigator → Reporter pipeline auto-picks-up.

## Prerequisites

- **Phase 1 applied** with AMA enabled (default) so its `dcr_id` output is non-null.
- **GOAD deployed on Azure in the SAME region as Phase 1** — a DCR only associates with
  VMs in its own region. (`goad.sh -t install -l GOAD -p azure`.)
- `az` logged in to the same subscription; `terraform` ≥ 1.6; `jq`.

## Deploy

```bash
cd terraform/4-onboard-goad
terraform init
terraform apply \
  -var goad_resource_group=GOAD          # = GOAD's lab_identifier (az group list -o table)
# override the roster with -var 'goad_vm_names=["dc01","dc02","dc03","srv02","srv03"]'
```

## Verify

```kql
// GOAD hosts reporting?
Heartbeat | where Computer in ('dc01','dc02','dc03','srv02','srv03')
| summarize arg_max(TimeGenerated, *) by Computer
// AD audit + Sysmon arriving?
SecurityEvent | where Computer startswith "dc" | summarize count() by EventID | top 15 by count_
Event | where Source == "Microsoft-Windows-Sysmon" | take 5
```

Then run an attack (e.g. Kerberoast or an `nxc` password spray) → the matching analytic
rule fires → a Sentinel incident appears → the Foundry agents annotate it → it shows in
PixelAgents Web.

## Variables

| Variable | Default | Purpose |
|---|---|---|
| `goad_resource_group` | `GOAD` | GOAD's Azure RG (its `lab_identifier`) |
| `goad_vm_names` | `[dc01,dc02,dc03,srv02,srv03]` | GOAD Windows VMs to onboard |
| `enable_sysmon` | `true` | Install Sysmon + AD audit policy via run_command |
| `enable_ad_rules` | `true` | Deploy the AD analytic rules |
| `sysmon_config_url` | SwiftOnSecurity | Sysmon config XML |

## Still needed for full AD triage (agent content — separate change)

The data plane needs no changes, but the agents are still ship-themed. To make AD
incidents read well, edit `terraform/2-deploy-aisoc/agents/`:
- de-hardcode `Computer == "BRIDGE-WS"` in `instructions/common.md`;
- add an AD path to `investigator.md` (and drop "only `ContainerAppConsoleLogs_CL`");
- allow `SecurityEvent`/`Event` in `detection-engineer.md`;
- revise the "Windows 4625 = noise" framing in `triage.md` / KB `09` / `11`;
- add `company-context/` pages: GOAD monitored systems, an AD-attack EID reference, and
  AD runbooks (Kerberoast/DCSync/spray/AS-REP). Push via `upload_company_context.sh`.
```
