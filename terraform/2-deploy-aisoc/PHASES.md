# Phase 2 — 2-deploy-aisoc

This phase deploys the AI/SOC components on top of the Sentinel lab (Phase 1):

> Note on teardown speed: Key Vault deletions can be slow due to soft-delete retention.
> This stack reuses a shared Key Vault created in Phase 1 to keep Phase 2 teardowns fast.

- SOC Tool Gateway (Azure Function)
- Key Vault for model provider secrets
- RBAC for the Function managed identity

It reads Phase 1 outputs from `../1-deploy-sentinel/terraform.tfstate`.

Run:

```bash
cd terraform/2-deploy-aisoc
terraform init
terraform apply

# Deploy the SOCGateway Function code (Terraform only provisions the Function App infra)
./scripts/deploy_socgateway_function.sh

# Configure runner with SOCGateway function key (sets SOCGATEWAY_FUNCTION_CODE)
./scripts/configure_runner_socgateway_key.sh

# Deploy prompt agents wired to the runner OpenAPI tool
./scripts/deploy_prompt_agents_with_runner_tools.sh
```

If you see quota errors for Consumption plans, set:

```hcl
function_plan_sku = "B1" # or "S1"
```
