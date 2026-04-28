#############################################
# AISOC Orchestrator (separate Function App)
#
# Triggered by Sentinel automation (Logic App / webhook) to run deterministic
# triage -> investigation -> reporting pipeline.
#############################################

locals {
  orch_prefix = "aisoc-orch"
  orch_sa     = "saorch${random_string.suffix.result}" # must be lowercase
  orch_func   = "func-${local.orch_prefix}-${random_string.suffix.result}"
}

resource "azurerm_storage_account" "orch" {
  name                     = local.orch_sa
  resource_group_name      = data.terraform_remote_state.sentinel.outputs.resource_group
  location                 = local.location_effective
  account_tier             = "Standard"
  account_replication_type = "LRS"

  allow_nested_items_to_be_public = false

  tags = local.tags
}

resource "azurerm_linux_function_app" "orchestrator" {
  name                = local.orch_func
  resource_group_name = data.terraform_remote_state.sentinel.outputs.resource_group
  location            = local.location_effective

  service_plan_id            = azurerm_service_plan.fa.id
  storage_account_name       = azurerm_storage_account.orch.name
  storage_account_access_key = azurerm_storage_account.orch.primary_access_key

  identity {
    type = "SystemAssigned"
  }

  site_config {
    application_stack {
      python_version = "3.11"
    }
  }

  app_settings = {
    "FUNCTIONS_WORKER_RUNTIME" = "python"
    "WEBSITE_RUN_FROM_PACKAGE" = "1"

    # Foundry inference via SDK
    "AZURE_AI_FOUNDRY_PROJECT_ENDPOINT" = local.foundry_project_endpoint_effective
    "AZURE_AI_MODEL_DEPLOYMENT"         = var.foundry_model_deployment_name

    # Runner (created in this phase)
    "RUNNER_URL" = "https://${azurerm_container_app.runner.ingress[0].fqdn}"

    # Key Vault for secrets (Phase 1 KV)
    "KEYVAULT_URI" = local.shared_kv_uri

    # Name of secret containing runner bearer
    "AISOC_RUNNER_BEARER_SECRET_NAME" = "AISOC-RUNNER-BEARER"

    # Default agent confidence threshold (0–100). Tunes how readily
    # the investigator + reporter reach for ask_human mid-flow. The
    # PixelAgents Web /config slider overrides this per-request; the
    # env var is the fallback when no slider value has been set yet.
    "AISOC_CONFIDENCE_THRESHOLD" = "50"

    # Per-incident cost accounting. PIXELAGENTS_URL + PIXELAGENTS_TOKEN
    # are set post-apply by scripts/configure_orchestrator_pixelagents_env.sh
    # (similar to configure_runner_pixelagents_env.sh — cross-phase wiring).
    "TOKEN_PRICE_EUR_PER_1M_INPUT"  = tostring(var.foundry_model_price_eur_per_1m_in)
    "TOKEN_PRICE_EUR_PER_1M_OUTPUT" = tostring(var.foundry_model_price_eur_per_1m_out)

    # Send logs to the Phase 1 Application Insights instance (shared
    # with ShipCP). Without this, the orchestrator's `print()` lines
    # are only reachable via `az webapp log tail`, which doesn't
    # support querying historic data.
    "APPLICATIONINSIGHTS_CONNECTION_STRING" = data.terraform_remote_state.sentinel.outputs.application_insights_connection_string
    # Functions-runtime hook so the host streams traces too.
    "ApplicationInsightsAgent_EXTENSION_VERSION" = "~3"
  }

  tags = local.tags
}

# Give orchestrator MI read access to shared KV secrets
resource "azurerm_key_vault_access_policy" "orch_secrets" {
  key_vault_id = local.shared_kv_id
  tenant_id    = data.azurerm_client_config.current.tenant_id
  object_id    = azurerm_linux_function_app.orchestrator.identity[0].principal_id

  # Needs both get + list for reliable secret retrieval/debugging.
  # Without this, the orchestrator cannot fetch AISOC-RUNNER-BEARER from KV.
  secret_permissions = ["Get", "List"]
}

# Foundry permissions for orchestrator MI.
#
# - Cognitive Services OpenAI User: allows calling model deployments.
# - Azure AI User: allows invoking Foundry Agent Service operations (agents/write).
resource "azurerm_role_assignment" "orch_foundry_openai_user" {
  scope                = azapi_resource.foundry_account.id
  role_definition_name = "Cognitive Services OpenAI User"

  principal_id = azurerm_linux_function_app.orchestrator.identity[0].principal_id
}

resource "azurerm_role_assignment" "orch_foundry_ai_user" {
  scope                = azapi_resource.foundry_account.id
  role_definition_name = "Azure AI User"

  principal_id = azurerm_linux_function_app.orchestrator.identity[0].principal_id
}

# Some data-plane checks evaluate permissions at the *project* scope.
# Create a project-scope assignment as well.

output "orchestrator_function_name" {
  value       = azurerm_linux_function_app.orchestrator.name
  description = "AISOC Orchestrator Function App name."
}

output "orchestrator_principal_id" {
  value       = azurerm_linux_function_app.orchestrator.identity[0].principal_id
  description = "Orchestrator managed identity principal id."
}

# Base URL + default host key so other services (e.g. PixelAgents Web) can
# invoke the orchestrator over HTTP without us having to wire per-caller
# credentials. The data source reads the live function key at apply time,
# which means it will pick up any rotation that happens as a side effect
# of redeploying the function code.
data "azurerm_function_app_host_keys" "orchestrator" {
  name                = azurerm_linux_function_app.orchestrator.name
  resource_group_name = data.terraform_remote_state.sentinel.outputs.resource_group

  depends_on = [azurerm_linux_function_app.orchestrator]
}

output "orchestrator_url" {
  value       = "https://${azurerm_linux_function_app.orchestrator.default_hostname}/api/orchestrate"
  description = "Base URL for the AISOC Orchestrator Function App. Append /incident/pipeline for the full triage→investigator→reporter route."
}

output "orchestrator_function_key" {
  value       = data.azurerm_function_app_host_keys.orchestrator.default_function_key
  sensitive   = true
  description = "Default host function key for invoking the orchestrator. Required because the orchestrator uses authLevel=function."
}
