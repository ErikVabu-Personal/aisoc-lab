variable "openrouter_api_key" {
  description = "OpenRouter API key (optional). Prefer leaving this null and setting the Key Vault secret manually after apply."
  type        = string
  default     = null
  sensitive   = true
}

variable "function_plan_sku" {
  description = "App Service Plan SKU for the SOC gateway Function. Use S1 if B1 quota is 0 in your subscription/region."
  type        = string
  default     = "S1"
}
