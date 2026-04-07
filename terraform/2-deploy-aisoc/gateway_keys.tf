#############################################
# AISOC gateway authorization keys
#
# Goal:
# - Generate per-deployment READ/WRITE keys
# - Store them in Key Vault
# - Inject them into the Function App via Key Vault references
#############################################

resource "random_string" "aisoc_read_key" {
  length  = 40
  upper   = true
  lower   = true
  numeric = true
  special = false
}

resource "random_string" "aisoc_write_key" {
  length  = 40
  upper   = true
  lower   = true
  numeric = true
  special = false
}

resource "azurerm_key_vault_secret" "aisoc_read_key" {
  name         = "AISOC-READ-KEY"
  value        = random_string.aisoc_read_key.result
  key_vault_id = azurerm_key_vault.kv.id
}

resource "azurerm_key_vault_secret" "aisoc_write_key" {
  name         = "AISOC-WRITE-KEY"
  value        = random_string.aisoc_write_key.result
  key_vault_id = azurerm_key_vault.kv.id
}
