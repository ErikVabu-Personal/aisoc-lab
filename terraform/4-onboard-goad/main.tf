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

# Guard: Phase 1 must have created the DCR (AMA enabled). Fail early + clearly.
resource "terraform_data" "precheck_dcr" {
  lifecycle {
    precondition {
      condition     = local.dcr_id != null
      error_message = "Phase 1 has no dcr_id (its AMA/windows-event-logs were disabled). Re-apply 1-deploy-sentinel with enable_ama + enable_windows_event_logs = true before onboarding GOAD."
    }
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
  data_collection_rule_id = local.dcr_id

  # AMA (and Sysmon when enabled) must land first so the channels exist by the
  # time AMA picks up the DCR's xpath subscriptions.
  depends_on = [
    azurerm_virtual_machine_extension.ama,
    azurerm_virtual_machine_run_command.sysmon,
    terraform_data.precheck_dcr,
  ]
}
