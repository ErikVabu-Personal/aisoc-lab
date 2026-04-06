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
