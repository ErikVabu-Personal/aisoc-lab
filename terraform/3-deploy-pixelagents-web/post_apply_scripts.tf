# Post-apply wiring scripts.
#
# These null_resources run idempotent shell scripts after every
# `terraform apply` to wire the AISOC Runner and AISOC Orchestrator
# (both deployed in Phase 2) with the freshly-known PixelAgents URL +
# token. We can't manage these from Phase 2 because PixelAgents Web is
# created in Phase 3.

locals {
  pixelagents_url   = "https://${azurerm_container_app.pixelagents.ingress[0].fqdn}"
  pixelagents_token = random_password.pixelagents_token.result
  phase2_rg         = data.terraform_remote_state.sentinel.outputs.resource_group
  runner_name       = data.terraform_remote_state.aisoc.outputs.runner_name
  orch_name         = data.terraform_remote_state.aisoc.outputs.orchestrator_function_name
}

# Wire the runner with PIXELAGENTS_URL + PIXELAGENTS_TOKEN so it can emit
# /events to PixelAgents Web (animates agents during workflow runs).
resource "null_resource" "configure_runner_pixelagents_env" {
  triggers = {
    pixelagents_url = local.pixelagents_url
    runner_name     = local.runner_name
    always_run      = timestamp()
  }

  provisioner "local-exec" {
    command = "${path.module}/scripts/configure_runner_pixelagents_env.sh"
    environment = {
      RG          = local.phase2_rg
      RUNNER_NAME = local.runner_name
      PIXEL_URL   = local.pixelagents_url
      PIXEL_TOKEN = local.pixelagents_token
    }
  }

  depends_on = [azurerm_container_app.pixelagents]
}

# Wire the orchestrator with PIXELAGENTS_URL + PIXELAGENTS_TOKEN so it
# can POST /api/cost/record per-incident cost telemetry.
resource "null_resource" "configure_orchestrator_pixelagents_env" {
  triggers = {
    pixelagents_url = local.pixelagents_url
    orch_name       = local.orch_name
    always_run      = timestamp()
  }

  provisioner "local-exec" {
    command = "${path.module}/scripts/configure_orchestrator_pixelagents_env.sh"
    environment = {
      RG          = local.phase2_rg
      ORCH_NAME   = local.orch_name
      PIXEL_URL   = local.pixelagents_url
      PIXEL_TOKEN = local.pixelagents_token
    }
  }

  depends_on = [azurerm_container_app.pixelagents]
}

# ─────────────────────────────────────────────────────────────────────
# GitHub repo variable sync.
#
# Push Phase 3 deploy targets into GitHub repo variables so the
# pixelagents_web workflow knows which Container App to roll.
# ─────────────────────────────────────────────────────────────────────

variable "github_repo" {
  type        = string
  description = "GitHub repository in 'owner/name' form. Used to sync deploy-target names as repo variables."
  default     = "ErikVabu-Personal/aisoc-lab"
}

resource "null_resource" "sync_github_repo_vars_phase3" {
  triggers = {
    repo                     = var.github_repo
    aisoc_pixelagents_name   = azurerm_container_app.pixelagents.name
    always_run               = timestamp()
  }

  provisioner "local-exec" {
    command = "${path.module}/../../scripts/sync_github_repo_var.sh"
    environment = {
      REPO                     = var.github_repo
      AISOC_PIXELAGENTS_NAME   = azurerm_container_app.pixelagents.name
    }
  }

  depends_on = [azurerm_container_app.pixelagents]
}
