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

  tags = local.tags
}

# (Optional) Upload onboarding script to Key Vault (LAB ONLY).
# Note: secret content will be stored in Terraform state.
resource "azurerm_key_vault_secret" "mde_onboard" {
  count = (var.enable_defender_for_endpoint && var.mde_onboarding_script_path != null) ? 1 : 0

  name         = var.mde_onboarding_secret_name
  value        = file(var.mde_onboarding_script_path)
  key_vault_id = azurerm_key_vault.mde[0].id
}

# Allow the VM managed identity to read the onboarding secret
resource "azurerm_key_vault_access_policy" "vm_mde_secret_get" {
  count       = var.enable_defender_for_endpoint ? 1 : 0
  key_vault_id = azurerm_key_vault.mde[0].id
  tenant_id    = data.azurerm_client_config.current.tenant_id
  object_id    = azurerm_windows_virtual_machine.vm.identity[0].principal_id

  secret_permissions = ["Get"]
}

# Custom Script Extension that pulls the script from KV and runs it
locals {
  # PowerShell script executed on the VM (runs as SYSTEM via CustomScriptExtension)
  mde_onboard_ps = <<PS
$kv   = "${azurerm_key_vault.mde[0].vault_uri}".TrimEnd('/')
$name = "${var.mde_onboarding_secret_name}"
$p    = "$env:WINDIR\\Temp\\mde-onboard.cmd"

# Get Key Vault token via IMDS (VM system-assigned managed identity)
$imds = "http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fvault.azure.net"
$tok  = (Invoke-RestMethod -Headers @{ Metadata = 'true' } -Method GET -Uri $imds).access_token

# Fetch secret value
$sec = Invoke-RestMethod -Headers @{ Authorization = "Bearer $tok" } -Method GET -Uri "$kv/secrets/$name?api-version=7.4"

# Write onboarding CMD to disk (ASCII)
[IO.File]::WriteAllText($p, $sec.value, [Text.Encoding]::ASCII)

# Remove trailing 'pause' if present
(Get-Content -Raw $p) -replace '(^|\r?\n)pause\s*(\r?\n|$)','\r\n' | Set-Content -NoNewline -Encoding ASCII $p

# Execute with auto-consent
cmd /c "echo Y| %WINDIR%\\Temp\\mde-onboard.cmd"
PS

  # CustomScriptExtension expects a single command string
  mde_onboard_command = format(
    "powershell -ExecutionPolicy Bypass -NoProfile -Command \"%s\"",
    replace(replace(local.mde_onboard_ps, "\n", "; "), "\"", "\\\"")
  )
}

resource "azurerm_virtual_machine_extension" "mde_onboard_kv" {
  count = (var.enable_defender_for_endpoint && var.mde_onboarding_secret_name != null) ? 1 : 0

  name                       = "MDEOnboard"
  virtual_machine_id         = azurerm_windows_virtual_machine.vm.id
  publisher                  = "Microsoft.Compute"
  type                       = "CustomScriptExtension"
  type_handler_version       = "1.10"
  auto_upgrade_minor_version = true

  protected_settings = jsonencode({
    commandToExecute = local.mde_onboard_command
  })

  depends_on = [
    azurerm_key_vault_access_policy.vm_mde_secret_get,
    azurerm_key_vault_secret.mde_onboard
  ]
}

output "mde_key_vault_uri" {
  value       = try(azurerm_key_vault.mde[0].vault_uri, null)
  description = "Key Vault URI for storing the MDE onboarding script secret"
}
