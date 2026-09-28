# Maison Miró

This is the **Maison Miró** intentionally-vulnerable web store — the aisoc-lab web
victim (it replaced the Ship Control Panel). A single-file Flask/gunicorn app that
prints structured `[EVENT] {json}` security events to stdout, which Azure Container
Apps ships to Sentinel's `ContainerAppConsoleLogs_CL`.

> **This is the canonical copy.** Maison Miró exists only for this SOC demo, so it
> lives here in aisoc-lab — develop it **here**. A copy also sits in the standalone
> `maison-miro` repo (LAN Forgejo), but that repo now matters only as the home of the
> **frozen AWS fallback lab** (`infra/goad-demo/`, which zips + ships the app to an
> EC2 box). The AWS copy is not tracking this one and is not being changed. When the
> AWS fallback is retired, delete the standalone repo — Maison lives on here.

## Build / deploy

`.github/workflows/deploy-maison-miro.yml` builds this dir → `ghcr.io/erikvabu-personal/
aisoc-maison-miro:{latest,<sha>}` and force-rolls the Container App. Terraform
(`terraform/1-deploy-sentinel/maison_miro.tf`) runs it in the shared `cae-shipcp-*`
Container Apps environment on port 8000, single replica, with `SOC_KEY` / `SOC_ARMED`
/ `SIGN_SECRET`. (One-time: make the GHCR package public so the Container App can pull.)

See `terraform/2-deploy-aisoc/agents/company-context/13-maison-logging.md` for the
event schema + attack runbook the SOC agents use.
