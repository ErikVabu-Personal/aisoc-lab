# Foundry SOC integration (Agentic Framework) — Terraform + Python

This folder complements the `azure-sentinel-test` stack by adding:

- An Azure Function App (`soc_gateway`) that acts as a tool gateway for SOC agents.
- Azure Key Vault to store external provider API keys (OpenRouter).
- RBAC grants so the function can query Log Analytics and interact with Sentinel.

Agent definitions + workflow orchestration are deployed via a Python script (to be added) because agent resources evolve faster than Terraform providers.

## Why a Function gateway?

- Centralized auth (Managed Identity)
- Centralized policy/rate-limiting
- Keeps secrets out of agent prompts/config

## Next steps

- Implement Function endpoints:
  - `POST /kql/query`
  - `GET /sentinel/incidents`
  - `GET /sentinel/incidents/{id}`
  - `PATCH /sentinel/incidents/{id}`
  - `POST /llm/openrouter` (optional)

- Implement `scripts/deploy_agents.py` to create/update agents in Azure AI Foundry.

## Deploying the Function code

This repo includes a minimal Azure Functions Python project under `foundry/function_app/`.

Recommended deployment for this test stack:

```bash
cd terraform/azure-sentinel-test/foundry/function_app
# Create a zip (from inside function_app so host.json is at root)
zip -r function_app.zip .
# Deploy (requires Azure CLI logged in)
az functionapp deployment source config-zip \
  --resource-group <rg> \
  --name <function_app_name> \
  --src function_app.zip
```

Find `<function_app_name>` from Terraform output `soc_gateway_function_name`.

## Calling the API

All endpoints use Azure Functions `authLevel=function`.
You can retrieve a function key in the Portal (Function App -> Functions -> SOCGateway -> Function Keys), then call:

- `POST https://<app>.azurewebsites.net/api/kql/query?code=<key>`
- `GET  https://<app>.azurewebsites.net/api/sentinel/incidents?code=<key>`
