output "foundry_hub_id" {
  value       = azapi_resource.foundry_account.id
  description = "Resource ID of the Azure AI Foundry Hub (Cognitive Services account)."
}

output "foundry_api_version" {
  value       = local.foundry_api_version
  description = "AzAPI apiVersion used for Foundry resources."
}

# Note: other Foundry outputs already exist in main.tf (foundry_hub_name,
# foundry_project_name, foundry_location, etc.). Output names must be unique.
