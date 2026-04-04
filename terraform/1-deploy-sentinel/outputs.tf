output "resource_group" {
  value = azurerm_resource_group.rg.name
}

output "log_analytics_workspace_id" {
  value = azurerm_log_analytics_workspace.law.id
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
  value       = var.admin_password
  description = "Local admin password for the Windows VM"
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
