# Phase 1 — Sentinel + Maison Miró

The foundation phase. Stands up the Microsoft Sentinel workspace and the
shared plumbing every later phase builds on: the **Maison Miró** Container
App (the intentionally-vulnerable "victim" web store), the shared Container
Apps environment + Application Insights it runs in, a shared Key Vault used
by Phases 2 and 3, and the Windows Event Log **Data Collection Rule** that the
GOAD hosts attach to in `4-onboard-goad`.

There is **no lab VM in this phase** — the range's Windows telemetry comes
entirely from the GOAD domain (Phase 4). Phase 1 only *creates* the DCR
(unassociated) and exports its id.

## What gets created

| Resource | File | Notes |
|----------|------|-------|
| Resource Group | `main.tf` | Created if it doesn't exist; `var.resource_group_name`. |
| Log Analytics workspace + Sentinel onboarding | `main.tf` | Workspace name suffixed with a random 6-char string. |
| Windows Event Log DCR | `main.tf` | Collects Application/System/Sysmon (`Event`) + Security (`SecurityEvent`). Created **unassociated**; `4-onboard-goad` associates the GOAD hosts to it via the exported `dcr_id`. Gated on `enable_windows_event_logs` (default `true`). |
| Maison Miró Container App | `maison_miro.tf` | Public ingress on `:8000`, image pulled from GHCR. Prints `[EVENT] {json}` to stdout → `ContainerAppConsoleLogs_CL`. Pinned to 1 replica (SOC state is in-memory). |
| Shared Container Apps environment | `ship_control_panel.tf` | `cae-shipcp-*`. Kept named `shipcp` on purpose — its id is exported as `container_app_environment_id` and consumed by Phase 2/3 via remote state. |
| Shared App Insights | `appinsights_shipcp.tf` | Workspace-based; connection string exported for the Phase 2 gateway + orchestrator. |
| Container App diagnostics | `containerapp_diagnostics.tf` | Routes the environment's console/system logs to the workspace. |
| Maison analytic rules | `post_apply_scripts.tf` + `scripts/rules/*.kql` | Two scheduled rules (crown-jewel theft/fraud, web attack), deployed after apply by `scripts/deploy_sentinel_scheduled_rule.sh`. |
| Shared Key Vault | `aisoc_kv.tf` | Used by Phases 2 and 3 to publish Function host keys and Container App secrets. |

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

## DCR + analytic-rules notes

- The DCR uses the default ingestion endpoint (no DCE) to keep payloads
  simple and avoid API validation edge cases.
- Its XPath queries collect Levels 1–3 from Application / System, all of
  `Security!*` (Windows audit events are Level=0 / LogAlways — a level
  filter would silently drop 4624/4625/4688/…), and Levels 1–4 from
  `Microsoft-Windows-Sysmon/Operational` (every Sysmon event is Level=4 by
  design — must be included or nothing arrives). Each GOAD host's own
  `sysmonconfig.xml` is the authoritative gate; the AMA filter is broad on
  purpose.
- Analytic rules are **not** created by Terraform directly. Sentinel
  validates KQL at rule-creation time, and the Maison rules query
  `ContainerAppConsoleLogs_CL`, which Log Analytics creates lazily on first
  ingest — ARM would reject the rule on a cold deploy. `post_apply_scripts.tf`
  instead runs `scripts/deploy_sentinel_scheduled_rule.sh`, which polls for
  the table (skipping with a warning if it isn't there yet) then PUTs the
  rule. RULE_IDs are held in Terraform state so re-applies upgrade in place.

## Observability tip

Maison Miró streams its `[EVENT]` lines to the workspace via Container Apps'
default `ContainerAppConsoleLogs_CL` table. The base filter the AISOC agents
use (and the one to start with for any manual exploration):

```kusto
ContainerAppConsoleLogs_CL
| where ContainerName_s == "maison-miro"
| where Log_s startswith "[EVENT] "
| extend e = parse_json(substring(Log_s, 8))
| project TimeGenerated, type = e.type, severity = e.severity,
          source_ip = e.source_ip, message = e.message
```

That gets you every security-relevant event from the store in structured
form. Incidents correlate by `source_ip`. See the agent KB
`company-context/13-maison-logging.md` for the full event/attack catalogue.
