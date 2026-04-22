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
> Terraform can attempt project creation via AzAPI, but it is **disabled by default** because it can
> fail with misleading managed identity errors.

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

## Phase 3 — Deploy the SOCGateway Function code (GitHub Actions)

Phase 2 creates the **Function App infrastructure**, but the app will have **no functions** until you deploy
code.

We deploy the Python Function code via GitHub Actions because the dependencies must be built on Linux.

### 1) Create an Azure service principal for GitHub Actions

Run (example scope: subscription):

```bash
SUB=$(az account show --query id -o tsv)

az ad sp create-for-rbac \
  --name "aisoc-lab-gha" \
  --role Contributor \
  --scopes "/subscriptions/$SUB" \
  --sdk-auth
```

Copy the JSON output.

### 2) Add GitHub secret

Repo → Settings → Secrets and variables → Actions → **New repository secret**:

- Name: `AZURE_CREDENTIALS`
- Value: the JSON from above

### 3) Run the workflow

First, confirm whether code is already deployed. If this returns no rows, you must deploy:

```bash
RG=$(terraform -chdir=terraform/1-deploy-sentinel output -raw resource_group 2>/dev/null || echo "rg-sentinel-test")
FUNC=$(terraform -chdir=terraform/2-deploy-aisoc output -raw soc_gateway_function_name)

az functionapp function list -g "$RG" -n "$FUNC" -o table
```

Then deploy:

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

## Phase 4 — AISOC agents (Microsoft Agent Framework)

This repo is moving toward **Microsoft Agent Framework (MAF)** for the agent runtime/orchestration.
The SOC Gateway remains the tool surface (KQL + Sentinel incidents).

See: `maf/README.md`.

### Quick start (deterministic plumbing test)

Configure environment variables:

- `AISOC_GATEWAY_BASE_URL` e.g. `https://<functionapp>.azurewebsites.net/api`
- `AISOC_FUNCTION_CODE` (Function key)
- `AISOC_READ_KEY`
- `AISOC_WRITE_KEY`

Recommended: auto-load these from Terraform outputs + Azure CLI:

```bash
eval "$(./scripts/aisoc_env.sh)"
```

Run:

```bash
cd maf

# Debian/Ubuntu note: avoid installing into system Python (PEP 668).
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -U pip
pip install -e .

python -m aisoc_maf.cli triage <INCIDENT_ID>
```

This currently returns a deterministic triage result while we wire in the LLM + MAF workflows.

---

## Phase 4 — AISOC agents (Microsoft Agent Framework)

This repo includes a local MAF-based agent harness under `maf/` (useful for development/testing).

## Phase 4 — Deploy AISOC Runner (Azure Container Apps) + Foundry Tool (manual)

This phase deploys the **AISOC Runner** (a small FastAPI service) to Azure Container Apps.
Foundry uses the runner as an **OpenAPI Tool**, and the runner calls the SOCGateway Function.

**Why it exists:** Foundry Agent Service won’t reliably execute arbitrary HTTP tools the way MCP would.
The runner provides a stable tool surface (OpenAPI) and performs the outbound calls.

### 4.1 Build & publish the runner image (GitHub Actions)

The workflow **Build + Publish AISOC Runner (GHCR)** builds/pushes a container image to GHCR.
It does **not** deploy/update your Container App automatically.

It publishes two tags:
- `ghcr.io/erikvabu-personal/aisoc-runner:latest`
- `ghcr.io/erikvabu-personal/aisoc-runner:<GITHUB_SHA>`

To build/publish:
- GitHub → Actions → **Build + Publish AISOC Runner (GHCR)** → Run workflow

### 4.2 Deploy runner infrastructure (Terraform)

```bash
cd terraform/3-deploy-runner
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform apply
```

Terraform outputs:
- `runner_url`
- `runner_bearer_token_secret_name` (stored in Key Vault)

### 4.3 Deploy/update the running Container App to a specific image tag (manual)

**Important:** Azure Container Apps may keep running an older image behind `:latest`.
For demos, deploy by **commit SHA tag** (recommended).

1) Get the latest runner image SHA tag from the GitHub Actions run (the commit SHA you want).

2) Update the container app to that SHA tag:

