# Phase 4 — Deploy PixelAgents Web (Azure Container Apps)

This phase deploys a minimal PixelAgents-style web UI to visualize AISOC activity.

- Public UI: `GET /`
- Ingest endpoint (protected): `POST /events` with header `x-pixelagents-token`

## Deploy

```bash
cd terraform/3-deploy-pixelagents-web
terraform init
terraform apply
```

Outputs:
- `pixelagents_url`
- `pixelagents_token` (sensitive)

## Wire AISOC Runner → PixelAgents Web

Set these env vars on the **AISOC Runner** container app:

- `PIXELAGENTS_URL` = `${pixelagents_url}/events`
- `PIXELAGENTS_TOKEN` = `${pixelagents_token}`

Then any `/tools/execute` call will emit start/end events.
