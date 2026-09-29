#############################################
# Shared Application Insights (Maison Miró + the Phase 2 gateway/orchestrator).
#
# Kept named `shipcp` (address + `appi-shipcp-*` name) ON PURPOSE: its
# connection string is exported as output `application_insights_connection_string`
# and consumed via terraform_remote_state by Phase 2. Renaming would churn it.
#
# Container Apps diagnostic settings may expose metrics-only in some regions.
# App Insights gives us a reliable pipeline for application logs/telemetry
# that Sentinel can query via the same Log Analytics workspace.
#############################################

locals {
  # Application Insights (microsoft.insights/components) is NOT offered in a few
  # regions — notably westcentralus, which --auto-region can pick for the movable
  # infra (ACA / Log Analytics / Sentinel all DO run there). When the RG's region
  # can't host the component, place it in a supported fallback (default eastus2,
  # already in play for Foundry). It's workspace-based, so telemetry still lands in
  # the (now cross-region) Log Analytics workspace and Sentinel queries it the same.
  appinsights_unsupported_regions = ["westcentralus"]
  appinsights_location = coalesce(
    var.app_insights_location,
    contains(local.appinsights_unsupported_regions, azurerm_resource_group.rg.location) ? var.app_insights_fallback_location : azurerm_resource_group.rg.location,
  )
}

resource "azurerm_application_insights" "shipcp" {
  name                = "appi-shipcp-${random_string.suffix.result}"
  location            = local.appinsights_location
  resource_group_name = azurerm_resource_group.rg.name

  application_type = "web"
  workspace_id     = azurerm_log_analytics_workspace.law.id

  retention_in_days = 30

  tags = local.tags
}