```bash
RG=$(terraform -chdir=terraform/1-deploy-sentinel output -raw resource_group 2>/dev/null || echo "rg-sentinel-test")
APP=$(terraform -chdir=terraform/3-deploy-runner output -raw runner_container_app_name 2>/dev/null || echo "ca-aisoc-runner-e7r54h")
SHA=<GITHUB_SHA>

az containerapp update -g "$RG" -n "$APP" \
  --image "ghcr.io/erikvabu-personal/aisoc-runner:${SHA}"
```

If you only have `:latest`, you can update to latest, but prefer SHA for determinism:

```bash
az containerapp update -g "$RG" -n "$APP" \
  --image "ghcr.io/erikvabu-personal/aisoc-runner:latest"
```

### 4.4 Create the Foundry OpenAPI Tool(s) (manual)

In Azure AI Foundry, create **three** OpenAPI tools (one per agent) so PixelAgents can attribute events correctly.

Use these schema files:
- Triage tool: `runner/openapi.triage.yaml`
- Investigator tool: `runner/openapi.investigator.yaml`
- Reporter tool: `runner/openapi.reporter.yaml`

Each schema includes a required header `x-aisoc-agent` with a default value (triage/investigator/reporter).

For each tool:
1) Go to **Tools** → **Create tool** → **OpenAPI**
2) Paste the OpenAPI spec (YAML format)
3) Replace the server URL:
   - `https://REPLACE_ME` → your `runner_url` (Terraform output)
4) Configure authentication:
   - Type: **API key**
   - Location: **Header**
   - Header name: `x-aisoc-runner-key`
   - Value: the runner token (from Key Vault secret `runner_bearer_token_secret_name`)

Notes:
- Foundry requires `operationId` for each endpoint (included in these schemas).
- You do not need to re-import the tool for every runner code change unless endpoints/auth changed.

### 4.5 Validate the tool end-to-end (manual)

With the tool attached to an agent, run:
- `POST /tools/execute` with:

```json
{ "tool_name": "list_incidents", "arguments": {} }
```

Then:

```json
{ "tool_name": "get_incident", "arguments": { "incidentNumber": 1 } }
```

And (writes enabled):

```json
{ "tool_name": "update_incident", "arguments": { "incidentNumber": 1, "properties": { "status": "Closed" } } }
```

---

## Phase 5 — Deploy Foundry Agents (Agent Service)

> Note: The legacy Terraform phase folder `terraform/5-deploy-ship-control-panel/` has been removed.
> Ship Control Panel is deployed as part of Phase 1 (`terraform/1-deploy-sentinel/ship_control_panel.tf`).

If you want the agents to run inside **Azure AI Foundry Agent Service**, deploy them with the script below.

Prereqs:
- Azure CLI logged in
- Foundry project exists
- Model deployment exists (deployment name)
- SOCGateway deployed and working
- Runner deployed and Foundry Tool created

Load gateway/function keys into your shell:

```bash
eval "$(./scripts/aisoc_env.sh)"
```

Deploy agents:

```bash
python3 scripts/deploy_foundry_agents.py \
  --project-url "https://<your-host>.services.ai.azure.com/api/projects/<projectName>" \
  --model-deployment "gpt-5.4-mini"
```

Attach write tool (dangerous) only when you explicitly enable it:

```bash
python3 scripts/deploy_foundry_agents.py \
  --project-url "https://<your-host>.services.ai.azure.com/api/projects/<projectName>" \
  --model-deployment "gpt-5.4-mini" \
  --enable-writes
```

By default, agents are named with prefix `foundry-aisoc-*`.

---

## Phase 6 — PixelAgents Web (Foundry/Runner telemetry → Pixel Agents UI)

This repo deploys a standalone Pixel Agents-style web UI (Azure Container Apps) that is driven by AISOC Runner telemetry.

Current implementation notes:
- PixelAgents Web is a FastAPI service (`pixelagents_web/`) deployed to ACA.
- It serves the Pixel Agents webview UI build (vendored into `pixelagents_web/app/ui_dist/`).
- A small adapter polls `GET /api/agents/state` and dispatches Pixel Agents-style `postMessage` events.
- Movement/seat behavior is still WIP (desk ↔ lounge anchoring); see "Known issues" below.

Pixel Agents (upstream) is a VS Code extension today. For this demo we deploy a minimal **PixelAgents-style web app**
that visualizes AISOC agent activity based on **runner telemetry only**.

### 6.1 Build & publish the PixelAgents Web image (GitHub Actions)

A GitHub Actions job builds/pushes the container image:
- `ghcr.io/erikvabu-personal/aisoc-lab-pixelagents-web:latest`
- `ghcr.io/erikvabu-personal/aisoc-lab-pixelagents-web:<GITHUB_SHA>`

