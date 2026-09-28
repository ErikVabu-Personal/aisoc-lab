resource "random_string" "suffix" {
  length  = 6
  upper   = false
  special = false
}

locals {
  tags = {
    project = "sentinel-test"
    managed = "terraform"
  }

  # Ensure uniqueness for names that often collide
  workspace_name_unique = "${var.workspace_name}-${random_string.suffix.result}"
}

resource "azurerm_resource_group" "rg" {
  name     = var.resource_group_name
  location = var.azure_location
  tags     = local.tags
}

resource "azurerm_log_analytics_workspace" "law" {
  name                = local.workspace_name_unique
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name

  sku               = "PerGB2018"
  retention_in_days = 30

  tags = local.tags
}

# Microsoft Sentinel onboarding for the workspace
resource "azurerm_sentinel_log_analytics_workspace_onboarding" "sentinel" {
  count = var.sentinel_enabled ? 1 : 0

  workspace_id                 = azurerm_log_analytics_workspace.law.id
  customer_managed_key_enabled = false
}

# --- Windows event pipeline for the GOAD lab: the Data Collection Rule ---
#
# This DCR is the ingestion contract for every Windows host we onboard.
# Phase 1 only CREATES it (unassociated) and exports its id; the GOAD
# domain controllers + servers are attached to it in `4-onboard-goad`,
# which reads this id via terraform_remote_state once each host has the
# Azure Monitor Agent + Sysmon installed. There is no VM in this phase —
# the range's Windows telemetry comes entirely from GOAD.
resource "azurerm_monitor_data_collection_rule" "dcr" {
  count               = var.enable_windows_event_logs ? 1 : 0
  name                = "dcr-goad-windows"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name

  destinations {
    log_analytics {
      name                  = "law"
      workspace_resource_id = azurerm_log_analytics_workspace.law.id
    }
  }

  data_sources {
    # Application / System / Sysmon → Event table (raw XML in
    # EventData). These channels don't have a "structured" Sentinel
    # table; analysts who need fields out of them parse the XML at
    # query time.
    #
    # Sysmon writes to its OWN channel
    # (`Microsoft-Windows-Sysmon/Operational`). The GOAD hosts install
    # Sysmon (SwiftOnSecurity config) during `4-onboard-goad`, so the
    # channel is always collected here. Sysmon events are Level=4
    # (Information); each host's sysmonconfig.xml is the authoritative
    # gate, so the AMA filter is broad and we don't double-filter.
    windows_event_log {
      name    = "windows-events"
      streams = ["Microsoft-Event"]

      x_path_queries = [
        "Application!*[System[(Level=1 or Level=2 or Level=3)]]",
        "System!*[System[(Level=1 or Level=2 or Level=3)]]",
        "Microsoft-Windows-Sysmon/Operational!*[System[(Level=1 or Level=2 or Level=3 or Level=4)]]",
      ]
    }

    # Security channel → SecurityEvent table (PROPERLY parsed —
    # Account / AccountName / LogonType / IpAddress / WorkstationName
    # become real columns instead of XML inside EventData).
    #
    # The Microsoft-SecurityEvent stream is what Sentinel expects
    # for native Security-event ingestion. Routing Security via
    # Microsoft-Event would land it in `Event` with the whole
    # body crammed into EventData — analysts would have to
    # parse_xml() per-query to get usernames out, and the field
    # offsets shift between EIDs. Don't do that. Use this stream.
    #
    # NO level filter. This is deliberate — Windows audit events
    # (4624 / 4625 / 4634 / 4672 / 4688 …) are emitted with
    # Level=0 (LogAlways), not Level=4 (Information) like Event
    # Viewer's "Information" badge implies. A filter of
    # (Level=1..4) silently drops every audit event. On the GOAD
    # domain controllers the volume is trivial; the broad
    # `Security!*` is fine.
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

  # The Microsoft-SecurityEvent stream lands audit events in the SecurityEvent
  # table, which only exists once the SecurityInsights (Microsoft Sentinel)
  # solution is active on the workspace. Without this ordering Terraform can
  # create the DCR before onboarding finishes, and Azure rejects the payload
  # with "InvalidPayload: Data collection rule is invalid".
  depends_on = [azurerm_sentinel_log_analytics_workspace_onboarding.sentinel]

  tags = local.tags
}
