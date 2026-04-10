locals {
  use_existing_env = length(trimspace(var.container_app_environment_id)) > 0
}

resource "azurerm_log_analytics_workspace" "aca" {
  count               = local.use_existing_env || !var.create_log_analytics ? 0 : 1
  name                = "law-shipcp-aca"
  location            = var.location
  resource_group_name = var.resource_group
  sku                 = "PerGB2018"
  retention_in_days   = 30
}

resource "azurerm_container_app_environment" "env" {
  count               = local.use_existing_env ? 0 : 1
  name                = "cae-shipcp"
  location            = var.location
  resource_group_name = var.resource_group

  log_analytics_workspace_id = var.create_log_analytics ? azurerm_log_analytics_workspace.aca[0].id : null
}

locals {
  env_id = local.use_existing_env ? var.container_app_environment_id : azurerm_container_app_environment.env[0].id
}

resource "azurerm_container_app" "shipcp" {
  name                         = var.app_name
  resource_group_name          = var.resource_group
  container_app_environment_id = local.env_id
  revision_mode                = "Single"

  ingress {
    external_enabled = true
    target_port      = var.ingress_port
    transport        = "auto"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    container {
      name   = "ship-control-panel"
      image  = var.image
      cpu    = 0.5
      memory = "1Gi"

      env {
        name  = "PORT"
        value = tostring(var.ingress_port)
      }

      # optional: set a consistent host binding
      env {
        name  = "HOSTNAME"
        value = "0.0.0.0"
      }
    }
  }
}

output "ship_control_panel_url" {
  value = "https://${azurerm_container_app.shipcp.ingress[0].fqdn}"
}
