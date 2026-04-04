#############################################
# MDE onboarding via Key Vault (no copy/paste into tfvars/state)
#
# Pattern:
# - Terraform creates a Key Vault.
# - You store the MDE onboarding script as a secret (once) using az CLI.
# - VM has system-assigned MI and gets "get" permission.
# - Custom Script Extension pulls secret and runs it.
#############################################

data "azurerm_client_config" "current" {}

resource "random_string" "kv_suffix" {
  length  = 6
  upper   = false
  special = false
}

locals {
  mde_kv_name = "kv-mde-${random_string.kv_suffix.result}"
}

resource "azurerm_key_vault" "mde" {
  count               = var.enable_defender_for_endpoint ? 1 : 0
  name                = local.mde_kv_name
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  tenant_id           = data.azurerm_client_config.current.tenant_id
  sku_name            = "standard"

  purge_protection_enabled   = false
  soft_delete_retention_days = 7

  # Give the current operator rights to set the secret
  access_policy {
    tenant_id = data.azurerm_client_config.current.tenant_id
    object_id = data.azurerm_client_config.current.object_id

    secret_permissions = ["Get", "List", "Set", "Delete"]
  }

  lifecycle {
    prevent_destroy = var.prevent_destroy_mde_key_vault
  }

  tags = local.tags
}

# (Optional) Upload onboarding script to Key Vault (LAB ONLY).
# Note: secret content will be stored in Terraform state.
resource "azurerm_key_vault_secret" "mde_onboard" {
  count = (var.enable_defender_for_endpoint && var.mde_onboarding_script_path != null) ? 1 : 0

  name         = var.mde_onboarding_secret_name
  value        = file(var.mde_onboarding_script_path)
  key_vault_id = azurerm_key_vault.mde[0].id

  # Ensure updates when file content changes (re-run trigger)
  tags = {
    file_sha256 = filesha256(var.mde_onboarding_script_path)
  }
}

# Allow the VM managed identity to read the onboarding secret
resource "azurerm_key_vault_access_policy" "vm_mde_secret_get" {
  count       = var.enable_defender_for_endpoint ? 1 : 0
  key_vault_id = azurerm_key_vault.mde[0].id
  tenant_id    = data.azurerm_client_config.current.tenant_id
  object_id    = azurerm_windows_virtual_machine.vm.identity[0].principal_id

  secret_permissions = ["Get", "List"]
}

resource "azurerm_virtual_machine_run_command" "mde_onboard" {
  count = (var.enable_defender_for_endpoint && var.mde_onboarding_secret_name != null && var.mde_onboarding_script_path != null) ? 1 : 0

  # Include onboarding script hash so a change forces a new Run Command execution
  name               = "mde-onboard-${substr(filesha256(var.mde_onboarding_script_path), 0, 8)}"
  location           = azurerm_resource_group.rg.location
  virtual_machine_id = azurerm_windows_virtual_machine.vm.id

  source {
    script = templatefile("${path.module}/scripts/mde_onboard.ps1.tftpl", {
      key_vault_uri = azurerm_key_vault.mde[0].vault_uri
      secret_name   = var.mde_onboarding_secret_name
    })
  }

  depends_on = [
    azurerm_key_vault_access_policy.vm_mde_secret_get,
    azurerm_key_vault_secret.mde_onboard
  ]
}

output "mde_key_vault_uri" {
  value       = try(azurerm_key_vault.mde[0].vault_uri, null)
  description = "Key Vault URI for storing the MDE onboarding script secret"
}
