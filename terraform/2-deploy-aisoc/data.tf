data "terraform_remote_state" "sentinel" {
  backend = "local"
  config = {
    path = "../1-deploy-sentinel/terraform.tfstate"
  }
}
