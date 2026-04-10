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

variable "create_log_analytics" {
  type        = bool
  description = "Create a Log Analytics workspace for ACA (if env is created)"
  default     = true
}

variable "app_name" {
  type        = string
  description = "Container App name for the ship control panel"
  default     = "ca-ship-control-panel"
}

variable "image" {
  type        = string
  description = "Container image reference"
  default     = "ghcr.io/erikvabu-personal/aisoc-ship-control-panel:latest"
}

variable "ingress_port" {
  type        = number
  description = "Container port"
  default     = 3000
}
