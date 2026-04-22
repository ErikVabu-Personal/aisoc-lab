variable "resource_group" {
  type        = string
  description = "Resource group name (typically Phase 1 RG)"
  default     = "rg-sentinel-test"
}

variable "location" {
  type        = string
  description = "Azure region"
  default     = "westus"
}

variable "container_app_environment_id" {
  type        = string
  description = "Optional: reuse an existing Container Apps Environment ID. If empty, a new one is created."
  default     = ""
}

variable "pixelagents_container_app_name" {
  type        = string
  description = "Name of the PixelAgents Web container app"
  default     = "ca-pixelagents-web"
}

variable "image" {
  type        = string
  description = "Container image reference for pixelagents_web"
  default     = "ghcr.io/erikvabu-personal/aisoc-lab-pixelagents-web:latest"
}

variable "create_log_analytics" {
  type        = bool
  description = "Create a Log Analytics workspace for ACA (if env is created)"
  default     = true
}
