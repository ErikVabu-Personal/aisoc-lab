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

# Use the existing resource group from this stack

locals {
  foundry_prefix = "foundry-soc"
  kv_name        = "kv-${local.foundry_prefix}-${random_string.suffix.result}"
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

# Key Vault to store API keys (OpenRouter etc.)
resource "azurerm_key_vault" "kv" {
  name                = local.kv_name
  location            = local.location_effective
  resource_group_name = data.terraform_remote_state.sentinel.outputs.resource_group
  tenant_id           = data.azurerm_client_config.current.tenant_id
  sku_name            = "standard"

  purge_protection_enabled   = false
  soft_delete_retention_days = 7

  access_policy {
    tenant_id = data.azurerm_client_config.current.tenant_id
    object_id = data.azurerm_client_config.current.object_id

    secret_permissions = ["Get", "List", "Set", "Delete"]
  }

  tags = local.tags
}

# Store OpenRouter API key as secret (optional; preferred)
resource "azurerm_key_vault_secret" "openrouter" {
  count = var.openrouter_api_key == null ? 0 : 1

  name         = "OPENROUTER-API-KEY"
  value        = var.openrouter_api_key
  key_vault_id = azurerm_key_vault.kv.id
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
    "KEYVAULT_URI" = azurerm_key_vault.kv.vault_uri

    # AISOC gateway authorization keys (set these after apply)
    "AISOC_READ_KEY"  = ""
    "AISOC_WRITE_KEY" = ""

    # Optional direct key (NOT recommended); keep disabled by default
    "OPENROUTER_API_KEY" = ""
  }

  tags = local.tags
}

# Grant the function MI read access to Key Vault secrets
resource "azurerm_key_vault_access_policy" "func_secrets" {
  key_vault_id = azurerm_key_vault.kv.id
  tenant_id    = data.azurerm_client_config.current.tenant_id
  object_id    = azurerm_linux_function_app.soc_gateway.identity[0].principal_id

  secret_permissions = ["Get", "List"]
}

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
  value = azurerm_key_vault.kv.vault_uri
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
  value       = azapi_resource.foundry_project.id
  description = "Foundry project resource id."
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
