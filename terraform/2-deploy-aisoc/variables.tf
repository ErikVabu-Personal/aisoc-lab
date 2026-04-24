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

# -----------------------------
# Per-incident cost accounting
# -----------------------------

variable "foundry_model_price_eur_per_1m_in" {
  description = <<-EOT
    EUR cost per 1 million INPUT tokens for the currently-deployed
    Foundry model. Used by the orchestrator + PixelAgents Web to
    compute per-incident cost. Re-apply when pricing or model changes.
    Default tracks gpt-4.1-mini list pricing (~USD 0.40 → ~EUR 0.37).
  EOT
  type        = number
  default     = 0.37
}

variable "foundry_model_price_eur_per_1m_out" {
  description = <<-EOT
    EUR cost per 1 million OUTPUT tokens. Default tracks gpt-4.1-mini
    list pricing (~USD 1.60 → ~EUR 1.48).
  EOT
  type        = number
  default     = 1.48
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

variable "foundry_model_version" {
  description = "Model version string for the Foundry deployment (e.g. 2026-03-17)."
  type        = string
  default     = null
}

variable "foundry_model_sku_name" {
  description = "SKU name for the deployment (e.g. Standard, GlobalStandard)."
  type        = string
  default     = "Standard"
}

variable "foundry_model_sku_capacity" {
  description = "SKU capacity for the deployment."
  type        = number
  default     = 1
}


# -----------------------------
# Runner (Azure Container Apps)
# -----------------------------

variable "runner_image" {
  description = "Runner container image (GHCR)"
  type        = string
}

variable "runner_cpu" {
  description = "Runner CPU cores"
  type        = number
  default     = 0.5
}

variable "runner_memory" {
  description = "Runner memory"
  type        = string
  default     = "1Gi"
}

variable "runner_enable_writes" {
  description = "Allow runner to perform write operations via SOCGateway"
  type        = bool
  default     = true
}
