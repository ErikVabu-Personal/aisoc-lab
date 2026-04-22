data "terraform_remote_state" "sentinel" {
  backend = "local"
  config = {
    path = "../1-deploy-sentinel/terraform.tfstate"
  }
}

data "terraform_remote_state" "aisoc" {
  backend = "local"
  config = {
    path = "../2-deploy-aisoc/terraform.tfstate"
  }
}
