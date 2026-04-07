# AI SOC Lab (Sentinel + Azure AI SOC Gateway)

This repository deploys a small **Microsoft Sentinel lab** plus an **AI/SOC tool gateway** (Azure Function) that can:

- Run **KQL** queries against Log Analytics
- List / get / update **Sentinel incidents** via ARM

It is split into two Terraform phases:

- **Phase 1**: Sentinel + VM + AMA + DCR (+ optional MDE onboarding)
- **Phase 2**: SOC Gateway Function + Key Vault + RBAC

> Notes from the build:
> - App Service quota constraints are common (especially in West US). Phase 2 supports a region override.
> - Python Azure Functions packaging needs dependencies to be built on Linux; we use a GitHub Action to build+deploy.

---

## Prerequisites

- Terraform >= 1.6
- Azure CLI (`az`) logged in to the target subscription
- Git

Optional but recommended:
- GitHub CLI (`gh`)

---

## Repo layout

- `terraform/1-deploy-sentinel/` — Phase 1
- `terraform/2-deploy-aisoc/` — Phase 2
- `.github/workflows/deploy-soc-gateway.yml` — builds and deploys the Function code (Linux build)

---

## Phase 1 — Deploy Sentinel baseline

### 1) Configure tfvars

Copy the example file:

```bash
cd terraform/1-deploy-sentinel
cp terraform.tfvars.example terraform.tfvars
```

Edit at minimum:

- `admin_password`
- `allowed_rdp_cidr` (or leave auto-detect on)

### 2) Apply

```bash
terraform init
terraform apply
```

### 3) Verify logs arrive

In Log Analytics (or Sentinel → Logs), validate:

```kusto
Heartbeat | take 5

Event
| where TimeGenerated > ago(1h)
| summarize count() by EventLog
```

> Tip: Security events require Level 4 (Information). Phase 1 DCR is configured to include it.

---

## Optional — MDE onboarding (lab)

Phase 1 supports automated **MDE onboarding** using:

- a Key Vault secret (created by Terraform)
- VM Run Command (PowerShell)

### How it works

1) Download `onboarding.cmd` from the Defender portal (tenant specific)
2) Place it next to the Phase 1 Terraform:
   - `terraform/1-deploy-sentinel/onboarding.cmd`
3) Point Terraform at it:

In `terraform/1-deploy-sentinel/terraform.tfvars`:

```hcl
enable_defender_for_endpoint = true
mde_onboarding_secret_name   = "MDE-ONBOARD"
mde_onboarding_script_path   = "./onboarding.cmd"
```

Then:

```bash
terraform apply
```

### Confirm MDE on the VM

Run on the VM:

```powershell
Get-Service Sense
Test-Path "HKLM:\SOFTWARE\Microsoft\Windows Advanced Threat Protection"
```

### Confirm MDE in portal

- Devices inventory: https://security.microsoft.com/machines
- Onboarding page: https://security.microsoft.com/securitysettings/endpoints/onboarding

> Note: Sentinel's Defender connector can require tenant consent/licensing.

---

## Phase 2 — Deploy SOC Gateway + Foundry Hub/Project (Terraform)

Phase 2 reads Phase 1 outputs from local state (`../1-deploy-sentinel/terraform.tfstate`).

Phase 2 provisions:

- SOC Gateway **Azure Function App** + supporting resources (Storage, App Service Plan)
- **Key Vault** (for provider secrets)
- RBAC for the Function MI to query Log Analytics and interact with Sentinel
- Azure AI Foundry **Hub/Account** (via AzAPI)

> Note: Foundry *Project* creation is performed via a script (below) to match Azure Portal behavior.

### 1) Configure tfvars

Copy:

```bash
cd terraform/2-deploy-aisoc
cp terraform.tfvars.example terraform.tfvars
```

Important settings:

- `function_plan_sku` — pick a SKU you have quota for (e.g. `EP1`)
- `location_override` — optional: deploy Phase 2 in another region if App Service quota is blocked
- `foundry_location` — **recommended** to set explicitly (Foundry enablement differs by region)

Example (common in restricted subscriptions):

```hcl
# App Service / Functions region (quota-driven)
location_override = "westcentralus"
function_plan_sku = "EP1"

# Foundry region (capability-driven)
foundry_location = "westus"
```

Model settings (used later by agent deployment scripts):

```hcl
foundry_model_choice          = "gpt-4.1-mini"
foundry_model_deployment_name = "gpt-4.1-mini"
```

> Note: `foundry_hub_name` and `foundry_project_name` are optional and will auto-generate with a random suffix.

### 2) Apply

```bash
terraform init
terraform apply
```

> Note: If you pulled new changes to this repo (or switched branches), re-run `terraform init`
> to pick up any new providers (Phase 2 uses password generation for gateway keys).

Terraform outputs include:

- `soc_gateway_function_name`
- `key_vault_uri`
- `foundry_hub_name`, `foundry_project_name`
- `foundry_account_id`

### 3) Create/update the Foundry Project (recommended)

In some tenants, creating Foundry Projects via Terraform/AzAPI can fail with a misleading
managed identity error even when identity is enabled. The Azure Portal succeeds because it uses
API version `2026-01-15-preview` and includes additional required fields.

To keep Phase 2 reliable, use the helper script after `terraform apply`.

First, set the Phase 1 resource group name (Phase 2 uses the same RG as Phase 1):

```bash
RG=$(terraform -chdir=../1-deploy-sentinel output -raw resource_group 2>/dev/null || echo "rg-sentinel-test")
```

Then run:

```bash
python3 scripts/deploy_foundry_project.py \
  --tfstate terraform/2-deploy-aisoc/terraform.tfstate \
  --resource-group "$RG"
```

