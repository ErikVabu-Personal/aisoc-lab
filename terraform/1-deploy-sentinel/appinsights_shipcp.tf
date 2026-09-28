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

resource "azurerm_application_insights" "shipcp" {
  name                = "appi-shipcp-${random_string.suffix.result}"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name

  application_type = "web"
  workspace_id     = azurerm_log_analytics_workspace.law.id

  retention_in_days = 30

  tags = local.tags
}
