#############################################
# Maison Miró — intentionally-vulnerable store (Flask/gunicorn on ACA).
#
# The public web victim. Runs in the shared `shipcp` Container Apps environment
# (see ship_control_panel.tf) so its stdout is shipped to the same Sentinel
# workspace's ContainerAppConsoleLogs_CL, tagged ContainerName_s = "maison-miro".
# The app prints structured `[EVENT] {json}` lines; the analytic rules in
# post_apply_scripts.tf parse them with parse_json(substring(Log_s, 8)).
#
# Image is vendored + built by .github/workflows/deploy-maison-miro.yml (GHCR).
# Pinned to a single replica: Maison's SOC control-plane state (/soc/*, honeytoken
# containment) is in-memory per process, so >1 replica would diverge.
#############################################

locals {
  maison_name = "ca-maison-miro-${random_string.suffix.result}"
}

resource "azurerm_container_app" "maison" {
  name                         = local.maison_name
  resource_group_name          = azurerm_resource_group.rg.name
  container_app_environment_id = azurerm_container_app_environment.shipcp.id
  revision_mode                = "Single"

  ingress {
    external_enabled = true
    target_port      = 8000
    transport        = "auto"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  secret {
    name  = "soc-key"
    value = var.soc_key
  }

  secret {
    name  = "sign-secret"
    value = var.sign_secret
  }

  template {
    min_replicas = 1
    max_replicas = 1

    container {
      name   = "maison-miro"
      image  = var.maison_image
      cpu    = 0.5
      memory = "1Gi"

      env {
        name  = "PORT"
        value = "8000"
      }
      env {
        name  = "SOC_ARMED"
        value = var.soc_armed
      }
      env {
        name        = "SOC_KEY"
        secret_name = "soc-key"
      }
      env {
        name        = "SIGN_SECRET"
        secret_name = "sign-secret"
      }
    }
  }

  tags = local.tags
}
