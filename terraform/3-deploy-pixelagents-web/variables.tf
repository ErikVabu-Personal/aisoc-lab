variable "resource_group" {
  type        = string
  description = "Optional override: Resource group name. If null, uses Phase 1 remote state output."
  default     = null
}

variable "location" {
  type        = string
  description = "Optional override: Azure region. If null, uses Phase 1 selected_location."
  default     = null
}

# NOTE: `pixelagents_token` is output as sensitive. This is fine for a demo stack, but be mindful
# it will still exist in local terraform state.

variable "container_app_environment_id" {
  type        = string
  description = "Optional override: reuse an existing Container Apps Environment ID. If null/empty, reuses Phase 1 env when available; otherwise creates a new one."
  default     = null
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

# Note: the Foundry project endpoint used by the ad-hoc chat endpoint is
# inherited from Phase 2's `foundry_project_endpoint` output; it is no longer
# a Phase 3 variable. If Phase 2's output scheme ever needs overriding,
# reintroduce a variable here and wrap the consumer in coalesce().
