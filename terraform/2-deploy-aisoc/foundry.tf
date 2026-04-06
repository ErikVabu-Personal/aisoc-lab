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

terraform {
  required_providers {
    azapi = {
      source  = "Azure/azapi"
      version = "~> 2.0"
    }
  }
}

# AzAPI uses the same Azure authentication context as azurerm.
provider "azapi" {}

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

  # Prefer stable. Switch to 2026-01-15-preview only if we hit missing fields.
  foundry_api_version = "2025-12-01"
}

resource "azapi_resource" "foundry_account" {
  count = var.foundry_hub_name == null ? 0 : 1

  type      = "Microsoft.CognitiveServices/accounts@${local.foundry_api_version}"
  name      = var.foundry_hub_name
  location  = local.foundry_location_effective
  parent_id = local.foundry_rg_id

  body = jsonencode({
    kind = "AIServices"
    sku  = { name = "S0" }
    properties = {
      # Keep minimal; expand if your tenant requires specific network/auth settings.
      customSubDomainName = var.foundry_hub_name
    }
  })
}

resource "azapi_resource" "foundry_project" {
  count = var.foundry_project_name == null || var.foundry_hub_name == null ? 0 : 1

  type      = "Microsoft.CognitiveServices/accounts/projects@${local.foundry_api_version}"
  name      = var.foundry_project_name
  location  = local.foundry_location_effective
  parent_id = azapi_resource.foundry_account[0].id

  body = jsonencode({
    properties = {}
  })
}
