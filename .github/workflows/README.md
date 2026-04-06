# GitHub Actions

## Deploy SOC Gateway Function

Workflow: **Deploy SOC Gateway Function** (`deploy-soc-gateway.yml`)

### Requirements

Add a GitHub Actions secret:

- `AZURE_CREDENTIALS` — JSON output from:

```bash
az ad sp create-for-rbac \
  --name "aisoc-lab-gha" \
  --role Contributor \
  --scopes /subscriptions/<SUBSCRIPTION_ID> \
  --sdk-auth
```

(You can scope it tighter to the resource group once it exists.)

### Run

In GitHub → Actions → Deploy SOC Gateway Function → Run workflow:

- `function_app_name`: e.g. `func-foundry-soc-vhbk75`
- `resource_group`: e.g. `rg-sentinel-test`

The workflow builds a zip with Python dependencies and deploys it via `az functionapp deployment source config-zip`.
