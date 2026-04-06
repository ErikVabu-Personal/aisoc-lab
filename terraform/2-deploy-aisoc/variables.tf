variable "openrouter_api_key" {
  description = "OpenRouter API key (optional). Prefer leaving this null and setting the Key Vault secret manually after apply."
  type        = string
  default     = null
  sensitive   = true
}

variable "function_plan_sku" {
  description = "App Service Plan SKU for the SOC gateway Function. Region quotas vary heavily; set this in tfvars when needed."
  type        = string
  default     = "S1"
}

variable "location_override" {
  description = "Optional region override for Phase 2 resources (e.g. 'westus'). If null, uses Phase 1 selected_location from remote state."
  type        = string
  default     = null
}

# -----------------------------
# Foundry (Hub/Project + agent runtime config)
# -----------------------------

variable "foundry_hub_name" {
  description = "Azure AI Foundry Hub name to create/use."
  type        = string
  default     = null
}

variable "foundry_project_name" {
  description = "Azure AI Foundry Project name to create/use."
  type        = string
  default     = null
}

variable "foundry_location" {
  description = "Optional location for Foundry resources. If null, uses the effective Phase 2 location."
  type        = string
  default     = null
}

variable "foundry_model_choice" {
  description = "Human-friendly model choice string (e.g. 'gpt-4.1-mini'). Source of truth for what we want, even if deployment is scripted."
  type        = string
  default     = null
}

variable "foundry_model_deployment_name" {
  description = "Model deployment name in Foundry that agents should use (often distinct from model family)."
  type        = string
  default     = null
}
