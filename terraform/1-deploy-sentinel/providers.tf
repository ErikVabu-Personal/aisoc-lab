terraform {
  backend "local" {}

  required_version = ">= 1.6.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
    http = {
      source  = "hashicorp/http"
      version = "~> 3.4"
    }
  }
}

# NOTE: azurerm_virtual_machine_run_command is provided by azurerm provider.
# Keep azurerm up to date if you hit schema/API issues.

provider "azurerm" {
  features {
    key_vault {
      # Some tenants enforce policies that forbid purging secrets/vaults.
      # Disable purge-on-destroy so `terraform destroy` can succeed without requiring purge permissions.
      purge_soft_deleted_secrets_on_destroy      = false
      purge_soft_deleted_keys_on_destroy         = false
      purge_soft_deleted_certificates_on_destroy = false

      recover_soft_deleted_key_vaults = true
    }
  }
}
