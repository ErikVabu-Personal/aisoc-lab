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

  # Operator access (for debugging / manual secret operations).
  # Bootstrap-only — creates the operator policy on the FIRST apply
  # so the immediate `azurerm_key_vault_secret` writes can succeed
  # under the operator's identity. Subsequent apply/destroy cycles
  # IGNORE this block (see lifecycle below) so the operator's
  # standalone-policy-style access can be set + maintained from
  # Phase 2 alongside the orchestrator/runner MI policies, without
  # the inline block here wiping them out on every refresh.
  access_policy {
    tenant_id = data.azurerm_client_config.aisoc_current.tenant_id
    object_id = data.azurerm_client_config.aisoc_current.object_id

    secret_permissions = ["Get", "List", "Set", "Delete", "Recover"]
  }

  # Mixing inline `access_policy` blocks with standalone
  # `azurerm_key_vault_access_policy` resources is a documented
  # azurerm trap: every apply, the vault resource considers the
  # inline list authoritative and deletes anything that isn't in
  # it. Phase 2 grants the orchestrator + runner MIs access via
  # standalone policies; without this `ignore_changes` they get
  # silently revoked on every Phase-1 apply.
  #
  # Symptom this fixes: orchestrator returns
  #   "KeyVault secret get failed (403): The user/app 'oid=…' does
  #    not have secrets get permission on key vault 'kv-aisoc-…'"
  # after a Phase-1-only re-apply.
  lifecycle {
    ignore_changes = [access_policy]
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
