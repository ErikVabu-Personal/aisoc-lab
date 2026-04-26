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
  vnet_name             = "vnet-${var.vm_name}"
  subnet_name           = "subnet-${var.vm_name}"
  nsg_name              = "nsg-${var.vm_name}"
  pip_name              = "pip-${var.vm_name}"
  nic_name              = "nic-${var.vm_name}"
}

data "external" "pick" {
  count   = var.auto_select_location_and_sku ? 1 : 0
  program = ["python3", "${path.module}/scripts/select_vm_sku.py"]

  # external data source only supports string values; encode lists as JSON
  query = {
    location            = var.azure_location
    vm_size             = var.vm_size
    location_candidates = jsonencode(var.location_candidates)
    vm_size_candidates  = jsonencode(var.vm_size_candidates)
  }
}

locals {
  selected_location = var.auto_select_location_and_sku ? data.external.pick[0].result.location : var.azure_location
  selected_vm_size  = var.auto_select_location_and_sku ? data.external.pick[0].result.vm_size : var.vm_size

  # Lab VM admin password: if the user passed one via var, use that;
  # otherwise fall back to the random_password we generate below. The
  # random_password is held in Terraform state, so it stays stable
  # across re-applies (we don't churn the VM with a new password
  # every run).
  effective_admin_password = coalesce(var.admin_password, random_password.vm_admin.result)
}

# Auto-generated when admin_password isn't set explicitly. 28 chars
# from the alphanumeric set + at least one of each special class
# satisfies Azure's complexity rules (>=12 chars, three of four
# upper/lower/digit/special) with comfortable headroom.
resource "random_password" "vm_admin" {
  length           = 28
  upper            = true
  lower            = true
  numeric          = true
  special          = true
  override_special = "!@#%^*-_+=:?"
  min_upper        = 2
  min_lower        = 2
  min_numeric      = 2
  min_special      = 2
}

