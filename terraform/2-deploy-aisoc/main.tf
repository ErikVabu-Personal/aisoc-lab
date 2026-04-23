#############################################
# Foundry SOC (Terraform-managed components)
#
# This file adds an Azure Function "SOC Tool Gateway" to the existing
# Sentinel test environment, plus Key Vault to store provider API keys.
#
# Agent definitions themselves are deployed via a small Python script.
#############################################

# Resolve subscription/tenant dynamically

data "azurerm_client_config" "current" {}

output "subscription_id" {
  value       = data.azurerm_client_config.current.subscription_id
  description = "Subscription id (for scripts that call Foundry portal APIs)."
}

output "resource_group" {
  value       = data.terraform_remote_state.sentinel.outputs.resource_group
  description = "Resource group used for the AISOC lab (from Phase 1)."
}

# Use the existing resource group from this stack

locals {
  foundry_prefix = "foundry-soc"
  # Key Vault is created in Phase 1 and reused here.
  kv_name        = data.terraform_remote_state.sentinel.outputs.aisoc_key_vault_name
  sa_name        = "safoundrysoc${random_string.suffix.result}" # must be lowercase
  func_name      = "func-${local.foundry_prefix}-${random_string.suffix.result}"

  location_effective = var.location_override != null ? var.location_override : data.terraform_remote_state.sentinel.outputs.selected_location
}

# Storage account for Function App
resource "azurerm_storage_account" "fa" {
  name                     = local.sa_name
  resource_group_name      = data.terraform_remote_state.sentinel.outputs.resource_group
  location                 = local.location_effective
  account_tier             = "Standard"
  account_replication_type = "LRS"

  allow_nested_items_to_be_public = false

  tags = local.tags
}

resource "azurerm_service_plan" "fa" {
  name                = "asp-${local.foundry_prefix}-${random_string.suffix.result}"
  resource_group_name = data.terraform_remote_state.sentinel.outputs.resource_group
  location            = local.location_effective

  os_type  = "Linux"
  # NOTE: Consumption plans use "Dynamic" workers and can fail if your subscription's
  # Dynamic VMs quota is 0 in the selected region.
  sku_name = var.function_plan_sku

  tags = local.tags
}

# Key Vault lives in Phase 1. Phase 2 stores secrets there and grants access as needed.
# (No Key Vault resource here.)

# Store OpenRouter API key as secret (optional; preferred)
resource "azurerm_key_vault_secret" "openrouter" {
  count = var.openrouter_api_key == null ? 0 : 1

  name         = "OPENROUTER-API-KEY"
  value        = var.openrouter_api_key
  key_vault_id = local.shared_kv_id
}

# Function App (Linux)
resource "azurerm_linux_function_app" "soc_gateway" {
  name                = local.func_name
  resource_group_name = data.terraform_remote_state.sentinel.outputs.resource_group
  location            = local.location_effective

  service_plan_id            = azurerm_service_plan.fa.id
  storage_account_name       = azurerm_storage_account.fa.name
  storage_account_access_key = azurerm_storage_account.fa.primary_access_key

  identity {
    type = "SystemAssigned"
  }

  site_config {
    application_stack {
      python_version = "3.11"
    }
  }

  app_settings = {
    "FUNCTIONS_WORKER_RUNTIME" = "python"
    "WEBSITE_RUN_FROM_PACKAGE" = "1"

    # Sentinel/Log Analytics IDs for the tool gateway
    "LAW_WORKSPACE_ID"   = data.terraform_remote_state.sentinel.outputs.log_analytics_workspace_workspace_id
    "LAW_WORKSPACE_NAME" = data.terraform_remote_state.sentinel.outputs.log_analytics_workspace_name
    "LAW_RESOURCE_ID"    = data.terraform_remote_state.sentinel.outputs.log_analytics_workspace_id

    "AZURE_SUBSCRIPTION_ID" = data.azurerm_client_config.current.subscription_id
    "AZURE_RESOURCE_GROUP"  = data.terraform_remote_state.sentinel.outputs.resource_group

    # Key vault reference (function uses managed identity to fetch secrets)
    "KEYVAULT_URI" = local.shared_kv_uri

    # AISOC gateway authorization keys (Key Vault references)
    "AISOC_READ_KEY"  = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault_secret.aisoc_read_key.id})"
    "AISOC_WRITE_KEY" = "@Microsoft.KeyVault(SecretUri=${azurerm_key_vault_secret.aisoc_write_key.id})"

    # Optional direct key (NOT recommended); keep disabled by default
    "OPENROUTER_API_KEY" = ""
  }

  tags = local.tags
}

