resource "random_string" "suffix" {
  length  = 6
  upper   = false
  special = false
}

locals {
  tags = {
    project = "aisoc-lab"
    managed = "terraform"
  }
}
