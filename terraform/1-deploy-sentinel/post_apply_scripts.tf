# Post-apply: sync Phase 1 deploy targets into GitHub repo variables
# so the per-app workflows know which Azure resources to deploy to.
#
# Why: the Container App + resource group names get random suffixes per
# deployment. Pushing them as repo variables straight from terraform
# output keeps the GHA workflows correct without any manual setup.

variable "github_repo" {
  type        = string
  description = "GitHub repository in 'owner/name' form. Used to sync deploy-target names as repo variables."
  default     = "ErikVabu-Personal/aisoc-lab"
}

# ─────────────────────────────────────────────────────────────────────
# Sentinel analytic rule — Control Panel repeated auth failures.
#
# Why a script instead of a Terraform resource? The rule's KQL query
# references ContainerAppConsoleLogs_CL, which is created lazily by
# Log Analytics the first time the Container App writes to it. ARM/
# Terraform validates the query at create time and fails if the table
# isn't there yet. The script polls for the table (10 min) before
# issuing the PUT — perfect for a fresh deploy where logs haven't
# started flowing yet.
#
# RULE_ID is held in Terraform state so re-applies upgrade the rule
# in place rather than creating duplicates.
# ─────────────────────────────────────────────────────────────────────

resource "random_uuid" "controlpanel_auth_failures_rule" {}

resource "null_resource" "deploy_controlpanel_auth_failures_rule" {
  triggers = {
    rule_id    = random_uuid.controlpanel_auth_failures_rule.result
    rg         = azurerm_resource_group.rg.name
    law        = azurerm_log_analytics_workspace.law.name
    always_run = timestamp()
  }

  provisioner "local-exec" {
    command = "${path.module}/scripts/deploy_sentinel_rule_controlpanel_auth_failures.sh"
    environment = {
      RG      = azurerm_resource_group.rg.name
      LAW     = azurerm_log_analytics_workspace.law.name
      WSID    = azurerm_log_analytics_workspace.law.workspace_id
      RULE_ID = random_uuid.controlpanel_auth_failures_rule.result
    }
  }

  depends_on = [
    azurerm_log_analytics_workspace.law,
    azurerm_container_app.shipcp,
  ]
}

resource "null_resource" "sync_github_repo_vars_phase1" {
  triggers = {
    repo                          = var.github_repo
    aisoc_resource_group          = azurerm_resource_group.rg.name
    aisoc_ship_control_panel_name = azurerm_container_app.shipcp.name
    always_run                    = timestamp()
  }

  provisioner "local-exec" {
    command = "${path.module}/../../scripts/sync_github_repo_var.sh"
    environment = {
      REPO                           = var.github_repo
      AISOC_RESOURCE_GROUP           = azurerm_resource_group.rg.name
      AISOC_SHIP_CONTROL_PANEL_NAME  = azurerm_container_app.shipcp.name
    }
  }

  depends_on = [
    azurerm_container_app.shipcp,
  ]
}
