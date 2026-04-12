#############################################
# Azure Container Apps → Log Analytics diagnostics
#
# Ensures console/system logs are shipped to the workspace so you can query them
# (and use them in Microsoft Sentinel) from day 1.
#############################################

# Ship Control Panel container app logs
resource "azurerm_monitor_diagnostic_setting" "shipcp" {
  name                       = "diag-${azurerm_container_app.shipcp.name}"
  target_resource_id         = azurerm_container_app.shipcp.id
  log_analytics_workspace_id = azurerm_log_analytics_workspace.law.id

  # Categories vary slightly across provider/API versions; these are the common ones.
  enabled_log {
    category = "ContainerAppConsoleLogs"
  }

  enabled_log {
    category = "ContainerAppSystemLogs"
  }

  # Metrics are optional but useful.
  metric {
    category = "AllMetrics"
    enabled  = true
  }
}
