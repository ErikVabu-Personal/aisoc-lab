#############################################
# Azure Container Apps → Log Analytics diagnostics
#
# Categories are discoverable via:
#   az monitor diagnostic-settings categories list --resource <containerAppId>
#
# In some environments, Container Apps only exposes metrics categories
# (no log categories). When that's the case, we can still ship metrics.
#############################################

resource "azurerm_monitor_diagnostic_setting" "maison" {
  name                       = "diag-${azurerm_container_app.maison.name}"
  target_resource_id         = azurerm_container_app.maison.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.law.id

  # Your environment exposes only the metrics category below.
  enabled_metric {
    category = "AllMetrics"
  }
}
