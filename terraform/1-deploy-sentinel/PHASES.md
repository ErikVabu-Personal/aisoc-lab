# Phase 1 — 1-deploy-sentinel

This phase deploys the baseline Sentinel lab:

- Resource group + networking
- Log Analytics Workspace
- Microsoft Sentinel enablement
- Windows VM + Azure Monitor Agent + Data Collection Rule

Run:

```bash
cd terraform/1-1-deploy-sentinel
terraform init
terraform apply
```

Outputs are consumed by Phase 2 via `terraform_remote_state`.
