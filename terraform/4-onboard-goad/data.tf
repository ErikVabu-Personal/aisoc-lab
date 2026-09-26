# Phase 1 (Sentinel) outputs — the workspace + the reusable DCR.
data "terraform_remote_state" "sentinel" {
  backend = "local"
  config = {
    path = "../1-deploy-sentinel/terraform.tfstate"
  }
}

# Discover the GOAD Windows VMs (deployed by goad.sh -p azure) by name.
data "azurerm_virtual_machine" "goad" {
  for_each            = toset(var.goad_vm_names)
  name                = each.value
  resource_group_name = var.goad_resource_group
}

locals {
  dcr_id        = data.terraform_remote_state.sentinel.outputs.dcr_id
  law_name      = data.terraform_remote_state.sentinel.outputs.log_analytics_workspace_name
  law_rg        = data.terraform_remote_state.sentinel.outputs.resource_group
  law_workspace = data.terraform_remote_state.sentinel.outputs.log_analytics_workspace_workspace_id # GUID
}
