# Maison Miró (vendored)

This is the **Maison Miró** intentionally-vulnerable web store — the aisoc-lab web
victim (it replaced the Ship Control Panel). A single-file Flask/gunicorn app that
prints structured `[EVENT] {json}` security events to stdout, which Azure Container
Apps ships to Sentinel's `ContainerAppConsoleLogs_CL`.

> **Vendored copy.** The canonical source lives in the separate `maison-miro` repo
> (LAN Forgejo). It's vendored here because aisoc-lab builds its images on GitHub
> Actions → GHCR, which can't reach the LAN Forgejo. **This copy can drift** — when
> the upstream store changes, re-copy `app.py`, `templates/`, `static/`,
> `requirements.txt`, `Dockerfile`, `.dockerignore` here.

## Build / deploy

`.github/workflows/deploy-maison-miro.yml` builds this dir → `ghcr.io/erikvabu-personal/
aisoc-maison-miro:{latest,<sha>}` and force-rolls the Container App. Terraform
(`terraform/1-deploy-sentinel/maison_miro.tf`) runs it in the shared `cae-shipcp-*`
Container Apps environment on port 8000, single replica, with `SOC_KEY` / `SOC_ARMED`
/ `SIGN_SECRET`. (One-time: make the GHCR package public so the Container App can pull.)

See `terraform/2-deploy-aisoc/agents/company-context/13-maison-logging.md` for the
event schema + attack runbook the SOC agents use.
