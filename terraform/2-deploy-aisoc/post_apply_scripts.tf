# Post-apply wiring scripts.
#
# These null_resources run idempotent shell scripts at the end of every
# `terraform apply` to re-establish env-var wiring on Container Apps /
# Function Apps that Terraform itself can't manage cleanly (because the
# values are computed at runtime from other resources, e.g. function host
# keys).
#
# The scripts are also called from GitHub Actions workflows after a code
# redeploy, so the wiring stays correct in both flows.

# Configure runner with SOCGateway function key.
#
# The SOC Gateway function key is computed by Azure after the function
# app exists, and a function-code redeploy can rotate it — neither plays
# well with Terraform's plan/apply model. The script fetches the current
# key and stores it as a Container App secret on the runner.
resource "null_resource" "configure_runner_socgateway_key" {
  triggers = {
    runner_name              = azurerm_container_app.runner.name
    soc_gateway_function_name = azurerm_linux_function_app.soc_gateway.name
    resource_group           = data.terraform_remote_state.sentinel.outputs.resource_group
    # always_run forces the provisioner to execute on every apply.
    # The underlying script is idempotent (just `az containerapp update`).
    always_run = timestamp()
  }

  provisioner "local-exec" {
    command = "${path.module}/scripts/configure_runner_socgateway_key.sh"
    environment = {
      RG           = data.terraform_remote_state.sentinel.outputs.resource_group
      FUNC_APP     = azurerm_linux_function_app.soc_gateway.name
      RUNNER_NAME  = azurerm_container_app.runner.name
    }
  }

  depends_on = [
    azurerm_container_app.runner,
    azurerm_linux_function_app.soc_gateway,
  ]
}

# ─────────────────────────────────────────────────────────────────────
# GitHub repo variable sync.
#
# Push Phase 2 deploy targets into GitHub repo variables so the per-app
# workflows know which Function Apps / Container Apps to deploy to.
# Names get random suffixes per deployment, so static repo vars would
# drift; this sync keeps them current automatically.
# ─────────────────────────────────────────────────────────────────────

variable "github_repo" {
  type        = string
  description = "GitHub repository in 'owner/name' form. Used to sync deploy-target names as repo variables."
  default     = "ErikVabu-Personal/aisoc-lab"
}

resource "null_resource" "sync_github_repo_vars_phase2" {
  triggers = {
    repo                              = var.github_repo
    aisoc_runner_name                 = azurerm_container_app.runner.name
    aisoc_orchestrator_function_name  = azurerm_linux_function_app.orchestrator.name
    aisoc_soc_gateway_function_name   = azurerm_linux_function_app.soc_gateway.name
    # The KB-storage / Search vars are only set when the
    # detection-rules KB subsystem is enabled; nullable.
    drk_storage_account               = local.drk_enabled ? azurerm_storage_account.detection_rules[0].name : ""
    drk_storage_container             = local.drk_enabled ? azurerm_storage_container.detection_rules[0].name : ""
    drk_search_service                = local.drk_enabled ? azurerm_search_service.detection_rules[0].name : ""
    always_run                        = timestamp()
  }

  provisioner "local-exec" {
    command = "${path.module}/../../scripts/sync_github_repo_var.sh"
    environment = {
      REPO                              = var.github_repo
      AISOC_RUNNER_NAME                 = azurerm_container_app.runner.name
      AISOC_ORCHESTRATOR_FUNCTION_NAME  = azurerm_linux_function_app.orchestrator.name
      AISOC_SOC_GATEWAY_FUNCTION_NAME   = azurerm_linux_function_app.soc_gateway.name

      # Surface the storage account + container + Search service
      # names so the daily-refresh GitHub Actions workflow knows
      # where to push the SigmaHQ rules corpus.
      AISOC_DETECTION_RULES_STORAGE_ACCOUNT   = local.drk_enabled ? azurerm_storage_account.detection_rules[0].name : ""
      AISOC_DETECTION_RULES_STORAGE_CONTAINER = local.drk_enabled ? azurerm_storage_container.detection_rules[0].name : ""
      AISOC_DETECTION_RULES_SEARCH_SERVICE    = local.drk_enabled ? azurerm_search_service.detection_rules[0].name : ""
    }
  }

  depends_on = [
    azurerm_container_app.runner,
    azurerm_linux_function_app.orchestrator,
    azurerm_linux_function_app.soc_gateway,
  ]
}
