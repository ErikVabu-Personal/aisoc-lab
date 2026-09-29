output "onboarded_vms" {
  description = "GOAD Windows VMs attached to the Sentinel workspace."
  value       = [for v in data.azurerm_virtual_machine.goad : v.name]
}

output "goad_dcr_id" {
  description = "The DCR (created in GOAD's region) the GOAD hosts were associated to."
  value       = azurerm_monitor_data_collection_rule.goad_dcr.id
}

output "goad_dcr_location" {
  description = "Region the GOAD DCR was created in (= GOAD's region)."
  value       = local.goad_location
}

output "log_analytics_workspace_name" {
  value = local.law_name
}

output "deployed_ad_rules" {
  description = "AD analytic rules deployed (display names)."
  value       = var.enable_ad_rules ? [for k, r in local.ad_rules : r.display_name] : []
}

output "verify_hint" {
  description = "KQL to confirm the GOAD hosts are reporting."
  value       = "Heartbeat | where Computer in (${join(", ", [for n in var.goad_vm_names : "'${replace(n, "goad-vm-", "")}'"])}) | summarize arg_max(TimeGenerated, *) by Computer"
}
