locals {
  rg_name = data.terraform_remote_state.sentinel.outputs.resource_group
  tags = {
    project = "aisoc-lab"
    managed = "terraform"
  }
}

# Log Analytics workspace for Container Apps logs
resource "azurerm_log_analytics_workspace" "aca" {
  name                = "law-aisoc-runner-${random_string.suffix.result}"
  location            = var.location
  resource_group_name = local.rg_name
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = local.tags
}

resource "azurerm_container_app_environment" "env" {
  name                       = "cae-aisoc-runner-${random_string.suffix.result}"
  location                   = var.location
  resource_group_name        = local.rg_name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.aca.id
  tags                       = local.tags
}

# Bearer token used to protect runner
resource "random_string" "runner_token" {
  length  = 48
  upper   = true
  lower   = true
  numeric = true
  special = false
}

resource "azurerm_key_vault_secret" "runner_token" {
  name         = "AISOC-RUNNER-BEARER"
  value        = random_string.runner_token.result
  key_vault_id = data.terraform_remote_state.aisoc.outputs.key_vault_id
}

# NOTE: Azure Functions function keys are secrets that should not be stored in Terraform state.
# You will set SOCGATEWAY_FUNCTION_CODE on the Container App after deploy.

# Runner app
resource "azurerm_container_app" "runner" {
  name                         = "ca-aisoc-runner-${random_string.suffix.result}"
  container_app_environment_id  = azurerm_container_app_environment.env.id
  resource_group_name           = local.rg_name
  revision_mode                 = "Single"

  ingress {
    external_enabled = true
    target_port      = 8080
    transport        = "auto"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  secret {
    name  = "runner-bearer"
    value = azurerm_key_vault_secret.runner_token.value
  }

  # SOCGATEWAY_FUNCTION_CODE is set post-deploy (avoid putting function keys in TF state)

  secret {
    name  = "socgateway-read-key"
    value = data.terraform_remote_state.aisoc.outputs.aisoc_read_key_value
  }

  secret {
    name  = "socgateway-write-key"
    value = data.terraform_remote_state.aisoc.outputs.aisoc_write_key_value
  }

  template {
    container {
      name   = "runner"
      image  = var.image
      cpu    = var.runner_cpu
      memory = var.runner_memory

      env {
        name  = "RUNNER_BEARER_TOKEN"
        secret_name = "runner-bearer"
      }

      env {
        name  = "SOCGATEWAY_BASE_URL"
        value = "https://${data.terraform_remote_state.aisoc.outputs.soc_gateway_function_name}.azurewebsites.net/api"
      }

      # SOCGATEWAY_FUNCTION_CODE set post-deploy

      env {
        name        = "SOCGATEWAY_READ_KEY"
        secret_name = "socgateway-read-key"
      }

      env {
        name        = "SOCGATEWAY_WRITE_KEY"
        secret_name = "socgateway-write-key"
      }

      env {
        name  = "ENABLE_WRITES"
        value = var.enable_writes ? "1" : "0"
      }
    }
  }

  tags = local.tags
}

output "runner_url" {
  value = azurerm_container_app.runner.ingress[0].fqdn
}

output "runner_bearer_token_secret_name" {
  value = azurerm_key_vault_secret.runner_token.name
}
