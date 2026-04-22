#############################################
# Sentinel analytics rules (scheduled)
#
# Note: The azurerm provider doesn't consistently expose first-class resources
# for all Sentinel analytics rule kinds. We deploy rules via ARM template.
#############################################

resource "random_uuid" "rule_tpm_wmi" {}

resource "azurerm_resource_group_template_deployment" "sentinel_rule_tpm_wmi" {
  count = (var.sentinel_enabled && var.enable_scheduled_rule_tpm_wmi) ? 1 : 0

  name                = "sentinel-rule-tpm-wmi"
  resource_group_name = azurerm_resource_group.rg.name
  deployment_mode     = "Incremental"

  template_content = jsonencode({
    "$schema"        = "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#"
    contentVersion    = "1.0.0.0"
    parameters        = {}
    variables         = {}
    resources         = [
      {
        type       = "Microsoft.OperationalInsights/workspaces/providers/alertRules"
        apiVersion = "2025-09-01"
        name       = "${azurerm_log_analytics_workspace.law.name}/Microsoft.SecurityInsights/${random_uuid.rule_tpm_wmi.result}"
        kind       = "Scheduled"
        properties = {
          displayName          = "TPM WMI event observed (lab)"
          description          = "Lab rule: creates an incident when Microsoft-Windows-TPM-WMI events are observed."
          enabled              = true
          severity             = "Low"
          query                = "Event\n| where Source == \"Microsoft-Windows-TPM-WMI\""
          queryFrequency       = "PT5M"
          queryPeriod          = "PT5M"
          triggerOperator      = "GreaterThan"
          triggerThreshold     = 0
          suppressionEnabled   = false
          suppressionDuration  = "PT5M"

          incidentConfiguration = {
            createIncident = true
            groupingConfiguration = {
              enabled                 = false
              reopenClosedIncident    = false
              lookbackDuration        = "PT1H"
              matchingMethod          = "AllEntities"
              groupByEntities         = []
              groupByAlertDetails     = []
              groupByCustomDetails    = []
            }
          }

          eventGroupingSettings = {
            aggregationKind = "SingleAlert"
          }

          tactics = []
        }
      }
    ]
    outputs = {}
  })

  depends_on = [
    azurerm_sentinel_log_analytics_workspace_onboarding.sentinel
  ]
}

#############################################
# Control Panel: Failed authentication attempts
#############################################

resource "random_uuid" "rule_controlpanel_auth_failures" {}

resource "azurerm_resource_group_template_deployment" "sentinel_rule_controlpanel_auth_failures" {
  count = (var.sentinel_enabled && var.enable_scheduled_rule_controlpanel_auth_failures) ? 1 : 0

  name                = "sentinel-rule-controlpanel-auth-failures"
  resource_group_name = azurerm_resource_group.rg.name
  deployment_mode     = "Incremental"

  template_content = jsonencode({
    "$schema"        = "https://schema.management.azure.com/schemas/2019-04-01/deploymentTemplate.json#"
    contentVersion    = "1.0.0.0"
    parameters        = {}
    variables         = {}
    resources         = [
      {
        type       = "Microsoft.OperationalInsights/workspaces/providers/alertRules"
        apiVersion = "2025-09-01"
        name       = "${azurerm_log_analytics_workspace.law.name}/Microsoft.SecurityInsights/${random_uuid.rule_controlpanel_auth_failures.result}"
        kind       = "Scheduled"
        properties = {
          displayName     = "Control Panel: multiple failed logins (user + IP)"
          description     = "Creates an incident when repeated auth.login.failure events are observed for the same username from the same client IP within 5 minutes."
          enabled         = true
          severity        = "Medium"
          query           = "ContainerAppConsoleLogs_CL\n| where TimeGenerated > ago(5m)\n| where Log_s has \"auth.login.failure\"\n| extend j = parse_json(Log_s)\n| where isnotnull(j)\n| extend event = tostring(j.event), username = tostring(j.detail.username), clientIp = tostring(j.detail.client), userAgent = tostring(j.detail.userAgent)\n| where event == \"auth.login.failure\"\n| summarize FailureCount = count(), UserAgents = make_set(userAgent, 5), FirstSeen = min(TimeGenerated), LastSeen = max(TimeGenerated) by username, clientIp\n| where FailureCount >= 3\n| extend timestamp = LastSeen"
          queryFrequency  = "PT5M"
          queryPeriod     = "PT5M"
          triggerOperator = "GreaterThan"
          triggerThreshold = 0

          suppressionEnabled  = false
          suppressionDuration = "PT5M"

          incidentConfiguration = {
            createIncident = true
            groupingConfiguration = {
              enabled              = false
              reopenClosedIncident = false
              lookbackDuration     = "PT1H"
              matchingMethod       = "AllEntities"
              groupByEntities      = []
              groupByAlertDetails  = []
              groupByCustomDetails = []
            }
          }

          eventGroupingSettings = {
            aggregationKind = "SingleAlert"
          }

          tactics = ["CredentialAccess"]
        }
      }
    ]
    outputs = {}
  })

  depends_on = [
    azurerm_sentinel_log_analytics_workspace_onboarding.sentinel
  ]
}
