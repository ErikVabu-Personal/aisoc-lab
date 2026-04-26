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
