#############################################
# Azure Container Registry (for hosted agents)
#############################################

resource "azurerm_container_registry" "acr" {
  name                = "acr${random_string.suffix.result}aisoc"
  resource_group_name = data.terraform_remote_state.sentinel.outputs.resource_group
  location            = local.location_effective

  sku           = "Basic"
  admin_enabled = true

  tags = local.tags
}

output "acr_login_server" {
  value       = azurerm_container_registry.acr.login_server
  description = "ACR login server for azd hosted agent deployments"
}

output "acr_admin_username" {
  value       = azurerm_container_registry.acr.admin_username
  description = "ACR admin username (used by azd if needed)"
  sensitive   = true
}

output "acr_admin_password" {
  value       = azurerm_container_registry.acr.admin_password
  description = "ACR admin password (used by azd if needed)"
  sensitive   = true
}