Run:
- GitHub → Actions → **Build + Publish AISOC Runner (GHCR)**

Important:
- Because we vendor the UI build output into `pixelagents_web/app/ui_dist/`, any UI changes require:
  1) running `npm run build` in `pixelagents_web/ui`
  2) copying output from `pixelagents_web/dist/webview/` → `pixelagents_web/app/ui_dist/`
  3) committing the updated `ui_dist/`
  4) rebuilding the container image

### 6.2 Deploy PixelAgents Web (Terraform)

```bash
cd terraform/4-deploy-pixelagents-web
terraform init
terraform apply
```

Outputs:
- `pixelagents_url`
- `pixelagents_token` (sensitive)

### 6.3 Wire AISOC Runner → PixelAgents Web (manual)

Set these environment variables on the **AISOC Runner** Container App:

- `PIXELAGENTS_URL` = `${pixelagents_url}/events`
- `PIXELAGENTS_TOKEN` = `${pixelagents_token}`

Now, every call to `POST /tools/execute` will emit:
- `tool.call.start`
- `tool.call.end`

Open the UI:
- `${pixelagents_url}/`

### 6.4 Troubleshooting PixelAgents Web

- If the UI is blank and DevTools shows 404s under `/assets/...`:
  - ensure you deployed a recent image (deploy by SHA tag)
  - PixelAgents Web serves UI assets at `/assets` and `/fonts`

- If you see tool events but agents do not appear:
  - verify `/api/agents/state` returns JSON with `triage/investigator/reporter`

### Known issues / WIP

- Lounge seating is not fully deterministic yet: triage reliably anchors to a sofa seat; investigator/reporter may still remain at desks.
  This is due to Pixel Agents seat assignment contention and timing; we have debug logs in recent builds.

---

## Demo runbook (Foundry triage → investigator → reporter)

This is a practical checklist to run the demo live.

### A) One-time setup (before demo day)

1) Deploy Phase 1 + Phase 2 + SOCGateway code (above)
2) Deploy runner (Phase 4) and create the Foundry OpenAPI Tool
3) Create (or deploy) three Foundry agents:
   - **Triage**
   - **Investigator**
   - **Reporter**
4) Attach the **AISOC Runner Tool** to all three agents
5) Decide whether you allow writes:
   - For a closure demo: set runner `ENABLE_WRITES=1`

### B) Configure “scheduled triage” (manual)

Foundry UI varies, but the concept is the same: configure a schedule/job that runs the triage agent prompt every minute.

1) Open the **Triage agent**
2) Find **Schedule / Job / Automations** (depending on your Foundry build)
3) Create a schedule:
   - Frequency: **every 1 minute**
   - Prompt:

> "Check the Sentinel incident queue. Call the tool to list incidents. If there is a New incident, select the newest one, then call the tool to get full details for that incident (use incidentNumber or id). Summarize initial triage and hand off as suspicious to the Investigator agent with 2-3 concrete questions and suggested KQL. If there are no New incidents, output exactly: NO_NEW_INCIDENTS."

4) Save and enable the schedule

**Tip:** For demos, consider disabling the schedule right before presenting, then enabling it on stage so the audience sees it “come alive”.

### C) Live demo flow

1) Trigger / wait for triage to pick up an incident
2) Triage produces:
   - short summary
   - why suspicious
   - the incident identifier (incidentNumber or GUID)
   - 2–3 suggested KQL checks
3) Investigator agent:
   - fetches incident details
   - runs up to 3 KQL queries
   - produces a conclusion (TP/FP/inconclusive)
   - if inconclusive: asks the human for a decision
4) Reporter agent:
   - drafts the ticket in a structured format
   - writes a closure/update back to Sentinel via `update_incident`

### D) Verification checklist (right before demo)

- Runner reachable:
  - `GET $RUNNER_URL/healthz` returns `{"ok":"true"}`
- Tool auth works:
  - `POST /tools/execute` with `list_incidents` succeeds
- Deep incident fetch works:
  - `get_incident` works with both `incidentNumber` and a full ARM resource id
- Writes (if enabled):
  - `update_incident` can set `status` to `Closed`

---

## Next step

- Add a "Reporter" patch template (exact Sentinel fields) once we standardize which properties are writable in your tenant.
- Add Foundry/Runner telemetry extraction for PixelAgents.
