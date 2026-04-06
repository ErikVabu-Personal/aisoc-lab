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

# TODO: Confirm the correct resource types/apiVersions for Foundry Hub/Project.
# We keep this as a scaffold so the repo has the intended shape.

# Example placeholders (WILL need verification):
# resource "azapi_resource" "foundry_hub" {
#   type      = "Microsoft.MachineLearningServices/workspaces@2024-04-01"
#   name      = var.foundry_hub_name
#   location  = local.foundry_location_effective
#   parent_id = "/subscriptions/${data.azurerm_client_config.current.subscription_id}/resourceGroups/${data.terraform_remote_state.sentinel.outputs.resource_group}"
#   body = jsonencode({
#     properties = {
#       # ...
#     }
#   })
# }
#
# resource "azapi_resource" "foundry_project" {
#   type      = "<FOUNDY_PROJECT_TYPE>@<API_VERSION>"
#   name      = var.foundry_project_name
#   location  = local.foundry_location_effective
#   parent_id = azapi_resource.foundry_hub.id
#   body      = jsonencode({ properties = {} })
# }
