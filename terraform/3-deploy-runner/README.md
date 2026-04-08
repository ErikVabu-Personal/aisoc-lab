# Phase 3 — Deploy AISOC Runner (Azure Container Apps)

This phase deploys the AISOC Runner service (function tool executor) as an Azure Container App.

The runner executes tool calls against the SOCGateway using:
- Function key (code=...)
- AISOC read/write keys

It exposes a public endpoint secured by the runner token (same value):
- `x-aisoc-runner-key: <RUNNER_BEARER_TOKEN>` (recommended for Foundry OpenAPI tool)
- `Authorization: Bearer <RUNNER_BEARER_TOKEN>` (supported)

## Prereqs

- Phase 1 + Phase 2 deployed
- Container image built and published (see GitHub Actions workflow)

## Deploy

> Important: the GitHub Action workflow **Build + Publish AISOC Runner (GHCR)** only builds/pushes the image.
> It does **not** update the running Container App. For deterministic demos, deploy by commit SHA tag.

```bash
cd terraform/3-deploy-runner
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform apply
```

Outputs:
- `runner_url`
- `runner_bearer_token_secret_name`
