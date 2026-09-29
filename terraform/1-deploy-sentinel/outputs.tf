output "resource_group" {
  value = azurerm_resource_group.rg.name
}

output "selected_location" {
  value       = azurerm_resource_group.rg.location
  description = "Region used for Phase 1 (the resource group's location). Consumed by Phase 2 + Phase 3 via remote state as their location fallback. Named 'selected_location' for back-compat with those consumers — there is no auto-selection anymore, so it is simply the RG location."
}

output "log_analytics_workspace_id" {
  value = azurerm_log_analytics_workspace.law.id
}

output "maison_url" {
  value       = "https://${azurerm_container_app.maison.ingress[0].fqdn}"
  description = "URL for the Maison Miró (web victim) Container App."
}

output "maison_name" {
  value       = azurerm_container_app.maison.name
  description = "Name of the Maison Miró Container App."
}

output "maison_id" {
  value       = azurerm_container_app.maison.id
  description = "Resource ID of the Maison Miró Container App."
}

output "container_app_environment_name" {
  value       = azurerm_container_app_environment.shipcp.name
  description = "Name of the shared Container Apps environment (hosts Maison Miró; consumed by Phase 2/3)."
}

output "container_app_environment_id" {
  value       = azurerm_container_app_environment.shipcp.id
  description = "Resource ID of the shared Container Apps environment (consumed by Phase 2 runner + Phase 3 web via remote state)."
}

output "application_insights_name" {
  value       = azurerm_application_insights.shipcp.name
  description = "Name of the shared Application Insights resource (workspace-based)."
}

output "application_insights_id" {
  value       = azurerm_application_insights.shipcp.id
  description = "Resource ID of the shared Application Insights resource."
}

output "application_insights_connection_string" {
  value       = azurerm_application_insights.shipcp.connection_string
  description = "Application Insights connection string (consumed by the Phase 2 gateway + orchestrator via remote state)."
  sensitive   = true
}

output "application_insights_instrumentation_key" {
  value       = azurerm_application_insights.shipcp.instrumentation_key
  description = "Application Insights instrumentation key (legacy; still useful for troubleshooting)."
  sensitive   = true
}

output "log_analytics_workspace_name" {
  value = azurerm_log_analytics_workspace.law.name
}

output "sentinel_enabled" {
  value = var.sentinel_enabled
}

output "dcr_id" {
  value       = try(azurerm_monitor_data_collection_rule.dcr[0].id, null)
  description = "Windows Event Log Data Collection Rule id — consumed by 4-onboard-goad to associate the GOAD hosts (null when enable_windows_event_logs = false)."
}

output "log_analytics_workspace_workspace_id" {
  value = azurerm_log_analytics_workspace.law.workspace_id
}
