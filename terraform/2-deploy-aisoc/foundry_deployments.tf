#############################################
# Foundry model deployment
#
# Creates a model deployment in the Foundry hub/account so agents can use it.
#
# Variables:
# - foundry_model_choice
# - foundry_model_version
# - foundry_model_deployment_name
#############################################

resource "azapi_resource" "foundry_model_deployment" {
  count = var.foundry_model_deployment_name != null && var.foundry_model_choice != null && var.foundry_model_version != null ? 1 : 0

  type      = "Microsoft.CognitiveServices/accounts/deployments@2023-05-01"
  name      = var.foundry_model_deployment_name
  parent_id = azapi_resource.foundry_account.id

  schema_validation_enabled = false

  body = {
    sku = {
      name     = var.foundry_model_sku_name
      capacity = var.foundry_model_sku_capacity
    }

    properties = {
      model = {
        format  = "OpenAI"
        name    = var.foundry_model_choice
        version = var.foundry_model_version
      }
    }
  }

  # Microsoft.CognitiveServices/accounts only allows one mutation at
  # a time on the parent resource. When the primary deployment + the
  # extras are scheduled in parallel by Terraform, the loser hits a
  # 409 RequestConflict ("Another operation is being performed on the
  # parent resource"). Retry on that error class — Azure clears the
  # lock as the in-flight op finishes, usually in seconds.
  retry = {
    error_message_regex  = ["RequestConflict", "another operation is being performed"]
    interval_seconds     = 10
    max_interval_seconds = 60
    multiplier           = 1.5
    randomization_factor = 0.5
  }

  depends_on = [azapi_resource.foundry_account]
}

# Additional deployments — each entry in
# var.foundry_additional_model_deployments creates one extra model
# deployment in the Foundry account. The /config UI lists all of these
# (plus the primary above) and lets the SOC manager re-bind any agent
# to a different deployment via the Foundry agents-API.
resource "azapi_resource" "foundry_extra_model_deployments" {
  for_each = {
    for d in var.foundry_additional_model_deployments :
    d.deployment_name => d
  }

  type      = "Microsoft.CognitiveServices/accounts/deployments@2023-05-01"
  name      = each.value.deployment_name
  parent_id = azapi_resource.foundry_account.id

  schema_validation_enabled = false

  body = {
    sku = {
      name     = each.value.sku_name
      capacity = each.value.sku_capacity
    }

    properties = {
      model = {
        format  = "OpenAI"
        name    = each.value.model_name
        version = each.value.model_version
      }
    }
  }

  # Same conflict-retry as the primary. Plus depend on the primary
  # so we don't even attempt the extras until the primary settles —
  # halves the contention on the parent resource.
  retry = {
    error_message_regex  = ["RequestConflict", "another operation is being performed"]
    interval_seconds     = 10
    max_interval_seconds = 60
    multiplier           = 1.5
    randomization_factor = 0.5
  }

  depends_on = [
    azapi_resource.foundry_account,
    azapi_resource.foundry_model_deployment,
  ]
}

# Output a JSON-serialisable list of every available deployment
# (primary + extras) so Phase 3 can wire it into the PixelAgents Web
# Container App as AISOC_AVAILABLE_MODEL_DEPLOYMENTS. Read by
# pixelagents_web's _available_model_deployments() helper.
locals {
  foundry_available_deployments = concat(
    var.foundry_model_deployment_name != null && var.foundry_model_choice != null && var.foundry_model_version != null ? [
      {
        name        = var.foundry_model_deployment_name
        model       = var.foundry_model_choice
        version     = var.foundry_model_version
        label       = var.foundry_model_deployment_name
        description = "Default deployment used by every agent at first deploy."
      }
    ] : [],
    [
      for d in var.foundry_additional_model_deployments : {
        name        = d.deployment_name
        model       = d.model_name
        version     = d.model_version
        label       = d.label != "" ? d.label : d.deployment_name
        description = d.description
      }
    ]
  )
}

output "foundry_available_deployments_json" {
  description = "JSON-encoded list of every Foundry model deployment created by this phase. Phase 3 wires this into PixelAgents Web as AISOC_AVAILABLE_MODEL_DEPLOYMENTS so the /config dropdown can list them."
  value       = jsonencode(local.foundry_available_deployments)
}
