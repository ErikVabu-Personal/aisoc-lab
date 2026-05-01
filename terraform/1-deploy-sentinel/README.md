# Phase 1 — Sentinel + Ship Control Panel + lab VM

The foundation phase. Stands up the Microsoft Sentinel workspace
and three things that produce telemetry into it: the Ship Control
Panel Container App (the "victim" web app), a Windows 11 lab VM
(for portal-side observation + manual telemetry generation), and a
shared Key Vault used by Phases 2 and 3 for Function host keys and
secrets.

## What gets created

| Resource | File | Notes |
|----------|------|-------|
| Resource Group | (top-level provider config) | Created if it doesn't exist; chosen via `var.resource_group_name`. |
| Log Analytics workspace + Sentinel onboarding | `main.tf` | Workspace name is suffixed with a random 6-char string. |
| Three analytic rules | `sentinel_rules.tf` | Repeated-failed-logins, password-spray, suspicious-user-agent. Defined as JSON ARM templates and applied via `azapi_resource`. |
| Ship Control Panel Container App | `ship_control_panel.tf` | Public ingress, image pulled from GHCR. Logs stdout to the workspace via the App Insights connection-string in the Container App's env. |
| Windows 11 lab VM | `main.tf` | Optional manual-trigger telemetry source. Auto-shutdown configured. RDP open from any source — throwaway demo box. |
| Azure Monitor Agent + DCR | `main.tf` | Forwards Windows Event Logs to the workspace. |
| **Sysmon (Sysinternals)** | `sysmon.tf` + `scripts/install_sysmon.ps1` | CustomScriptExtension installs Sysmon with the SwiftOnSecurity verbose config; the DCR is extended to forward `Microsoft-Windows-Sysmon/Operational` into the workspace. Toggleable via `enable_sysmon` (default `true`). |
| Shared Key Vault | `aisoc_kv.tf` | Used by Phases 2 and 3 to publish Function host keys and Container App secrets. |
| App Insights for the Ship Control Panel | `appinsights_shipcp.tf` | Connection-string only (no sampling configured); Container App reads it and emits trace + metrics. |
| Defender for Endpoint onboarding | `mde_kv.tf`, `MDE.md` | Optional — disabled by default. See `MDE.md` for the manual onboarding-script step. |

## Prerequisites

- Terraform >= 1.6
- `az` CLI logged in: `az login`
- Subscription selected: `az account set -s <SUBSCRIPTION_ID>`
- `jq` (used to parse the analytic-rule JSON)

## Deploy

The standard path is the top-level driver:

```bash
./aisoc_demo.sh deploy --resource-group=… --azure-location=…
```

For just this phase:

```bash
cd terraform/1-deploy-sentinel
terraform init
terraform apply
```

## Destroy

```bash
terraform destroy
```

The top-level destroy script handles a quirk where the lab VM has
to be running for its agent extensions to be removed cleanly — see
the README at the repo root for details.

## Defender for Endpoint

There are two parts:

1. **Onboard the lab VM to MDE.** Terraform can do this only if you
   provide the PowerShell onboarding script exported from the MDE
   portal. Drop it in `mde/` and set
   `TF_VAR_mde_onboarding_script=mde/<filename>.ps1`.
2. **Enable the Sentinel data connector for MDE** so MDE alerts /
   incidents flow into the workspace.

Both are documented in `MDE.md`. Both are disabled by default.

## DCR + analytic-rules notes

- The DCR uses the default ingestion endpoint (no DCE) to keep
  payloads simple and avoid API validation edge cases.
- The DCR's XPath queries collect Levels 1–3 from Application /
  System and Levels 1–4 from Security (Security audit events are
  Level=4 / Information). When Sysmon is enabled, the DCR also
  forwards `Microsoft-Windows-Sysmon/Operational` Levels 1–4 (all
  Sysmon events are Level=4 by design — must be included or
  nothing arrives).
- Analytic rules are defined as JSON ARM templates under
  `analytic_rules/` and applied via `azapi_resource` because the
  azurerm provider's coverage of Sentinel-rule shapes lags the
  product. Each rule's KQL is heavily commented; edit directly +
  re-apply.

## Sysmon notes

- The CustomScriptExtension downloads two files via `fileUris`:
  `scripts/install_sysmon.ps1` from this repo's `main` branch, and
  the SwiftOnSecurity `sysmonconfig-export.xml` from upstream. Both
  URLs are configurable via `var.sysmon_install_script_url` /
  `var.sysmon_config_url` — pin to a commit SHA for prod, or swap
  in Olaf Hartong's sysmon-modular config.
- The script is **idempotent** — it detects an existing Sysmon
  service and reloads the config in place (`Sysmon64.exe -c <file>`)
  instead of reinstalling. Re-running `terraform apply` is safe.
- All install output is captured at
  `C:\ProgramData\AISOC\Sysmon\install.log` on the VM. RDP in and
  read it if the channel doesn't appear in Log Analytics.
- Once Sysmon events are flowing, you'll see them in the workspace
  under the `Event` table (the same table that holds Application /
  System / Security):

  ```kusto
  Event
  | where Source == "Microsoft-Windows-Sysmon"
  | summarize n = count() by EventID, RenderedDescription
  | order by n desc
  ```

  Common Sysmon event IDs you'll get: 1 (process create), 3 (network
  connection), 7 (image loaded), 10 (process access), 11 (file
  create), 12/13/14 (registry), 22 (DNS query), 25 (process
  tampering).

## Observability tip

The Ship Control Panel logs stream to the workspace via Container
Apps' default `ContainerAppConsoleLogs_CL` table. The base filter
the AISOC agents use (and the one to start with for any manual
exploration):

```kusto
ContainerAppConsoleLogs_CL
| where Stream_s == "stdout"
| extend j = parse_json(Log_s)
| where j.service == "ship-control-panel"
```

That gets you every state-change event from the panel in
structured form (`j.event`, `j.detail`, `j.meta`).
