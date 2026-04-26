terraform {
  required_version = ">= 1.6"
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "azurerm" {
  features {
    resource_group {
      # Phase 3 doesn't own the RG (Phase 1 does), but keeping the
      # flag here too means a stand-alone `terraform destroy` in
      # Phase 3 won't be tripped up by Azure-auto-created child
      # resources like Application Insights smart-detection Action
      # Groups.
      prevent_deletion_if_contains_resources = false
    }
  }
}
