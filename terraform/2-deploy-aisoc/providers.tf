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
  }
}

provider "azurerm" {
  features {}
}

provider "azapi" {
  # AzAPI's embedded schemas can lag behind the ARM apiVersions advertised by Azure.
  # We disable validation so we can use newer preview apiVersions for Foundry accounts/projects.
  schema_validation_enabled = false
}
