# Phase 2 — 2-deploy-aisoc

This phase deploys the AI/SOC components on top of the Sentinel lab (Phase 1):

- SOC Tool Gateway (Azure Function)
- Key Vault for model provider secrets
- RBAC for the Function managed identity

It reads Phase 1 outputs from `../1-deploy-sentinel/terraform.tfstate`.

Run:

```bash
cd terraform/2-2-deploy-aisoc
terraform init
terraform apply
```

If you see quota errors for Consumption plans, set:

```hcl
function_plan_sku = "B1" # or "S1"
```
