# Phase 3 scripts (3-deploy-pixelagents-web)

After deploying PixelAgents Web with Terraform, configure the AISOC Runner to emit telemetry events to it:

```bash
./scripts/configure_runner_pixelagents_env.sh
```

This sets Runner env vars:
- `PIXELAGENTS_URL` = `<pixelagents_url>/events`
- `PIXELAGENTS_TOKEN` = secretref to a Container App secret

Then, when agents call tools via the runner, PixelAgents Web will visualize activity.
