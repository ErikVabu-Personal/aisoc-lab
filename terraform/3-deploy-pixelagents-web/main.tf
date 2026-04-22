locals {
  # Default to Phase 1 (Sentinel) RG/location unless explicitly overridden.
  rg_effective       = coalesce(var.resource_group, data.terraform_remote_state.sentinel.outputs.resource_group)
  location_effective = coalesce(var.location, data.terraform_remote_state.sentinel.outputs.selected_location)

  # Prefer reusing Phase 1 Container Apps Environment if available.
  phase1_env_id = try(data.terraform_remote_state.sentinel.outputs.container_app_environment_id, "")

  use_existing_env = length(trimspace(coalesce(var.container_app_environment_id, local.phase1_env_id))) > 0
}

resource "azurerm_log_analytics_workspace" "aca" {
  count               = local.use_existing_env || !var.create_log_analytics ? 0 : 1
  name                = "law-pixelagents-aca"
  location            = local.location_effective
  resource_group_name = local.rg_effective
  sku                 = "PerGB2018"
  retention_in_days   = 30
}

resource "azurerm_container_app_environment" "env" {
  count               = local.use_existing_env ? 0 : 1
  name                = "cae-pixelagents"
  location            = local.location_effective
  resource_group_name = local.rg_effective

  log_analytics_workspace_id = var.create_log_analytics ? azurerm_log_analytics_workspace.aca[0].id : null
}

locals {
  env_id = local.use_existing_env ? coalesce(var.container_app_environment_id, local.phase1_env_id) : azurerm_container_app_environment.env[0].id
}

resource "random_password" "pixelagents_token" {
  length  = 32
  special = false
}

resource "azurerm_container_app" "pixelagents" {
  name                         = var.pixelagents_container_app_name
  resource_group_name          = local.rg_effective
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

      # Wire PixelAgents Web to the Runner, if available from Phase 2.
      # This enables live event streaming without manual env var setup.
      env {
        name  = "AISOC_RUNNER_URL"
        value = try(data.terraform_remote_state.aisoc.outputs.runner_url, "")
      }

      env {
        name  = "AISOC_RUNNER_BEARER_SECRET_NAME"
        value = try(data.terraform_remote_state.aisoc.outputs.runner_bearer_token_secret_name, "")
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
