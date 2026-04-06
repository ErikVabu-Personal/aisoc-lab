resource "random_string" "suffix" {
  length  = 6
  upper   = false
  special = false
}

# Dedicated suffix for Cognitive Services customSubDomainName.
# This avoids 409 CustomDomainInUse when recreating an account name within the purge window.
resource "random_string" "cs_subdomain" {
  length  = 8
  upper   = false
  special = false
}

locals {
  tags = {
    project = "aisoc-lab"
    managed = "terraform"
  }
}
