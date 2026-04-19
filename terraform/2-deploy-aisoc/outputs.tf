output "foundry_hub_id" {
  value       = azapi_resource.foundry_account.id
  description = "Resource ID of the Azure AI Foundry Hub (Cognitive Services account)."
}

output "foundry_hub_name" {
  value       = azapi_resource.foundry_account.name
  description = "Name of the Azure AI Foundry Hub."
}

output "foundry_project_name" {
  value       = local.foundry_project_name_effective
  description = "Foundry project name (effective)."
}

output "foundry_location" {
  value       = local.foundry_location_effective
  description = "Location used for Foundry resources."
}

output "foundry_api_version" {
  value       = local.foundry_api_version
  description = "AzAPI apiVersion used for Foundry resources."
}
