locals {
  # Inherit RG + region from Phase 1 (Sentinel) — same pattern as Phase 2.
  rg_effective       = data.terraform_remote_state.sentinel.outputs.resource_group
  location_effective = data.terraform_remote_state.sentinel.outputs.selected_location

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

  # System-assigned MI so the app can authenticate to Foundry for the ad-hoc
  # chat endpoint (POST /api/agents/{id}/message). See the role assignments
  # below for what this identity is granted.
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
    # Pin to a single replica. The HITL questions (and the polled
    # event/agent state) live in the Python process memory, so a
    # multi-replica deployment will serve stale or missing records
    # depending on which replica a given request lands on — the UI
    # sees "Unknown question id" on answer POSTs whenever the create
    # and submit hit different instances. For the demo this is fine;
    # if we ever need horizontal scale, back HITL_QUESTIONS / EVENTS
    # with Redis or Cosmos and relax this.
    min_replicas = 1
    max_replicas = 1

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

      # Foundry project endpoint for the ad-hoc chat endpoint.
      # Inherited from Phase 2 — same value the orchestrator uses, so the two
      # components never drift out of sync.
      env {
        name  = "AZURE_AI_FOUNDRY_PROJECT_ENDPOINT"
        value = data.terraform_remote_state.aisoc.outputs.foundry_project_endpoint
      }

      # Sentinel incidents table — the backend queries ARM directly with
      # the Container App's managed identity (see the Sentinel Reader
      # role assignment below).
      env {
        name  = "AZURE_SUBSCRIPTION_ID"
        value = data.terraform_remote_state.aisoc.outputs.subscription_id
      }

      env {
        name  = "AZURE_RESOURCE_GROUP"
        value = data.terraform_remote_state.sentinel.outputs.resource_group
      }

      env {
        name  = "SENTINEL_WORKSPACE_NAME"
        value = data.terraform_remote_state.sentinel.outputs.log_analytics_workspace_name
      }

      # Orchestrator trigger — lets the incidents panel kick off the
      # triage→investigator→reporter pipeline on a specific incident. URL
      # and function key come from Phase 2.
      env {
        name  = "ORCHESTRATOR_URL"
        value = data.terraform_remote_state.aisoc.outputs.orchestrator_url
      }

      env {
        name        = "ORCHESTRATOR_FUNCTION_KEY"
        secret_name = "orchestrator-function-key"
      }

      # Per-incident cost accounting — chat-drawer calls also capture
      # response.usage; these prices convert tokens → EUR locally.
      # Sourced from Phase 2 so a price change happens in one place.
      env {
        name  = "TOKEN_PRICE_EUR_PER_1M_INPUT"
        value = tostring(data.terraform_remote_state.aisoc.outputs.foundry_model_price_eur_per_1m_in)
      }

      env {
        name  = "TOKEN_PRICE_EUR_PER_1M_OUTPUT"
        value = tostring(data.terraform_remote_state.aisoc.outputs.foundry_model_price_eur_per_1m_out)
      }

      # Feature flag — set SHOW_COST=0 to hide the Cost column in the
      # incidents panel (e.g. during a public demo where you don't want
      # audience questions about EUR figures).
      env {
        name  = "SHOW_COST"
        value = "1"
      }

      # Demo login roster — JSON object {email: password}. The server
      # falls back to a hardcoded roster if this is empty, so the
      # Container App still boots cleanly on first deploy. Stored as a
      # Container App secret (encrypted at rest in ACA) rather than a
      # plain env value so the password list doesn't show up in
      # `az containerapp show` output.
      env {
        name        = "AISOC_USERS_JSON"
        secret_name = "aisoc-users-json"
      }
    }
  }

  secret {
    name  = "pixelagents-token"
    value = random_password.pixelagents_token.result
  }

  secret {
    name  = "orchestrator-function-key"
    value = data.terraform_remote_state.aisoc.outputs.orchestrator_function_key
  }

  # JSON-encoded user roster. Empty map → "{}" → server-side
  # `_load_users()` sees an empty dict and falls back to the hardcoded
  # bootstrap roster. Non-empty map → server uses these creds.
  secret {
    name  = "aisoc-users-json"
    value = jsonencode(var.pixelagents_users)
  }
}

# PixelAgents MI principal id, pulled through a splat so Terraform can propagate
# the unknown value correctly when the identity block is being added to an
# already-existing container app. Direct `identity[0].principal_id` indexing
# can resolve to null during the refresh of an in-place update, causing
# downstream role_assignments to report "missing principal_id" in a single-pass
# apply. `one(... identity[*].principal_id)` avoids that.
locals {
  pixelagents_principal_id = one(azurerm_container_app.pixelagents.identity[*].principal_id)
}

# Foundry permissions for the PixelAgents MI — mirrors the orchestrator.
#
# - Cognitive Services OpenAI User: allows calling model deployments.
# - Azure AI User: allows invoking Foundry Agent Service operations
#   (needed for /openai/v1/responses with agent_reference).
resource "azurerm_role_assignment" "pixelagents_foundry_openai_user" {
  scope                = data.terraform_remote_state.aisoc.outputs.foundry_account_id
  role_definition_name = "Cognitive Services OpenAI User"
  principal_id         = local.pixelagents_principal_id
}

resource "azurerm_role_assignment" "pixelagents_foundry_ai_user" {
  scope                = data.terraform_remote_state.aisoc.outputs.foundry_account_id
  role_definition_name = "Azure AI User"
  principal_id         = local.pixelagents_principal_id
}

# Sentinel read access for the incidents table endpoint. Scoped to the Log
# Analytics workspace Sentinel runs on (same scope as the SOC Gateway's
# Microsoft Sentinel Contributor assignment in Phase 2, just narrower).
resource "azurerm_role_assignment" "pixelagents_sentinel_reader" {
  scope                = data.terraform_remote_state.sentinel.outputs.log_analytics_workspace_id
  role_definition_name = "Microsoft Sentinel Reader"
  principal_id         = local.pixelagents_principal_id
}

output "pixelagents_principal_id" {
  value       = local.pixelagents_principal_id
  description = "PixelAgents Web managed identity principal id (used for Foundry auth)."
}

output "pixelagents_url" {
  value = "https://${azurerm_container_app.pixelagents.ingress[0].fqdn}"
}

output "pixelagents_token" {
  value     = random_password.pixelagents_token.result
  sensitive = true
}
