#############################################
# AISOC Runner (Azure Container Apps)
#
# Consolidated from former Phase 3 (terraform/3-deploy-runner).
# Reuses Phase 1 Log Analytics workspace + Container Apps Environment.
#############################################

locals {
  runner_tags = {
    project = "aisoc-lab"
    managed = "terraform"
  }
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
  key_vault_id = azurerm_key_vault.kv.id
}

# NOTE: Azure Functions function keys are secrets that should not be stored in Terraform state.
# You will set SOCGATEWAY_FUNCTION_CODE on the Container App after deploy.

resource "azurerm_container_app" "runner" {
  name                         = "ca-aisoc-runner-${random_string.suffix.result}"
  resource_group_name          = data.terraform_remote_state.sentinel.outputs.resource_group
  container_app_environment_id = data.terraform_remote_state.sentinel.outputs.container_app_environment_id
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

  secret {
    name  = "runner-bearer"
    value = azurerm_key_vault_secret.runner_token.value
  }

  # SOCGATEWAY_FUNCTION_CODE is set post-deploy (avoid putting function keys in TF state)

  secret {
    name  = "socgateway-read-key"
    value = random_string.aisoc_read_key.result
  }

  secret {
    name  = "socgateway-write-key"
    value = random_string.aisoc_write_key.result
  }

  template {
    container {
      name   = "runner"
      image  = var.runner_image
      cpu    = var.runner_cpu
      memory = var.runner_memory

      env {
        name        = "RUNNER_BEARER_TOKEN"
        secret_name = "runner-bearer"
      }

      env {
        name  = "SOCGATEWAY_BASE_URL"
        value = "https://${azurerm_linux_function_app.soc_gateway.default_hostname}/api"
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
        value = var.runner_enable_writes ? "1" : "0"
      }
    }
  }

  tags = local.runner_tags
}
