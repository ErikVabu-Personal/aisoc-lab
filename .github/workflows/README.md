# GitHub Actions

Each deployable artifact has its own workflow. They all share a single
service principal (stored as `AZURE_CREDENTIALS`) and read deploy targets
from repository variables so push-on-`main` is enough to deploy.

| Workflow | Builds | Triggers on changes to |
| --- | --- | --- |
| `deploy-aisoc-orchestrator.yml` | Orchestrator Function App (zip deploy) | `terraform/2-deploy-aisoc/orchestrator/function_app/**` |
| `deploy-soc-gateway.yml` | SOC Gateway Function App (zip deploy) | `terraform/2-deploy-aisoc/foundry/function_app/**` |
| `deploy-aisoc-runner.yml` | Runner image → GHCR + force-roll Container App | `runner/**` |
| `deploy-pixelagents-web.yml` | PixelAgents Web image → GHCR + force-roll Container App | `pixelagents_web/**` |
| `deploy-ship-control-panel.yml` | Ship Control Panel image → GHCR + force-roll Container App | `ship-control-panel/**` |

All five also support manual `workflow_dispatch`.

## One-time setup

### 1. Service principal

Create a service principal with Contributor on the demo resource group
(or a tighter scope) and store the JSON in a repo secret named
`AZURE_CREDENTIALS`:

```bash
az ad sp create-for-rbac \
  --name "aisoc-lab-gha" \
  --role Contributor \
  --scopes /subscriptions/<SUBSCRIPTION_ID>/resourceGroups/<RG_NAME> \
  --sdk-auth
```

The same SP is reused by every workflow — no need to create separate ones.

### 2. Repository variables

Set these once in **Settings → Secrets and variables → Actions →
Variables** so the workflows know which Azure resources to deploy to:

| Variable | Used by | Example |
| --- | --- | --- |
| `AISOC_RESOURCE_GROUP` | every workflow | `rg-sentinel-test` |
| `AISOC_ORCHESTRATOR_FUNCTION_NAME` | orchestrator workflow | `func-aisoc-orch-vhbk75` |
| `AISOC_SOC_GATEWAY_FUNCTION_NAME` | gateway workflow | `func-foundry-soc-vhbk75` |
| `AISOC_RUNNER_NAME` | runner workflow + gateway post-deploy hook | `aisoc-runner` |
| `AISOC_PIXELAGENTS_NAME` | pixelagents workflow | `aisoc-pixelagents` |
| `AISOC_SHIP_CONTROL_PANEL_NAME` | ship-cp workflow | `aisoc-ship-control-panel` |

If a workflow runs without its required variables set, it logs a warning
and skips the force-roll step (the build/push to GHCR still happens).

## Post-apply wiring

A few env vars on the Function Apps and Container Apps are wired by
shell scripts because the values are runtime-computed (function host
keys, Phase-3 Pixelagents URL/token). They are run automatically:

- **From `terraform apply`** — `null_resource` provisioners in
  `terraform/2-deploy-aisoc/post_apply_scripts.tf` and
  `terraform/3-deploy-pixelagents-web/post_apply_scripts.tf` run them on
  every apply.
- **From the SOC Gateway workflow** — re-runs
  `configure_runner_socgateway_key.sh` after each gateway zip-deploy,
  because a function-code redeploy can rotate the function key.

The scripts are idempotent and accept either env vars (CI / Terraform)
or `terraform output` (local dev) for their inputs.