What it does:
- Uses ARM `Microsoft.CognitiveServices/accounts/projects` with `api-version=2026-01-15-preview`
- Sends required fields: `location`, `identity=SystemAssigned`, `properties.displayName/description`

### 4) Verify Project provisioning

```bash
SUB=$(az account show --query id -o tsv)
RG=rg-sentinel-test
HUB=$(terraform -chdir=terraform/2-deploy-aisoc output -raw foundry_hub_name)
PROJ=$(terraform -chdir=terraform/2-deploy-aisoc output -raw foundry_project_name)

az rest --method get \
  --url "https://management.azure.com/subscriptions/$SUB/resourceGroups/$RG/providers/Microsoft.CognitiveServices/accounts/$HUB/projects/$PROJ?api-version=2026-01-15-preview" \
  -o jsonc | jq -r '.properties.provisioningState'
```

Expected: `Succeeded`

---

## Deploy the Function code (GitHub Actions)

We deploy the Python Function code via GitHub Actions because the dependencies must be built on Linux.

### 1) Create an Azure service principal for GitHub Actions

Run (example scope: subscription):

```bash
az ad sp create-for-rbac \
  --name "aisoc-lab-gha" \
  --role Contributor \
  --scopes /subscriptions/<SUBSCRIPTION_ID> \
  --sdk-auth
```

Copy the JSON output.

### 2) Add GitHub secret

Repo → Settings → Secrets and variables → Actions → **New repository secret**:

- Name: `AZURE_CREDENTIALS`
- Value: the JSON from above

### 3) Run the workflow

GitHub → Actions → **Deploy SOC Gateway Function** → Run workflow:

Inputs:

- `function_app_name`: (Terraform output) e.g. `func-foundry-soc-vhbk75`
- `resource_group`: e.g. `rg-sentinel-test`

---

## Smoke tests (Gateway)

### Gateway auth keys (read vs write)

The SOC gateway supports a simple extra auth layer on top of the Function key:

- `AISOC_READ_KEY` — required for read endpoints (KQL + incident list/get)
- `AISOC_WRITE_KEY` — required for write endpoints (incident update)

**Default behavior (recommended):** Phase 2 Terraform generates random keys, stores them in **Key Vault**,
and injects them into the Function App via **Key Vault references**.

Terraform outputs the secret names:

- `aisoc_read_key_secret_name`
- `aisoc_write_key_secret_name`

To retrieve a key value (example):

```bash
KV_URI=$(terraform -chdir=terraform/2-deploy-aisoc output -raw key_vault_uri)
az keyvault secret show --id "${KV_URI}secrets/$(terraform -chdir=terraform/2-deploy-aisoc output -raw aisoc_read_key_secret_name)" --query value -o tsv
```

Pass them on requests as:

- header: `x-aisoc-key: <key>`
  -or-
- query param: `?aisoc_key=<key>`

You still need the standard Function key (`?code=<function-key>`).

Get a **Function key**:

Function App → Functions → `SOCGateway` → Function Keys

### KQL

```bash
curl -sS -X POST \
  "https://<FUNCTION_APP>.azurewebsites.net/api/kql/query?code=<KEY>" \
  -H "Content-Type: application/json" \
  -d '{"query":"Heartbeat | take 5","timespan":"PT1H"}'
```

### Sentinel incidents

```bash
curl -sS \
  "https://<FUNCTION_APP>.azurewebsites.net/api/sentinel/incidents?code=<KEY>"
```

---

## Destroy / recreate notes (important)

Azure AI / Cognitive Services resources can be "soft-deleted" and/or reserve certain names for a period
of time. If you `terraform destroy` and immediately recreate:

- You may hit errors requiring **restore** of a deleted account name.
- You may hit `CustomDomainInUse` for `customSubDomainName`.

This repo avoids most of that by generating a unique `customSubDomainName`, but if you still get stuck,
force new random names by tainting the random generators in Phase 2:

```bash
cd terraform/2-deploy-aisoc
terraform taint random_string.suffix
terraform taint random_string.cs_subdomain
terraform apply
```

---

## Troubleshooting

### App Service Plan quota errors

If Phase 2 fails creating the App Service Plan with a quota error:

- Pick a different SKU (`function_plan_sku`) and/or
- Deploy Phase 2 to a region where App Service quota is available (`location_override`)

### Function returns 404

The gateway uses a catch-all route: `/api/{*route}`.
Verify the function exists:

```bash
az functionapp function list -g rg-sentinel-test -n <FUNCTION_APP> -o table
```

### Function returns 500 (ImportError / GLIBC)

This typically means dependencies were built on an incompatible runtime.
Use the GitHub Action (Linux build).

---

## Phase 3 — AISOC agents (Microsoft Agent Framework)

This repo is moving toward **Microsoft Agent Framework (MAF)** for the agent runtime/orchestration.
The SOC Gateway remains the tool surface (KQL + Sentinel incidents).

See: `maf/README.md`.

### Quick start (deterministic plumbing test)

Configure environment variables:

- `AISOC_GATEWAY_BASE_URL` e.g. `https://<functionapp>.azurewebsites.net/api`
- `AISOC_FUNCTION_CODE` (Function key)
- `AISOC_READ_KEY`
- `AISOC_WRITE_KEY`

Run:

```bash
cd maf
python3 -m pip install -e .
aisoc triage <INCIDENT_ID>
```

This currently returns a deterministic triage result while we wire in the LLM + MAF workflows.

---

## Next step

- Implement LLM-backed MAF agents (triage/investigator/reporter) calling the gateway.
- Add OpenTelemetry traces so PixelAgents can visualize agent activity.
