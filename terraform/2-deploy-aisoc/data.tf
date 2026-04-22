data "terraform_remote_state" "sentinel" {
  backend = "local"
  config = {
    path = "../1-deploy-sentinel/terraform.tfstate"
  }
}

locals {
  # Shared KV created in Phase 1.
  shared_kv_id  = data.terraform_remote_state.sentinel.outputs.aisoc_key_vault_id
  shared_kv_uri = data.terraform_remote_state.sentinel.outputs.aisoc_key_vault_uri
  shared_kv_name = data.terraform_remote_state.sentinel.outputs.aisoc_key_vault_name
}
