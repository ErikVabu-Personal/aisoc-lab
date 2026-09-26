#############################################
# Shared Container Apps environment for the web victim.
#
# Kept named `shipcp` (address + `cae-shipcp-*` name) ON PURPOSE: its id is
# exported as output `container_app_environment_id` and consumed via
# terraform_remote_state by Phase 2 (runner.tf) and Phase 3 (pixelagents web).
# Renaming it would force a replace and break those consumers.
#
# The web-victim app itself is now Maison Miró — see maison_miro.tf. It runs in
# THIS environment, so its stdout lands in the same ContainerAppConsoleLogs_CL
# table (tagged ContainerName_s = "maison-miro"). The env's
# log_analytics_workspace_id binding is the console-log → Sentinel pipeline.
#############################################

resource "azurerm_container_app_environment" "shipcp" {
  name                = "cae-shipcp-${random_string.suffix.result}"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name

  log_analytics_workspace_id = azurerm_log_analytics_workspace.law.id

  tags = local.tags
}
