#############################################
# Application Insights for Ship Control Panel logs
#
# Container Apps diagnostic settings may expose metrics-only in some regions.
# App Insights gives us a reliable pipeline for application logs/telemetry
# that Sentinel can query via the same Log Analytics workspace.
#############################################

resource "azurerm_application_insights" "shipcp" {
  name                = "appi-shipcp-${random_string.suffix.result}"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name

  application_type    = "web"
  workspace_id        = azurerm_log_analytics_workspace.law.id

  retention_in_days = 30

  tags = local.tags
}
