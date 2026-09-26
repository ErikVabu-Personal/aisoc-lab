output "onboarded_vms" {
  description = "GOAD Windows VMs attached to the Sentinel workspace."
  value       = [for v in data.azurerm_virtual_machine.goad : v.name]
}

output "dcr_id_used" {
  description = "The Phase-1 DCR the GOAD hosts were associated to."
  value       = local.dcr_id
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
  value       = "Heartbeat | where Computer in (${join(", ", [for n in var.goad_vm_names : "'${n}'"])}) | summarize arg_max(TimeGenerated, *) by Computer"
}
