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
}

resource "random_password" "pixelagents_token" {
  length  = 32
  special = false
}

resource "azurerm_container_app" "pixelagents" {
  name                         = var.pixelagents_container_app_name
  resource_group_name          = var.resource_group
  container_app_environment_id = local.env_id
  revision_mode                = "Single"

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
