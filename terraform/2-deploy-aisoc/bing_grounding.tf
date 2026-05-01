#############################################
# Bing Grounding for the Threat Intel agent
#
# Provisions a Microsoft.Bing/accounts resource (kind=Bing.Grounding)
# so the Threat Intel agent has a real first-party Foundry web-search
# tool. The Foundry project connection that wraps this resource is
# created lazily by scripts/deploy_prompt_agents_with_runner_tools.py
# at agent-deploy time (the project itself is created post-apply by
# scripts/deploy_foundry_project.py — see foundry.tf for why the
# project resource isn't in Terraform).
#
# Subscription pre-req: Microsoft.Bing must be a registered RP and
# the Bing Search legal terms must be accepted on the subscription
# (one-time click in Azure portal). When ToS hasn't been accepted,
# the create call fails with a clear error message — set
# bing_grounding_enabled=false in your tfvars to skip.
#############################################

locals {
  bing_enabled    = var.bing_grounding_enabled
  bing_account_name = "aisoc-bing-${random_string.suffix.result}"
}

resource "azapi_resource" "bing_grounding" {
  count     = local.bing_enabled ? 1 : 0
  type      = "Microsoft.Bing/accounts@2020-06-10"
  name      = local.bing_account_name
  parent_id = local.foundry_rg_id

  # Bing services are global (the resource is metadata-only — actual
  # search runs in Microsoft's Bing infrastructure).
  location = "global"

  body = {
    kind = "Bing.Grounding"
    sku = {
      name = var.bing_grounding_sku
    }
    properties = {
      # statisticsEnabled is the only mutable property at create time.
      statisticsEnabled = false
    }
  }

  schema_validation_enabled = false
  response_export_values    = ["id", "name"]

  # Read the API keys via the resource action — we surface them as a
  # sensitive output so the agent deploy script can plumb the key
  # into the Foundry project connection without round-tripping
  # through state. response_export_values is at the resource level;
  # keys come from the listKeys action below.
}

# Pull the API keys for the Bing account. Used by the agent deploy
# script to create the Foundry project connection's credentials. The
# action is sensitive — never logged, only outputted.
data "azapi_resource_action" "bing_grounding_keys" {
  count                  = local.bing_enabled ? 1 : 0
  type                   = "Microsoft.Bing/accounts@2020-06-10"
  resource_id            = azapi_resource.bing_grounding[0].id
  action                 = "listKeys"
  method                 = "POST"
  response_export_values = ["key1", "key2"]
}


# ── Outputs (consumed by the agent deploy script) ───────────────────

output "bing_grounding_enabled" {
  description = "Whether the Bing Grounding subsystem is provisioned in this state."
  value       = local.bing_enabled
}

output "bing_grounding_account_name" {
  description = "Microsoft.Bing/accounts name (used as the Foundry project connection name)."
  value       = local.bing_enabled ? local.bing_account_name : ""
}

output "bing_grounding_account_id" {
  description = "ARM ID of the Microsoft.Bing/accounts resource."
  value       = local.bing_enabled ? azapi_resource.bing_grounding[0].id : ""
}

output "bing_grounding_api_key" {
  description = "Bing Grounding primary API key — written into the Foundry project connection's credentials. Treat as a secret."
  value       = local.bing_enabled ? data.azapi_resource_action.bing_grounding_keys[0].output.key1 : ""
  sensitive   = true
}
