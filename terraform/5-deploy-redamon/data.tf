# Discover GOAD's Azure network (deployed by goad.sh -p azure).
data "azurerm_resource_group" "goad" {
  name = var.goad_resource_group
}

data "azurerm_virtual_network" "goad" {
  name                = var.goad_vnet_name
  resource_group_name = var.goad_resource_group
}

data "azurerm_subnet" "goad" {
  name                 = var.goad_subnet_name
  virtual_network_name = var.goad_vnet_name
  resource_group_name  = var.goad_resource_group
}

locals {
  gvm_flag = var.redamon_enable_gvm ? "--gvm" : ""
}
