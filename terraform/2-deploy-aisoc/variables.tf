variable "openrouter_api_key" {
  description = "OpenRouter API key (optional). Prefer leaving this null and setting the Key Vault secret manually after apply."
  type        = string
  default     = null
  sensitive   = true
}


variable "function_plan_sku" {
  description = "App Service Plan SKU shared by the SOC Gateway + Orchestrator Function Apps. Default is EP1 (Elastic Premium) because new subscriptions usually have 0 quota for Standard-tier VMs (the S/B/D SKUs use that pool); EP-series has its own pool that's more readily available. Override only when EP-series isn't available in your target region."
  type        = string
  default     = "EP1"
}

variable "location_override" {
  description = "Region for Phase 2 resources (App Service / Function Apps). Defaults to West Central US — many freshly-provisioned subscriptions have zero EP-series quota in West Europe / North Europe / West US, but reliably have it pre-allocated in West Central US. Set to null to inherit Phase 1's region instead."
  type        = string
  default     = "westcentralus"
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
  description = "Region for the Azure AI Foundry hub/project. Defaults to East US 2 — Model Router + GPT-4.1-mini are region-gated, and East US 2 + Sweden Central are the known-supported regions. Override only if you've confirmed the model + SKU you want is available somewhere else."
  type        = string
  default     = "eastus2"
}

variable "foundry_model_choice" {
  description = "Human-friendly model choice string (e.g. 'gpt-4.1-mini'). Source of truth for what we want, even if deployment is scripted."
  type        = string
  default     = "gpt-4.1-mini"
}

variable "foundry_model_deployment_name" {
  description = "Model deployment name in Foundry that agents should use (often distinct from model family)."
  type        = string
  default     = "gpt-4.1-mini"
}

variable "foundry_model_version" {
  description = "Model version string for the Foundry deployment."
  type        = string
  default     = "2025-04-14"
}

variable "foundry_model_sku_name" {
  description = "SKU name for the deployment. GlobalStandard is required when the chosen region/model combo doesn't offer plain 'Standard' (which is most of the time for gpt-4.1-mini)."
  type        = string
  default     = "GlobalStandard"
}

variable "foundry_model_sku_capacity" {
  description = "SKU capacity for the deployment. For Azure OpenAI's GlobalStandard SKU this is **thousands of tokens-per-minute** — i.e. 1500 = 1,500,000 TPM. Defaults to 1500: any lower and the orchestrator's three-agent pipeline trips Foundry's rate limit (429 'rate_limit_exceeded') on tool-heavy incidents, especially when the investigator and reporter follow triage in quick succession."
  type        = number
  default     = 1500
}


variable "foundry_additional_model_deployments" {
  description = <<-EOT
    Extra model deployments to create alongside the primary one. Each
    object describes a single Foundry model deployment that becomes
    selectable in the per-agent model dropdown on /config. Leave empty
    to keep only the primary deployment.

    Per-entry fields:
      - deployment_name: name of the deployment in Foundry (also the
        slug agents reference; must be unique in the account).
      - model_name: e.g. "gpt-4.1", "gpt-4o-mini", "gpt-5".
      - model_version: model version string (e.g. "2025-04-14").
      - sku_name: SKU; usually "GlobalStandard".
      - sku_capacity: thousands of TPM (e.g. 1500 = 1.5M TPM).
      - label: optional friendly name shown in the UI dropdown.
      - description: optional 1-line hint for the dropdown ("faster",
        "more capable", etc).

    Defaults to a small recommended set (gpt-4.1, gpt-4o-mini) so a
    fresh deploy already has options beyond gpt-4.1-mini. Override in
    tfvars when you want different models or want to lock the demo
    down to one option.
  EOT
  type = list(object({
    deployment_name = string
    model_name      = string
    model_version   = string
    sku_name        = optional(string, "GlobalStandard")
    sku_capacity    = optional(number, 1500)
    label           = optional(string, "")
    description     = optional(string, "")
  }))
  default = [
    {
      deployment_name = "gpt-4.1"
      model_name      = "gpt-4.1"
      model_version   = "2025-04-14"
      label           = "GPT-4.1"
      description     = "Larger, more capable than 4.1-mini; better for tricky investigations."
    },
    {
      deployment_name = "gpt-4o-mini"
      model_name      = "gpt-4o-mini"
      model_version   = "2024-07-18"
      label           = "GPT-4o-mini"
      description     = "Fast + cheap; good fit for triage."
    },
  ]
}


# -----------------------------
# Runner (Azure Container Apps)
# -----------------------------

variable "runner_image" {
  description = "Runner container image (GHCR). Defaults to the public :latest tag from this repo; the deploy-aisoc-runner workflow re-pushes :latest after every code change so the default tracks main."
  type        = string
  default     = "ghcr.io/erikvabu-personal/aisoc-runner:latest"
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
