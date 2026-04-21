#############################################
# Azure AI Foundry (Hub + Project) via AzAPI
#
# NOTE:
# - Foundry control-plane resource types evolve quickly.
# - We intentionally provision Hub/Project using azapi_resource.
# - Agent/model deployment is handled by a script (scripts/deploy_agents.py)
#   reading Terraform outputs.
#############################################

# The exact resource types & apiVersions may need adjustment depending on
# your tenant/region and current Azure RP versions.

locals {
  foundry_location_effective = coalesce(var.foundry_location, local.location_effective)
}

# Foundry control-plane mapping (based on provider discovery):
# - Hub/Account: Microsoft.CognitiveServices/accounts
# - Project:     Microsoft.CognitiveServices/accounts/projects
#
# Erik confirmed these resourceTypes + stable apiVersions are available.
# We pin to a stable apiVersion by default.

locals {
  foundry_rg_id = "/subscriptions/${data.azurerm_client_config.current.subscription_id}/resourceGroups/${data.terraform_remote_state.sentinel.outputs.resource_group}"

  # Match Microsoft Learn doc for Foundry AzAPI resources.
  # This significantly reduces flaky 500s from the control plane.
  foundry_api_version = "2025-06-01"

  # Auto-generate globally-unique-ish names if not provided.
  # (Cognitive Services account names must be unique and follow specific rules.)
  foundry_hub_name_effective     = coalesce(var.foundry_hub_name, "aisoc-hub-${random_string.suffix.result}")
  foundry_project_name_effective = coalesce(var.foundry_project_name, "aisoc-project-${random_string.suffix.result}")

  # customSubDomainName must be globally unique and may remain reserved for ~48h after delete.
  # Use a dedicated random suffix to avoid collisions when recreating resources.
  foundry_custom_subdomain = "aisoc-${random_string.suffix.result}-${random_string.cs_subdomain.result}"
}

resource "azapi_resource" "foundry_account" {
  type                      = "Microsoft.CognitiveServices/accounts@${local.foundry_api_version}"
  name                      = local.foundry_hub_name_effective
  location                  = local.foundry_location_effective
  parent_id                 = local.foundry_rg_id
  schema_validation_enabled = false

  body = {
    kind = "AIServices"
    sku  = { name = "S0" }

    identity = {
      type = "SystemAssigned"
    }

    properties = {
      disableLocalAuth        = false
      allowProjectManagement  = true
      customSubDomainName     = local.foundry_custom_subdomain
    }
  }
}

resource "azapi_resource" "foundry_project" {
  # Creating Foundry projects via ARM/AzAPI can be extremely slow and often
  # hits provider deadlines. Prefer using scripts/deploy_foundry_project.py.
  count = var.foundry_manage_project_in_terraform ? 1 : 0

  type      = "Microsoft.CognitiveServices/accounts/projects@${local.foundry_api_version}"
  name      = local.foundry_project_name_effective
  parent_id = azapi_resource.foundry_account.id

  # Be explicit: ensure account creation/update is fully applied before project.
  depends_on = [azapi_resource.foundry_account]

  location                  = local.foundry_location_effective
  schema_validation_enabled = false

  body = {
    sku = { name = "S0" }

    identity = {
      type = "SystemAssigned"
    }

    properties = {
      displayName = local.foundry_project_name_effective
      description = "AISOC demo project"
    }
  }
}