# Give Azure time to propagate the Function App's managed identity before applying
# Key Vault access policy. This avoids flaky first-run 403s when the Function tries
# to read secrets immediately after deployment.
resource "time_sleep" "wait_for_soc_gateway_identity" {
  depends_on      = [azurerm_linux_function_app.soc_gateway]
  create_duration = "30s"
}

# Grant the function MI read access to Key Vault secrets
resource "azurerm_key_vault_access_policy" "func_secrets" {
  depends_on = [time_sleep.wait_for_soc_gateway_identity]

  key_vault_id = local.shared_kv_id
  tenant_id    = data.azurerm_client_config.current.tenant_id
  object_id    = azurerm_linux_function_app.soc_gateway.identity[0].principal_id

  # Required for both:
  # - the Function code using managed identity to read secrets
  # - Key Vault references in App Settings (resolved by the App Service platform)
  secret_permissions = ["Get"]
}

# Note: Key Vault references in App Settings are resolved using the Function App's managed identity.
# The access policy above (`func_secrets`) is sufficient for that.

# RBAC for querying Log Analytics
resource "azurerm_role_assignment" "law_reader" {
  scope                = data.terraform_remote_state.sentinel.outputs.log_analytics_workspace_id
  role_definition_name = "Log Analytics Reader"
  principal_id         = azurerm_linux_function_app.soc_gateway.identity[0].principal_id
}

# RBAC for Sentinel operations
# NOTE: Role names vary by tenant; this is commonly available.
resource "azurerm_role_assignment" "sentinel_contributor" {
  scope                = data.terraform_remote_state.sentinel.outputs.log_analytics_workspace_id
  role_definition_name = "Microsoft Sentinel Contributor"
  principal_id         = azurerm_linux_function_app.soc_gateway.identity[0].principal_id
}

output "soc_gateway_function_name" {
  value = azurerm_linux_function_app.soc_gateway.name
}

output "soc_gateway_principal_id" {
  value = azurerm_linux_function_app.soc_gateway.identity[0].principal_id
}

output "key_vault_uri" {
  value = local.shared_kv_uri
}

output "key_vault_id" {
  value       = local.shared_kv_id
  description = "Key Vault resource id (from Phase 1)."
}

output "aisoc_read_key_secret_name" {
  value       = azurerm_key_vault_secret.aisoc_read_key.name
  description = "Key Vault secret name storing AISOC read key."
}

output "aisoc_write_key_secret_name" {
  value       = azurerm_key_vault_secret.aisoc_write_key.name
  description = "Key Vault secret name storing AISOC write key."
}

# Convenience outputs for other terraform phases.
# These are marked sensitive but still end up in the local tfstate.
# If you want to avoid that entirely, use Key Vault references instead.
output "aisoc_read_key_value" {
  value     = random_string.aisoc_read_key.result
  sensitive = true
}

output "aisoc_write_key_value" {
  value     = random_string.aisoc_write_key.result
  sensitive = true
}

# -----------------------------
# Foundry outputs (consumed by scripts)
# -----------------------------

output "foundry_hub_name" {
  value       = local.foundry_hub_name_effective
  description = "Effective Foundry hub/account name (auto-generated if not provided)."
}

output "foundry_project_name" {
  value       = local.foundry_project_name_effective
  description = "Effective Foundry project name (auto-generated if not provided)."
}

output "foundry_account_id" {
  value       = azapi_resource.foundry_account.id
  description = "Foundry/Cognitive Services account resource id (Hub)."
}

output "foundry_project_id" {
  value       = "${azapi_resource.foundry_account.id}/projects/${local.foundry_project_name_effective}"
  description = "Foundry project resource id (computed). The project is created post-apply via script." 
}

# We can't reliably output the project endpoint from Terraform when project creation is scripted.
# The deploy_foundry_project.py script can read the project resource after creation.
output "foundry_project_endpoint" {
  value       = null
  description = "Foundry project endpoint (AI Foundry API). Created post-apply; discover via script/UI."
}

locals {
  foundry_project_endpoint_effective = null
}

output "key_vault_name" {
  value       = local.shared_kv_name
  description = "Key Vault name (from Phase 1) storing AISOC shared secrets."
}

output "foundry_location" {
  value       = coalesce(var.foundry_location, local.location_effective)
  description = "Effective location to use for Foundry-related resources."
}

output "foundry_model_choice" {
  value       = var.foundry_model_choice
  description = "Desired model family/choice string (e.g. gpt-4.1-mini)."
}

output "foundry_model_deployment_name" {
  value       = var.foundry_model_deployment_name
  description = "Desired Foundry model deployment name that agents should target."
}
