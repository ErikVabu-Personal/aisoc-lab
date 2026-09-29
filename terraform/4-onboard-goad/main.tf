# ===========================================================================
# Attach each GOAD Windows VM to the aisoc-lab Sentinel workspace.
#
# Per host (for_each over the discovered VMs):
#   1. Azure Monitor Agent (AMA) extension.
#   2. Sysmon + AD audit-policy install via run_command. NOT a
#      CustomScriptExtension: GOAD already puts a CSE on these VMs (WinRM
#      bootstrap) and only one CSE is allowed per VM. run_command coexists and
#      re-runs when the script content changes.
#   3. Association to Phase 1's existing DCR (reused as-is — it already forwards
#      SecurityEvent + Sysmon/Operational). No new DCR.
# ===========================================================================

# Guard: Phase 1 must have created the Sentinel workspace (its id is the DCR
# destination). Fail early + clearly.
resource "terraform_data" "precheck_law" {
  lifecycle {
    precondition {
      condition     = local.law_id != null
      error_message = "Phase 1 has no log_analytics_workspace_id output — apply 1-deploy-sentinel first."
    }
  }
}

# GOAD's own Data Collection Rule, in GOAD's region. A DCR must be co-located with
# the VMs it associates, so we create it here (in local.goad_location) rather than
# reusing Phase 1's DCR — which lets GOAD live in a different region than Phase 1
# (e.g. when Phase 1's region has no VM capacity). It still routes into the Phase-1
# Sentinel workspace (DCR → workspace is allowed cross-region). Same shape as
# Phase 1's dcr-goad-windows: Security → SecurityEvent, Sysmon/App/System → Event.
resource "azurerm_monitor_data_collection_rule" "goad_dcr" {
  name                = "dcr-goad-${local.goad_location}"
  location            = local.goad_location
  resource_group_name = local.law_rg

  destinations {
    log_analytics {
      name                  = "law"
      workspace_resource_id = local.law_id
    }
  }

  data_sources {
    windows_event_log {
      name    = "windows-events"
      streams = ["Microsoft-Event"]
      x_path_queries = [
        "Application!*[System[(Level=1 or Level=2 or Level=3)]]",
        "System!*[System[(Level=1 or Level=2 or Level=3)]]",
        "Microsoft-Windows-Sysmon/Operational!*[System[(Level=1 or Level=2 or Level=3 or Level=4)]]",
      ]
    }
    windows_event_log {
      name    = "security-events"
      streams = ["Microsoft-SecurityEvent"]
      x_path_queries = [
        "Security!*",
      ]
    }
  }

  data_flow {
    streams      = ["Microsoft-Event", "Microsoft-SecurityEvent"]
    destinations = ["law"]
  }
}

# 1. Azure Monitor Agent on each GOAD host.
resource "azurerm_virtual_machine_extension" "ama" {
  for_each = data.azurerm_virtual_machine.goad

  name                       = "AzureMonitorWindowsAgent"
  virtual_machine_id         = each.value.id
  publisher                  = "Microsoft.Azure.Monitor"
  type                       = "AzureMonitorWindowsAgent"
  type_handler_version       = "1.0"
  auto_upgrade_minor_version = true
  settings                   = jsonencode({})
}

# 2. Sysmon + AD audit subcategories (run_command, re-runs on script change).
resource "azurerm_virtual_machine_run_command" "sysmon" {
  for_each = var.enable_sysmon ? data.azurerm_virtual_machine.goad : {}

  name               = "OnboardGoadEndpoint"
  location           = each.value.location
  virtual_machine_id = each.value.id

  source {
    script = templatefile("${path.module}/scripts/onboard_goad_endpoint.ps1", {
      sysmon_config_url = var.sysmon_config_url
    })
  }

  # AMA first so the agent exists before the DCR association refreshes xpaths.
  depends_on = [azurerm_virtual_machine_extension.ama]
}

# 3. Associate each host to Phase 1's DCR.
resource "azurerm_monitor_data_collection_rule_association" "assoc" {
  for_each = data.azurerm_virtual_machine.goad

  name                    = "dcrassoc-goad-${each.key}"
  target_resource_id      = each.value.id
  data_collection_rule_id = azurerm_monitor_data_collection_rule.goad_dcr.id

  # AMA (and Sysmon when enabled) must land first so the channels exist by the
  # time AMA picks up the DCR's xpath subscriptions.
  depends_on = [
    azurerm_virtual_machine_extension.ama,
    azurerm_virtual_machine_run_command.sysmon,
    terraform_data.precheck_law,
  ]
}
