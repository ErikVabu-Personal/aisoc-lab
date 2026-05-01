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

      # Knowledge-base inspection endpoints (/kb page in the SOC UI).
      # The page lists each KB with its current document count and
      # exposes a refresh-now button that triggers the corresponding
      # AI Search indexer. These env vars give the FastAPI backend
      # what it needs to:
      #   - call the Search service's data plane to read $count
      #   - call the Search service's data plane to run the indexer
      # Auth uses the Container App's MI; see the role assignment
      # `pixelagents_search_kb_contributor` below.
      env {
        name  = "AISOC_KB_SEARCH_ENDPOINT"
        value = try(data.terraform_remote_state.aisoc.outputs.detection_rules_search_endpoint, "")
      }
      env {
        # JSON list of {name, label, description, index, indexer}
        # tuples that the /kb page enumerates. Keeps the backend
        # data-driven rather than hardcoding the three KBs in
        # Python — easy to extend when we add a 4th source later.
        name = "AISOC_KB_DESCRIPTORS_JSON"
        value = jsonencode([
          {
            name        = "detection-rules"
            label       = "Detection Rules"
            description = "Sigma / KQL / writeups for the Detection Engineer agent. Auto-refreshed daily from the SigmaHQ/sigma upstream by the refresh-detection-rules workflow."
            index       = "detection-rules-idx"
            indexer     = "detection-rules-indexer"
            agents      = ["detection-engineer"]
          },
          {
            name        = "company-context"
            label       = "Company Context (SOC-curated)"
            description = "Fleet, subsystems, account naming, IR runbooks, glossary, escalation matrix, org chart. Edited by the SOC manager (markdown in blob); the indexer picks up changes within 30 min of upload."
            index       = "company-context-idx"
            indexer     = "company-context-indexer"
            agents      = ["triage", "investigator", "reporter", "soc-manager", "threat-intel"]
          },
          {
            name        = "company-policies"
            label       = "Company Policies (HR/IT-curated)"
            description = "Acceptable-use policy + asset inventory. Federated into the same Foundry IQ knowledge base as company-context (single MCP endpoint, two underlying sources)."
            index       = "company-policies-idx"
            indexer     = "company-policies-indexer"
            agents      = ["triage", "investigator", "reporter", "soc-manager", "threat-intel"]
          },
        ])
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

      # Catalog of Foundry model deployments the SOC manager can
      # pick from in /config (the per-agent model dropdown).
      #
      # Preferred source: Phase 2's foundry_available_deployments_json
      # output — it includes the primary deployment + every entry in
      # foundry_additional_model_deployments.
      #
      # Fallback: when that output isn't present yet (Phase 2 hasn't
      # re-applied since the multi-deployment work landed), build a
      # single-entry catalog from the long-standing
      # foundry_model_deployment_name output. That way re-applying
      # Phase 3 alone is enough to get the primary deployment into the
      # dropdown — the user only needs to re-apply Phase 2 too if they
      # want the additional deployments.
      env {
        name = "AISOC_AVAILABLE_MODEL_DEPLOYMENTS"
        value = try(
          data.terraform_remote_state.aisoc.outputs.foundry_available_deployments_json,
          jsonencode([{
            name        = data.terraform_remote_state.aisoc.outputs.foundry_model_deployment_name
            model       = data.terraform_remote_state.aisoc.outputs.foundry_model_deployment_name
            version     = ""
            label       = data.terraform_remote_state.aisoc.outputs.foundry_model_deployment_name
            description = "Primary Foundry deployment (re-apply Phase 2 to expose additional models)."
          }]),
          "[]"
        )
      }

      # Mirror the orchestrator's primary model deployment name onto
      # PA-Web. Used by _available_model_deployments() as a final
      # fallback when AISOC_AVAILABLE_MODEL_DEPLOYMENTS is genuinely
      # empty — keeps the dropdown sensible even on a fresh deploy
      # where neither output is present yet.
      env {
        name  = "AZURE_AI_MODEL_DEPLOYMENT"
        value = try(data.terraform_remote_state.aisoc.outputs.foundry_model_deployment_name, "")
      }

      # Agent roster — single source of truth lives in
      # terraform/2-deploy-aisoc/agents/agents.json (read by both the
      # Phase 2 deploy script and Terraform's jsondecode). Wiring the
      # slug list through here as PIXELAGENTS_AGENT_ROSTER means PA-Web
      # initialises state for exactly the agents that Phase 2 actually
      # deployed, instead of relying on a hardcoded fallback that can
      # drift.
      env {
        name  = "PIXELAGENTS_AGENT_ROSTER"
        value = try(data.terraform_remote_state.aisoc.outputs.agent_roster_slugs, "")
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

# AI Search data + control plane access for the /kb page in the SOC UI:
#   - read $count on each KB index (data plane)
#   - run the indexer manually via the refresh button (data plane)
# Search Service Contributor covers both. Same role we use elsewhere
# for the project MI / deploying user — the role's broad enough to
# cover the new "list KBs from the portal" path too.
#
# Scope is constructed from the Search endpoint (Phase 2 doesn't
# export the ARM id directly; the endpoint hostname's first label
# IS the service name, which is the only piece of the ARM id that
# isn't statically derivable from the RG).
locals {
  pixelagents_search_endpoint    = try(data.terraform_remote_state.aisoc.outputs.detection_rules_search_endpoint, "")
  # https://<svc>.search.windows.net → <svc>
  pixelagents_search_service_name = trimprefix(
    replace(local.pixelagents_search_endpoint, ".search.windows.net", ""),
    "https://"
  )
  pixelagents_search_service_id = (
    local.pixelagents_search_service_name == ""
      ? ""
      : "/subscriptions/${data.terraform_remote_state.aisoc.outputs.subscription_id}/resourceGroups/${data.terraform_remote_state.sentinel.outputs.resource_group}/providers/Microsoft.Search/searchServices/${local.pixelagents_search_service_name}"
  )
  pixelagents_search_role_enabled = local.pixelagents_search_service_id != ""
}

resource "azurerm_role_assignment" "pixelagents_search_kb_contributor" {
  count                = local.pixelagents_search_role_enabled ? 1 : 0
  scope                = local.pixelagents_search_service_id
  role_definition_name = "Search Service Contributor"
  principal_id         = local.pixelagents_principal_id
  description          = "PixelAgents Web reads KB doc counts + triggers indexers from the /kb page."
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
