# GitHub Actions

Each deployable artifact has its own workflow. They all authenticate to
Azure via **OIDC federated credentials** (no long-lived secrets — safe
for a public repo) and read deploy targets from repository variables so
push-on-`main` is enough to deploy.

| Workflow | Builds | Triggers on changes to |
| --- | --- | --- |
| `deploy-aisoc-orchestrator.yml` | Orchestrator Function App (zip deploy) | `terraform/2-deploy-aisoc/orchestrator/function_app/**` |
| `deploy-soc-gateway.yml` | SOC Gateway Function App (zip deploy) | `terraform/2-deploy-aisoc/foundry/function_app/**` |
| `deploy-aisoc-runner.yml` | Runner image → GHCR + force-roll Container App | `runner/**` |
| `deploy-pixelagents-web.yml` | PixelAgents Web image → GHCR + force-roll Container App | `pixelagents_web/**` |
| `deploy-ship-control-panel.yml` | Ship Control Panel image → GHCR + force-roll Container App | `ship-control-panel/**` |

All five also support manual `workflow_dispatch`.

## One-time setup

### 1. OIDC federated credential (handled by `aisoc_demo.sh`)

The deploy script's "OIDC bootstrap" step creates everything needed:

1. an Azure AD app + service principal `aisoc-lab-gha`
2. a federated credential pinning the trust to
   `repo:ErikVabu-Personal/aisoc-lab:ref:refs/heads/main`
3. a subscription-scoped Contributor role assignment
4. three repo variables: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`,
   `AZURE_SUBSCRIPTION_ID` (publicly visible — they're identifiers,
   not secrets)

This means the workflows hold no `clientSecret` — they get a 5-minute
JWT from GitHub on each run, exchange it for a short-lived Azure token,
and that's it. Forks and other branches can't authenticate because the
federated credential's `subject` won't match.

To bootstrap manually instead of via the deploy script:

```bash
APP_ID=$(az ad app create --display-name aisoc-lab-gha --query appId -o tsv)
az ad sp create --id "$APP_ID"
az ad app federated-credential create --id "$APP_ID" --parameters '{
  "name": "aisoc-lab-main",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:ErikVabu-Personal/aisoc-lab:ref:refs/heads/main",
  "audiences": ["api://AzureADTokenExchange"]
}'
SP_OBJ=$(az ad sp show --id "$APP_ID" --query id -o tsv)
az role assignment create --assignee-object-id "$SP_OBJ" \
  --assignee-principal-type ServicePrincipal --role Contributor \
  --scope "/subscriptions/$(az account show --query id -o tsv)"

gh variable set AZURE_CLIENT_ID       --body "$APP_ID"
gh variable set AZURE_TENANT_ID       --body "$(az account show --query tenantId -o tsv)"
gh variable set AZURE_SUBSCRIPTION_ID --body "$(az account show --query id -o tsv)"
```

To allow workflow_dispatch from another branch, add a second federated
credential with that branch's subject (`...refs/heads/<branch>`) or a
wildcard ref pattern.

### 2. Repository variables

Repo variables tell each workflow which Azure resources to deploy to.
**They're set automatically by `terraform apply`** — each phase has a
`null_resource` that pushes its outputs into GitHub via `gh variable
set`, so the names stay in sync with the (random-suffixed) Azure
resources without any manual setup.

The shell that runs `terraform apply` needs `gh` installed and
authenticated (`gh auth login`). If it isn't, the sync step logs a
warning and skips — Terraform doesn't fail.

Variables that get synced:

| Variable | Synced from | Used by |
| --- | --- | --- |
| `AISOC_RESOURCE_GROUP` | Phase 1 | every workflow |
| `AISOC_SHIP_CONTROL_PANEL_NAME` | Phase 1 | ship-cp workflow |
| `AISOC_RUNNER_NAME` | Phase 2 | runner workflow + gateway post-deploy hook |
| `AISOC_ORCHESTRATOR_FUNCTION_NAME` | Phase 2 | orchestrator workflow |
| `AISOC_SOC_GATEWAY_FUNCTION_NAME` | Phase 2 | gateway workflow |
| `AISOC_PIXELAGENTS_NAME` | Phase 3 | pixelagents workflow |

The default repo target is `ErikVabu-Personal/aisoc-lab`. To sync to a
fork, set the `github_repo` Terraform variable (in each phase's
`tfvars` file or via `-var`).

If a workflow runs before the variables are set (e.g. the very first
push, before any `terraform apply`), it logs a warning and skips the
force-roll step — the build + push to GHCR still happens, you'd just
need to roll the Container App manually that one time.

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
