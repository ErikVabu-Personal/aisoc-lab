# ===========================================================================
# RedAmon VM — deployed into GOAD's Azure VNet/subnet + resource group, so it can
# attack the AD boxes intra-VNet. cloud-init installs Docker + RedAmon (--gvm) in
# a tmux session (reused verbatim from the AWS box). Admin-locked; the UI (:3000)
# is reached via an SSH tunnel because GOAD's subnet NSG only permits SSH.
# ===========================================================================

resource "tls_private_key" "redamon" {
  algorithm = "RSA"
  rsa_bits  = 4096
}

resource "local_sensitive_file" "redamon_pem" {
  content         = tls_private_key.redamon.private_key_pem
  filename        = "${path.module}/ssh_keys/redamon.pem"
  file_permission = "0600"
}

resource "azurerm_public_ip" "redamon" {
  name                = "${var.redamon_vm_name}-pip"
  resource_group_name = data.azurerm_resource_group.goad.name
  location            = data.azurerm_resource_group.goad.location
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = { Component = "redamon", Role = "red-team" }
}

resource "azurerm_network_security_group" "redamon" {
  name                = "${var.redamon_vm_name}-nsg"
  resource_group_name = data.azurerm_resource_group.goad.name
  location            = data.azurerm_resource_group.goad.location

  security_rule {
    name                       = "AllowSSHAdmin"
    priority                   = 100
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "22"
    source_address_prefixes    = tolist(var.admin_cidrs)
    destination_address_prefix = "*"
  }

  # RedAmon UI. NOTE: GOAD's subnet NSG only allows SSH inbound, so this rule is
  # only effective if you also open 3000 on GOAD's subnet NSG — otherwise reach
  # the UI via the SSH tunnel in the outputs.
  security_rule {
    name                       = "AllowRedAmonUIAdmin"
    priority                   = 110
    direction                  = "Inbound"
    access                     = "Allow"
    protocol                   = "Tcp"
    source_port_range          = "*"
    destination_port_range     = "3000"
    source_address_prefixes    = tolist(var.admin_cidrs)
    destination_address_prefix = "*"
  }

  tags = { Component = "redamon" }
}

resource "azurerm_network_interface" "redamon" {
  name                = "${var.redamon_vm_name}-nic"
  resource_group_name = data.azurerm_resource_group.goad.name
  location            = data.azurerm_resource_group.goad.location

  ip_configuration {
    name                          = "ipconfig"
    subnet_id                     = data.azurerm_subnet.goad.id
    private_ip_address_allocation = "Dynamic"
    public_ip_address_id          = azurerm_public_ip.redamon.id
  }

  tags = { Component = "redamon" }
}

resource "azurerm_network_interface_security_group_association" "redamon" {
  network_interface_id      = azurerm_network_interface.redamon.id
  network_security_group_id = azurerm_network_security_group.redamon.id
}

resource "azurerm_linux_virtual_machine" "redamon" {
  name                = var.redamon_vm_name
  resource_group_name = data.azurerm_resource_group.goad.name
  location            = data.azurerm_resource_group.goad.location
  size                = var.redamon_size
  admin_username      = var.ssh_username

  network_interface_ids = [azurerm_network_interface.redamon.id]

  admin_ssh_key {
    username   = var.ssh_username
    public_key = tls_private_key.redamon.public_key_openssh
  }

  os_disk {
    caching              = "ReadWrite"
    storage_account_type = "StandardSSD_LRS"
    disk_size_gb         = var.redamon_disk_gb
  }

  source_image_reference {
    publisher = "Canonical"
    offer     = "0001-com-ubuntu-server-jammy"
    sku       = "22_04-lts-gen2"
    version   = "latest"
  }

  custom_data = base64encode(templatefile("${path.module}/templates/redamon-init.sh.tpl", {
    ssh_username       = var.ssh_username
    repo_url           = var.redamon_repo_url
    branch             = var.redamon_branch
    gvm_flag           = local.gvm_flag
    home_llm_ip        = var.home_llm_tailscale_ip
    tailscale_authkey  = var.redamon_tailscale_authkey
    tailscale_hostname = var.redamon_tailscale_hostname
  }))

  tags = { Component = "redamon", Role = "red-team" }

  # Stateful (RedAmon findings/graph/DBs). cloud-init runs at first boot only;
  # editing the template must not bounce a running box.
  lifecycle {
    ignore_changes = [custom_data]
  }
}
