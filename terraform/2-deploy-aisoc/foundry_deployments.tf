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

  depends_on = [azapi_resource.foundry_account]
}
