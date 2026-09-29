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
  law_id        = data.terraform_remote_state.sentinel.outputs.log_analytics_workspace_id # full ARM id
  law_name      = data.terraform_remote_state.sentinel.outputs.log_analytics_workspace_name
  law_rg        = data.terraform_remote_state.sentinel.outputs.resource_group
  law_workspace = data.terraform_remote_state.sentinel.outputs.log_analytics_workspace_workspace_id # GUID

  # GOAD's region defaults to the Sentinel region (same-region onboarding). When
  # GOAD lives in a different region (e.g. because Phase 1's region ran out of VM
  # capacity), set var.goad_location — Phase 4 then creates the DCR in THAT region
  # (a DCR must be in its VMs' region) still targeting the Phase-1 workspace, which
  # DCR→workspace supports cross-region.
  goad_location = coalesce(var.goad_location, data.terraform_remote_state.sentinel.outputs.selected_location)
}
