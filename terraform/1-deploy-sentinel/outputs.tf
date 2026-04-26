output "resource_group" {
  value = azurerm_resource_group.rg.name
}

output "log_analytics_workspace_id" {
  value = azurerm_log_analytics_workspace.law.id
}

output "ship_control_panel_url" {
  value       = "https://${azurerm_container_app.shipcp.ingress[0].fqdn}"
  description = "URL for the Ship Control Panel (Next.js) Container App."
}

output "ship_control_panel_name" {
  value       = azurerm_container_app.shipcp.name
  description = "Name of the Ship Control Panel Container App."
}

output "ship_control_panel_id" {
  value       = azurerm_container_app.shipcp.id
  description = "Resource ID of the Ship Control Panel Container App."
}

output "container_app_environment_name" {
  value       = azurerm_container_app_environment.shipcp.name
  description = "Name of the Container Apps environment used for Ship Control Panel."
}

output "container_app_environment_id" {
  value       = azurerm_container_app_environment.shipcp.id
  description = "Resource ID of the Container Apps environment used for Ship Control Panel."
}

output "application_insights_name" {
  value       = azurerm_application_insights.shipcp.name
  description = "Name of the Application Insights resource for Ship Control Panel (workspace-based)."
}

output "application_insights_id" {
  value       = azurerm_application_insights.shipcp.id
  description = "Resource ID of the Application Insights resource for Ship Control Panel."
}

output "application_insights_connection_string" {
  value       = azurerm_application_insights.shipcp.connection_string
  description = "Application Insights connection string injected into the Ship Control Panel container."
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

output "vm_public_ip" {
  value = azurerm_public_ip.pip.ip_address
}

output "rdp_connection" {
  value = "mstsc /v:${azurerm_public_ip.pip.ip_address}"
}

output "vm_username" {
  value       = var.admin_username
  description = "Local admin username for the Windows VM"
}

output "vm_password" {
  value       = local.effective_admin_password
  description = "Local admin password for the Windows VM. Auto-generated when admin_password is null; stable across re-applies via Terraform state."
  sensitive   = true
}

output "selected_location" {
  value       = azurerm_resource_group.rg.location
  description = "Location actually used (may differ if auto-selection enabled)"
}

output "selected_vm_size" {
  value       = local.selected_vm_size
  description = "VM size actually used (may differ if auto-selection enabled)"
}

output "ama_enabled" {
  value = var.enable_ama
}

output "dcr_id" {
  value       = try(azurerm_monitor_data_collection_rule.dcr[0].id, null)
  description = "Data collection rule id (when enabled)"
}

output "log_analytics_workspace_workspace_id" {
  value = azurerm_log_analytics_workspace.law.workspace_id
}
