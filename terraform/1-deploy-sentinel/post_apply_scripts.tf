# Post-apply: Maison Miró Sentinel analytic rules + GitHub repo-var sync.
#
# Rules are deployed by a script (not a TF resource) because their KQL references
# ContainerAppConsoleLogs_CL, which Log Analytics creates lazily on first ingest —
# ARM would reject the rule at create time if the table isn't there yet. The
# script polls for the table (skips with a warning on a cold deploy) then PUTs.
# RULE_IDs are held in Terraform state so re-applies upgrade in place.

variable "github_repo" {
  type        = string
  description = "GitHub repository in 'owner/name' form. Used to sync deploy-target names as repo variables."
  default     = "ErikVabu-Personal/aisoc-lab"
}

locals {
  # Maison Miró emits `[EVENT] {json}` with fields type/severity/source_ip/message.
  # Incidents correlate by source_ip. Two starter rules; add more as needed.
  maison_rules = {
    crown_jewel = {
      display_name = "Maison Miró: crown-jewel theft / fraud (critical)"
      description  = "A critical Maison Miró event — honeytoken touch, bulk PII exfiltration, IDOR on invoices/orders, or checkout price/qty fraud."
      severity     = "High"
      tactics      = ["Collection", "Exfiltration"]
      query_file   = "maison_crown_jewel.kql"
      entities     = [{ entityType = "IP", fieldMappings = [{ identifier = "Address", columnName = "source_ip" }] }]
    }
    web_attack = {
      display_name = "Maison Miró: web attack (SQLi / auth bypass / forged session / XSS)"
      description  = "A high-severity Maison Miró web attack: SQL-injection login, auth bypass, forged admin session, or stored XSS."
      severity     = "Medium"
      tactics      = ["InitialAccess", "CredentialAccess"]
      query_file   = "maison_web_attack.kql"
      entities     = [{ entityType = "IP", fieldMappings = [{ identifier = "Address", columnName = "source_ip" }] }]
    }
  }
}

resource "random_uuid" "maison_rule" {
  for_each = local.maison_rules
}

resource "null_resource" "maison_rule" {
  for_each = local.maison_rules

  triggers = {
    rule_id    = random_uuid.maison_rule[each.key].result
    definition = jsonencode(each.value)
    query      = filemd5("${path.module}/scripts/rules/${each.value.query_file}")
    always_run = timestamp()
  }

  provisioner "local-exec" {
    command = "${path.module}/scripts/deploy_sentinel_scheduled_rule.sh"
    environment = {
      RG                   = azurerm_resource_group.rg.name
      LAW                  = azurerm_log_analytics_workspace.law.name
      WSID                 = azurerm_log_analytics_workspace.law.workspace_id
      READINESS_TABLE      = "ContainerAppConsoleLogs_CL"
      RULE_ID              = random_uuid.maison_rule[each.key].result
      DISPLAY_NAME         = each.value.display_name
      DESCRIPTION          = each.value.description
      SEVERITY             = each.value.severity
      TACTICS_JSON         = jsonencode(each.value.tactics)
      ENTITY_MAPPINGS_JSON = jsonencode(each.value.entities)
      QUERY_FILE           = "${path.module}/scripts/rules/${each.value.query_file}"
    }
  }

  depends_on = [
    azurerm_log_analytics_workspace.law,
    azurerm_container_app.maison,
  ]
}

resource "null_resource" "sync_github_repo_vars_phase1" {
  triggers = {
    repo         = var.github_repo
    aisoc_rg     = azurerm_resource_group.rg.name
    aisoc_maison = azurerm_container_app.maison.name
    always_run   = timestamp()
  }

  provisioner "local-exec" {
    command = "${path.module}/../../scripts/sync_github_repo_var.sh"
    environment = {
      REPO                 = var.github_repo
      AISOC_RESOURCE_GROUP = azurerm_resource_group.rg.name
      AISOC_MAISON_NAME    = azurerm_container_app.maison.name
    }
  }

  depends_on = [
    azurerm_container_app.maison,
  ]
}
