#############################################
# AISOC shared Key Vault (Phase 1)
#
# Purpose:
# - Avoid slow destroys in Phase 2 due to Key Vault soft-delete behavior.
# - Provide a stable KV for Phase 2 secrets (runner bearer, aisoc read/write keys, etc.).
#
# This Key Vault lives in the Phase 1 resource group and is output for Phase 2.
#############################################

data "azurerm_client_config" "aisoc_current" {}

resource "random_string" "aisoc_kv_suffix" {
  length  = 6
  upper   = false
  special = false
}

locals {
  aisoc_kv_name = "kv-aisoc-${random_string.aisoc_kv_suffix.result}"
}

resource "azurerm_key_vault" "aisoc" {
  name                = local.aisoc_kv_name
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  tenant_id           = data.azurerm_client_config.aisoc_current.tenant_id
  sku_name            = "standard"

  purge_protection_enabled   = false
  soft_delete_retention_days = 7

  # Operator access (for debugging / manual secret operations)
  access_policy {
    tenant_id = data.azurerm_client_config.aisoc_current.tenant_id
    object_id = data.azurerm_client_config.aisoc_current.object_id

    secret_permissions = ["Get", "List", "Set", "Delete", "Recover"]
  }

  tags = local.tags
}

output "aisoc_key_vault_id" {
  value       = azurerm_key_vault.aisoc.id
  description = "Key Vault resource id for AISOC shared secrets (Phase 1)."
}

output "aisoc_key_vault_name" {
  value       = azurerm_key_vault.aisoc.name
  description = "Key Vault name for AISOC shared secrets (Phase 1)."
}

output "aisoc_key_vault_uri" {
  value       = azurerm_key_vault.aisoc.vault_uri
  description = "Key Vault URI for AISOC shared secrets (Phase 1)."
}
