# Phase 3 — Deploy AISOC Runner (Azure Container Apps)

This phase deploys the AISOC Runner service (function tool executor) as an Azure Container App.

The runner executes tool calls against the SOCGateway using:
- Function key (code=...)
- AISOC read/write keys

It exposes a public endpoint secured by:
- `Authorization: Bearer <RUNNER_BEARER_TOKEN>`

## Prereqs

- Phase 1 + Phase 2 deployed
- Container image built and published (see GitHub Actions workflow)

## Deploy

```bash
cd terraform/3-deploy-runner
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform apply
```

Outputs:
- `runner_url`
- `runner_bearer_token_secret_name`
