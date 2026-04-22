terraform {
  backend "local" {}

  required_version = ">= 1.6.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    azapi = {
      source  = "Azure/azapi"
      version = "~> 2.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    time = {
      source  = "hashicorp/time"
      version = "~> 0.12"
    }
  }
}

provider "azurerm" {
  features {
    key_vault {
      # Many tenants enforce policies that block purge operations.
      # Disable purge-on-destroy so `terraform destroy` works reliably.
      purge_soft_deleted_secrets_on_destroy      = false
      purge_soft_deleted_keys_on_destroy         = false
      purge_soft_deleted_certificates_on_destroy = false

      # If a secret was soft-deleted, allow Terraform to recover it on the next apply.
      recover_soft_deleted_secrets = true
    }
  }
}

provider "azapi" {}
