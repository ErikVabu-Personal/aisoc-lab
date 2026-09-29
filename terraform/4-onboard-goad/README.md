# Phase 4 — Onboard GOAD into the AISOC Sentinel

Attaches the **GOAD** Active Directory lab (its 5 Windows Servers) to the Sentinel
workspace from Phase 1, so real AD attacks (Kerberoasting, DCSync, password spray,
AS-REP roasting) become Sentinel incidents that the existing Foundry agents triage —
**no new workspace, no agent/runner code changes**.

GOAD itself is deployed separately with `goad.sh -p azure` (its own state); this phase
only *discovers* GOAD's VMs and wires them in.

**GOAD may live in a different region than Phase 1.** A DCR must be co-located with the
VMs it associates, so this phase creates its **own** DCR in GOAD's region
(`dcr-goad-<region>`) rather than reusing Phase 1's. That DCR still routes into the
Phase-1 Sentinel workspace — DCR → workspace is allowed cross-region — so GOAD can run
in a capacity-rich region (e.g. `westus2`) even when Phase 1's region has no VM capacity.
Set `goad_location` to GOAD's region (leave it null to reuse Phase 1's, i.e. same-region
onboarding).

## How it works

Per GOAD Windows VM (discovered by name in `var.goad_resource_group`):
1. **Azure Monitor Agent** — `azurerm_virtual_machine_extension` (`AzureMonitorWindowsAgent`).
2. **Sysmon + AD audit policy** — `azurerm_virtual_machine_run_command` running
   `scripts/onboard_goad_endpoint.ps1` (installs Sysmon + the SwiftOnSecurity config and
   enables the audit subcategories the AD detections need: Kerberos Ticket/Auth Service,
   Credential Validation, Directory Service Access/Changes, Certification Services).
   *Not* a `CustomScriptExtension` — GOAD already puts one on these VMs and only one is
   allowed per VM; `run_command` coexists and re-runs when the script changes.
3. **DCR + association** — a GOAD-region DCR (`azurerm_monitor_data_collection_rule`,
   `dcr-goad-<region>`) that forwards `Security!*` → `SecurityEvent` (all AD-attack EIDs)
   and Sysmon/App/System → `Event`, targeting the Phase-1 Log Analytics workspace (read
   via `terraform_remote_state`), plus an `azurerm_monitor_data_collection_rule_association`
   from each host to it. Same shape as Phase 1's DCR, just co-located with GOAD.

Then it deploys a starter set of **AD analytic rules** (`rules.tf` +
`scripts/rules/*.kql`, via `az rest` PUT — same idempotent pattern as Phase 1):
Kerberoast (4769/RC4), DCSync (4662 replication GUIDs), password spray (4625/4771),
AS-REP roast (4768 no-preauth/RC4). Firing rules create incidents the Foundry
Triage → Investigator → Reporter pipeline auto-picks-up.

## Prerequisites

- **Phase 1 applied** so its `log_analytics_workspace_id` output is non-null.
- **GOAD deployed on Azure** (`goad.sh -p azure -l GOAD -m remote`). It may be in any
  region — pass `goad_location` to match. (West US is capacity-starved for the GOAD VM
  families; `westus2` is the tested capacity region.)
- `az` logged in to the same subscription; `terraform` ≥ 1.6; `jq`.

## Deploy

```bash
cd terraform/4-onboard-goad
terraform init
terraform apply \
  -var goad_resource_group=GOAD-aa6e32-goad-azure \  # GOAD's hashed RG (az group list -o table | grep goad-azure)
  -var goad_location=westus2                          # GOAD's region; omit to reuse Phase 1's
# override the roster with -var 'goad_vm_names=["goad-vm-dc01",...]'
```

Or, from the repo root, let the driver pass these through:
`./aisoc_demo.sh deploy --onboard-goad --goad-resource-group GOAD-aa6e32-goad-azure --goad-location westus2`.

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
| `goad_resource_group` | `GOAD` | GOAD's Azure RG (its hashed `lab_identifier`, e.g. `GOAD-aa6e32-goad-azure`) |
| `goad_location` | `null` | GOAD's region; DCR is created here. `null` = reuse Phase 1's region |
| `goad_vm_names` | `[goad-vm-dc01,…,goad-vm-srv03]` | GOAD Windows VM *resource* names to onboard |
| `enable_sysmon` | `true` | Install Sysmon + AD audit policy via run_command |
| `enable_ad_rules` | `true` | Deploy the AD analytic rules |
| `sysmon_config_url` | SwiftOnSecurity | Sysmon config XML |

## Agent content for AD triage (done in this branch)

The data plane needs no changes; the agent prompts + KB cover the GOAD Active
Directory estate (the web-victim path now points at Maison Miró — the Ship Control
Panel and its lab-VM/captain narrative have been retired) (`terraform/2-deploy-aisoc/agents/`):
- `instructions/common.md` — `SecurityEvent`/`Event` scoped to the GOAD Windows
  estate (`dc01`–`dc03`/`srv02`/`srv03`) + AD EIDs;
- `instructions/triage.md` — AD rule family added; "match signal to the rule's table"
  reframed bidirectionally (Windows events are signal on AD incidents, not noise);
- `instructions/investigator.md` — workflow branches by table; new "Active Directory
  investigation path" (per-attack KQL + source-IP→host→user pivot);
- `instructions/detection-engineer.md` — `SecurityEvent`/`Event` allowed;
- `company-context/02-monitored-systems.md` — GOAD estate added;
- `company-context/12-goad-ad-attacks.md` — **new**: AD EID reference + runbooks
  (Kerberoast/DCSync/spray/AS-REP) + verdict mapping.

**After deploy**, push the KB changes so the agents see them:
`cd terraform/2-deploy-aisoc/agents/company-context && ./upload_company_context.sh`
(then re-run the agent deploy script if you changed instructions).
