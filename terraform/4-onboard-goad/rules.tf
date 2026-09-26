# ===========================================================================
# Starter AD-attack Sentinel analytic rules, all keyed off the SecurityEvent
# table (a built-in Sentinel table, so ARM validates the KQL even before GOAD
# data arrives). Each is deployed idempotently via `az rest` PUT, with the rule
# id held in Terraform state so re-applies upgrade in place. Same pattern as
# Phase 1's controlpanel rule. Once these fire, incidents flow to the existing
# Foundry Triage -> Investigator -> Reporter pipeline with no other change.
# ===========================================================================

locals {
  ad_rules = {
    kerberoast = {
      display_name = "GOAD: Kerberoasting - RC4 service ticket requests (4769)"
      description  = "Multiple Kerberos service ticket (TGS) requests with RC4 (0x17) encryption for user service accounts from a single source - classic Kerberoasting."
      severity     = "High"
      tactics      = ["CredentialAccess"]
      query_file   = "kerberoast.kql"
      entities = [
        { entityType = "Account", fieldMappings = [{ identifier = "Name", columnName = "TargetUserName" }] },
        { entityType = "IP", fieldMappings = [{ identifier = "Address", columnName = "IpAddress" }] },
      ]
    }
    dcsync = {
      display_name = "GOAD: DCSync - directory replication by a non-DC account (4662)"
      description  = "A non-machine account requested DS-Replication-Get-Changes rights on the directory (4662 with replication GUIDs) - DCSync credential theft."
      severity     = "High"
      tactics      = ["CredentialAccess"]
      query_file   = "dcsync.kql"
      entities = [
        { entityType = "Account", fieldMappings = [{ identifier = "Name", columnName = "SubjectUserName" }] },
        { entityType = "Host", fieldMappings = [{ identifier = "HostName", columnName = "Computer" }] },
      ]
    }
    password_spray = {
      display_name = "GOAD: Password spray - many accounts from one source (4625/4771)"
      description  = "A single source produced failed logons/pre-auth failures against many distinct accounts in a short window - password spraying."
      severity     = "Medium"
      tactics      = ["CredentialAccess"]
      query_file   = "password_spray.kql"
      entities = [
        { entityType = "IP", fieldMappings = [{ identifier = "Address", columnName = "IpAddress" }] },
      ]
    }
    asrep_roast = {
      display_name = "GOAD: AS-REP roasting - preauth-not-required TGT requests (4768)"
      description  = "Kerberos AS-REQ (4768) with RC4 and no pre-authentication for user accounts - AS-REP roasting against accounts flagged 'do not require preauth'."
      severity     = "High"
      tactics      = ["CredentialAccess"]
      query_file   = "asrep_roast.kql"
      entities = [
        { entityType = "Account", fieldMappings = [{ identifier = "Name", columnName = "TargetUserName" }] },
        { entityType = "IP", fieldMappings = [{ identifier = "Address", columnName = "IpAddress" }] },
      ]
    }
  }
}

resource "random_uuid" "ad_rule" {
  for_each = var.enable_ad_rules ? local.ad_rules : {}
}

resource "null_resource" "ad_rule" {
  for_each = var.enable_ad_rules ? local.ad_rules : {}

  triggers = {
    rule_id    = random_uuid.ad_rule[each.key].result
    definition = jsonencode(each.value)
    query      = filemd5("${path.module}/scripts/rules/${each.value.query_file}")
    always_run = timestamp()
  }

  provisioner "local-exec" {
    command = "${path.module}/scripts/deploy_sentinel_scheduled_rule.sh"
    environment = {
      RG                   = local.law_rg
      LAW                  = local.law_name
      RULE_ID              = random_uuid.ad_rule[each.key].result
      DISPLAY_NAME         = each.value.display_name
      DESCRIPTION          = each.value.description
      SEVERITY             = each.value.severity
      TACTICS_JSON         = jsonencode(each.value.tactics)
      ENTITY_MAPPINGS_JSON = jsonencode(each.value.entities)
      QUERY_FILE           = "${path.module}/scripts/rules/${each.value.query_file}"
    }
  }

  depends_on = [azurerm_monitor_data_collection_rule_association.assoc]
}
