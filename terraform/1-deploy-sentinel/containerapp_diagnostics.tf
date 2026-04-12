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
  # NOTE: Diagnostic categories differ by region/provider/API.
  # Some subscriptions expose these as "ContainerAppConsoleLogs"/"ContainerAppSystemLogs",
  # others as "ContainerAppConsoleLogs"/"ContainerAppSystemLogs" or without the "ContainerApp" prefix.
  # The error you hit indicates this environment does NOT support "ContainerAppConsoleLogs".
  # The most broadly supported categories for Container Apps are the plain ones:
  enabled_log { category = "ConsoleLogs" }
  enabled_log { category = "SystemLogs" }

  # Metrics are optional but useful.
  enabled_metric {
    category = "AllMetrics"
  }
}
