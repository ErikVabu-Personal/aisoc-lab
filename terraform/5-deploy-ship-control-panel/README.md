# Phase 5 — Ship Control Panel (Next.js) on Azure Container Apps

This phase deploys the `ship-control-panel/` Next.js demo app as an Azure Container App.

## Build & publish the image (GitHub Actions)

This repo's workflow builds/pushes:
- `ghcr.io/erikvabu-personal/aisoc-ship-control-panel:latest`
- `ghcr.io/erikvabu-personal/aisoc-ship-control-panel:<GITHUB_SHA>`

Run:
- GitHub → Actions → **Build + Publish AISOC Runner (GHCR)** (includes ship-control-panel image build)

## Deploy

```bash
cd terraform/5-deploy-ship-control-panel
cp terraform.tfvars.example terraform.tfvars
terraform init
terraform apply
```

Output:
- `ship_control_panel_url`

## Notes
- This is a demo-only hardcoded login gate. Do not use as production auth.
- Next.js is built with `output: 'standalone'` for container deployment.
