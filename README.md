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
- Azure AI Foundry **Hub/Account** + **Project** (via AzAPI)

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

Terraform outputs include:

- `soc_gateway_function_name`
- `key_vault_uri`
- `foundry_hub_name`, `foundry_project_name`
- `foundry_account_id`

> Note: In some tenants, creating Foundry Projects via Terraform/AzAPI can fail with a misleading
> managed identity error even when identity is enabled. If that happens, use the helper script
> below to create/update the project via the same API version/payload shape the Azure Portal uses.

### 3) (If needed) Create/update the Foundry Project via script

```bash
python3 scripts/deploy_foundry_project.py \
  --tfstate terraform/2-deploy-aisoc/terraform.tfstate \
  --resource-group rg-sentinel-test
```

This uses ARM `Microsoft.CognitiveServices/accounts/projects` with API version `2026-01-15-preview`
and includes required fields (location + identity + displayName/description).

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

Set them as Function App settings (Portal → Function App → Configuration):

- `AISOC_READ_KEY` = some random string
- `AISOC_WRITE_KEY` = some random string

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

## Phase 3 — Deploy Foundry agents (script)

Agent resources evolve faster than Terraform providers, so we deploy them via script.

### 1) Run the agent deployment stub

After Phase 2 completes:

```bash
python3 scripts/deploy_agents.py --tfstate terraform/2-deploy-aisoc/terraform.tfstate
```

This prints the resolved config (Foundry hub/project + gateway) and validates required settings.

### 2) Next iterations

- Implement creation/update of 3 agents:
  - Triage
  - Investigator
  - Reporter
- Wire agent tools to SOC Gateway endpoints:
  - `POST /api/kql/query`
  - `GET /api/sentinel/incidents`
  - `GET /api/sentinel/incidents/{id}`
  - `PATCH /api/sentinel/incidents/{id}`

---

## Next step

- Deploy Foundry agents and point their tools at the gateway endpoints.
- (Planned) Visualize agent activity using PixelAgents fed by Foundry telemetry.
