# Phase 3 — PixelAgents Web

The operator UI for AISOC, deployed as a single Container App that
talks to the Foundry agents' API + the AISOC Runner + ARM. Single
FastAPI app, server-rendered HTML + small per-page JS modules, no
React build step.

For a tour of the pages, JS layout, and role gates, see the
**top-level README's "PixelAgents Web" section** — that's the
canonical reference. This README only covers the Phase 3 deploy
mechanics.

## What this phase deploys

```
terraform/3-deploy-pixelagents-web/
├─ main.tf                  — the Container App + its environment
├─ outputs.tf               — pixelagents_url, pixelagents_token, etc.
├─ variables.tf             — auth users, role roster, runner endpoint
├─ post_apply_scripts.tf    — null_resources that wire env vars
│                              after the app is up
└─ scripts/
    └─ configure_runner_pixelagents_env.sh
```

The image itself is built and pushed to GHCR by the
`deploy-pixelagents-web.yml` GitHub Actions workflow on every push
under `pixelagents_web/**`.

## What gets wired post-apply

The Runner needs to know the PixelAgents URL + token so it can
forward HITL questions, change proposals, and live-view events.
That wiring is value-driven by Phase 3 outputs, so it's done
post-apply by:

```
terraform/3-deploy-pixelagents-web/scripts/configure_runner_pixelagents_env.sh
```

The script is invoked automatically by a `null_resource` in
`post_apply_scripts.tf` on every apply. Inputs (Container App env
vars on the Runner):

- `PIXELAGENTS_URL`   = `<pixelagents_url>/events`
- `PIXELAGENTS_TOKEN` = secretref to a Container App secret holding
  the Phase 3 token

Both env vars are required by the Runner's HITL + change-proposal
paths. Without them, agent calls to `ask_human` or
`propose_change_to_*` return HTTP 503 with a clear error pointing
at this script.

## Manual re-wire (if the post-apply hook didn't run)

```bash
cd terraform/3-deploy-pixelagents-web
./scripts/configure_runner_pixelagents_env.sh
```

Idempotent. Safe to re-run anytime.

## Outputs

- `pixelagents_url` — the public URL (e.g.
  `https://aisoc-pixelagents-…azurecontainerapps.io`).
- `pixelagents_token` — sensitive; treated as a Container App secret
  on both the PixelAgents Web and the Runner.
- `pixelagents_name` — the Container App's resource name (used by
  the GHA workflow to roll a new revision).

## Deploy + destroy

```bash
# Standard path (handled by the top-level driver):
./aisoc_demo.sh deploy

# Or just this phase:
cd terraform/3-deploy-pixelagents-web
terraform init
terraform apply

# Tear down:
terraform destroy
```

Apply order: phase 1 → phase 2 → phase 3. Destroy order: phase 3 →
phase 2 → phase 1.
