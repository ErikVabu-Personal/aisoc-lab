#############################################
# Ship Control Panel (Next.js) — Azure Container Apps
#
# This is part of Phase 1 by request (demo convenience).
# Image is built/published via GitHub Actions:
#   ghcr.io/erikvabu-personal/aisoc-ship-control-panel:<SHA>
#############################################

locals {
  shipcp_name = "ca-ship-control-panel-${random_string.suffix.result}"
}

# Reuse existing Log Analytics workspace for ACA env logs
resource "azurerm_container_app_environment" "shipcp" {
  name                = "cae-shipcp-${random_string.suffix.result}"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name

  log_analytics_workspace_id = azurerm_log_analytics_workspace.law.id

  tags = local.tags
}

resource "azurerm_container_app" "shipcp" {
  name                         = local.shipcp_name
  resource_group_name          = azurerm_resource_group.rg.name
  container_app_environment_id = azurerm_container_app_environment.shipcp.id
  revision_mode                = "Single"

  ingress {
    external_enabled = true
    target_port      = 3000
    transport        = "auto"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    container {
      name   = "ship-control-panel"
      image  = var.ship_control_panel_image
      cpu    = 0.5
      memory = "1Gi"

      env {
        name  = "PORT"
        value = "3000"
      }

      env {
        name  = "HOSTNAME"
        value = "0.0.0.0"
      }
    }
  }

  tags = local.tags
}
