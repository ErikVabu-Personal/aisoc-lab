# AI SOC Lab (Sentinel + Foundry)

This repo contains the Terraform lab environment used to deploy:

- Phase 1: Microsoft Sentinel baseline + Windows VM + Azure Monitor Agent + DCR
- Phase 2: AI SOC layer (SOC Tool Gateway Function + Key Vault + RBAC)

## Terraform phases

1) **Base Sentinel infrastructure**

```bash
cd terraform/1-deploy-sentinel
terraform init
terraform apply
```

2) **AI SOC layer**

```bash
cd terraform/2-deploy-aisoc
terraform init
terraform apply
```

## Notes

- Phase 2 reads Phase 1 state via `terraform_remote_state` (local backend), so run both phases from the same machine/checkout.
- Do not commit secrets or state files.
