locals {
  use_existing_env = length(trimspace(var.container_app_environment_id)) > 0
}

resource "azurerm_log_analytics_workspace" "aca" {
  count               = local.use_existing_env || !var.create_log_analytics ? 0 : 1
  name                = "law-pixelagents-aca"
  location            = var.location
  resource_group_name = var.resource_group
  sku                 = "PerGB2018"
  retention_in_days   = 30
}

resource "azurerm_container_app_environment" "env" {
  count               = local.use_existing_env ? 0 : 1
  name                = "cae-pixelagents"
  location            = var.location
  resource_group_name = var.resource_group

  log_analytics_workspace_id = var.create_log_analytics ? azurerm_log_analytics_workspace.aca[0].id : null
}

locals {
  env_id = local.use_existing_env ? var.container_app_environment_id : azurerm_container_app_environment.env[0].id

  kv_secret_uri = var.key_vault_name != "" ? "https://${var.key_vault_name}.vault.azure.net/secrets/${var.runner_bearer_secret_name}/" : ""
}

resource "random_password" "pixelagents_token" {
  length  = 32
  special = false
}

# Optional: grant PixelAgents Web managed identity access to the Key Vault secret (RBAC).
# This only applies when key_vault_name is set.

data "azurerm_key_vault" "kv" {
  count               = var.key_vault_name != "" ? 1 : 0
  name                = var.key_vault_name
  resource_group_name = var.resource_group
}

resource "azurerm_role_assignment" "pixelagents_kv_secrets_user" {
  count                = var.key_vault_name != "" ? 1 : 0
  scope                = data.azurerm_key_vault.kv[0].id
  role_definition_name = "Key Vault Secrets User"
  principal_id         = azurerm_container_app.pixelagents.identity[0].principal_id
}

resource "azurerm_container_app" "pixelagents" {
  name                         = var.pixelagents_container_app_name
  resource_group_name          = var.resource_group
  container_app_environment_id = local.env_id
  revision_mode                = "Single"

  identity {
    type = "SystemAssigned"
  }

  ingress {
    external_enabled = true
    target_port      = 8080
    transport        = "auto"
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    container {
      name   = "pixelagents-web"
      image  = var.image
      cpu    = 0.5
      memory = "1Gi"

      env {
        name        = "PIXELAGENTS_TOKEN"
        secret_name = "pixelagents-token"
      }

      env {
        name  = "PORT"
        value = "8080"
      }

      # Sentinel incidents sidebar wiring (optional)
      env {
        name  = "RUNNER_BASE_URL"
        value = var.runner_base_url
      }

      env {
        name  = "RUNNER_BEARER_TOKEN"
        value = local.kv_secret_uri != "" ? "@Microsoft.KeyVault(SecretUri=${local.kv_secret_uri})" : ""
      }
    }
  }

  secret {
    name  = "pixelagents-token"
    value = random_password.pixelagents_token.result
  }
}

output "pixelagents_url" {
  value = "https://${azurerm_container_app.pixelagents.ingress[0].fqdn}"
}

output "pixelagents_token" {
  value     = random_password.pixelagents_token.result
  sensitive = true
}