resource "azurerm_resource_group" "rg" {
  name     = var.resource_group_name
  location = local.selected_location
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

resource "azurerm_virtual_network" "vnet" {
  name                = local.vnet_name
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name

  address_space = ["10.42.0.0/16"]

  tags = local.tags
}

resource "azurerm_subnet" "subnet" {
  name                 = local.subnet_name
  resource_group_name  = azurerm_resource_group.rg.name
  virtual_network_name = azurerm_virtual_network.vnet.name
  address_prefixes     = ["10.42.1.0/24"]
}

resource "azurerm_network_security_group" "nsg" {
  name                = local.nsg_name
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name

  security_rule {
    # Lab VM is intentionally open on RDP from any source — this is a
    # throwaway test environment, the lab admin password is the only
    # gate. Don't model this as a "real" hardening pattern.
    name                       = "Allow-RDP"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "3389"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  security_rule {
    name                       = "Deny-All-Inbound"
    priority                   = 4096
    direction                  = "Inbound"
    access                     = "Deny"
    protocol                   = "*"
    source_port_range          = "*"
    destination_port_range     = "*"
    source_address_prefix      = "*"
    destination_address_prefix = "*"
  }

  tags = local.tags
}

resource "azurerm_subnet_network_security_group_association" "assoc" {
  subnet_id                 = azurerm_subnet.subnet.id
  network_security_group_id = azurerm_network_security_group.nsg.id
}

resource "azurerm_public_ip" "pip" {
  name                = local.pip_name
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name

  allocation_method = "Static"
  sku               = "Standard"

  tags = local.tags
}

resource "azurerm_network_interface" "nic" {
  name                = local.nic_name
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name

  ip_configuration {
    name                          = "ipconfig1"
    subnet_id                     = azurerm_subnet.subnet.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.pip.id
  }

  tags = local.tags
}

resource "azurerm_windows_virtual_machine" "vm" {
  name                = var.vm_name
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name
  size                = local.selected_vm_size

  identity {
    type = "SystemAssigned"
  }

  admin_username = var.admin_username
  admin_password = local.effective_admin_password

  network_interface_ids = [azurerm_network_interface.nic.id]

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "StandardSSD_LRS"
  }

  # Windows 11 Enterprise (client) images in Azure are typically multi-session.
  # If this offer is not available in your subscription/region, switch to Windows 10/Server.
  source_image_reference {
    publisher = "MicrosoftWindowsDesktop"
    offer     = "windows-11"
    sku       = "win11-25h2-pro"
    version   = "latest"
  }

  provision_vm_agent = true
  tags               = local.tags
}

# --- Log flow into Sentinel: Azure Monitor Agent + DCR ---

# Data collection endpoint (optional but recommended pattern)
resource "azurerm_monitor_data_collection_rule" "dcr" {
  count               = (var.enable_ama && var.enable_windows_event_logs) ? 1 : 0
  name                = "dcr-${var.vm_name}"
  location            = azurerm_resource_group.rg.location
  resource_group_name = azurerm_resource_group.rg.name

  destinations {
    log_analytics {
      name                 = "law"
      workspace_resource_id = azurerm_log_analytics_workspace.law.id
    }
  }

  data_sources {
    windows_event_log {
      name    = "windows-events"
      streams = ["Microsoft-Event"]

      x_path_queries = [
        "Application!*[System[(Level=1 or Level=2 or Level=3)]]",
        "System!*[System[(Level=1 or Level=2 or Level=3)]]",
        # Security events are typically Level=4 (Information). Include Level 4 so audit events arrive.
        "Security!*[System[(Level=1 or Level=2 or Level=3 or Level=4)]]",
      ]
    }
  }

  data_flow {
    streams      = ["Microsoft-Event"]
    destinations = ["law"]
  }

  tags = local.tags
}

# Install Azure Monitor Agent (AMA)
resource "azurerm_virtual_machine_extension" "ama" {
  count = var.enable_ama ? 1 : 0

  name                       = "AzureMonitorWindowsAgent"
  virtual_machine_id         = azurerm_windows_virtual_machine.vm.id
  publisher                  = "Microsoft.Azure.Monitor"
  type                       = "AzureMonitorWindowsAgent"
  type_handler_version       = "1.0"
  auto_upgrade_minor_version = true

  settings = jsonencode({})
}

# Associate DCR to the VM
resource "azurerm_monitor_data_collection_rule_association" "dcr_assoc" {
  count = (var.enable_ama && var.enable_windows_event_logs) ? 1 : 0

  name                    = "dcrassoc-${var.vm_name}"
  target_resource_id      = azurerm_windows_virtual_machine.vm.id
  data_collection_rule_id = azurerm_monitor_data_collection_rule.dcr[0].id

  depends_on = [azurerm_virtual_machine_extension.ama]
}

# --- Defender for Endpoint (MDE) onboarding (optional) ---
# Implemented in mde_kv.tf (Key Vault secret pull + execution)

# Enable the Sentinel connector for Defender for Endpoint (brings MDE incidents/alerts into Sentinel)
resource "azurerm_sentinel_data_connector_microsoft_defender_advanced_threat_protection" "mde" {
  count = (var.sentinel_enabled && var.enable_sentinel_mde_connector) ? 1 : 0

  name                       = "MicrosoftDefenderATP"
  log_analytics_workspace_id = azurerm_log_analytics_workspace.law.id
}

# Optional daily auto-shutdown to reduce cost
resource "azurerm_dev_test_global_vm_shutdown_schedule" "shutdown" {
  count = var.auto_shutdown_time == null ? 0 : 1

  virtual_machine_id = azurerm_windows_virtual_machine.vm.id
  location           = azurerm_resource_group.rg.location

  enabled = true

  daily_recurrence_time = var.auto_shutdown_time
  timezone              = var.auto_shutdown_timezone

  notification_settings {
    enabled = false
  }
}
