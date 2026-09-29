variable "azure_location" {
  description = "Azure region for the Sentinel workspace (Phase 1). Defaults to West US — the combination of West US (Phase 1) + West Central US (Phase 2) is the empirically-validated happy path for new subs whose other regions have zero App Service quota."
  type        = string
  default     = "westus"
}

variable "resource_group_name" {
  description = "Resource group name"
  type        = string
  default     = "aisoc-demo"
}

variable "app_insights_location" {
  description = <<-EOT
    Region for the shared Application Insights component. Leave null to use the
    RG's region, except App Insights isn't offered everywhere (e.g. westcentralus):
    there it falls back to app_insights_fallback_location. Set this to pin it
    explicitly. It's workspace-based, so telemetry lands in the Log Analytics
    workspace regardless of the component's region.
  EOT
  type        = string
  default     = null
}

variable "app_insights_fallback_location" {
  description = "Region used for Application Insights when azure_location can't host it (e.g. westcentralus). Must be an App-Insights-supported region; defaults to eastus2 (already used for Foundry)."
  type        = string
  default     = "eastus2"
}

variable "workspace_name" {
  description = "Log Analytics Workspace name (must be globally unique per region/resource group constraints)"
  type        = string
  default     = "law-sentinel-test"
}

variable "sentinel_enabled" {
  description = "Enable Microsoft Sentinel on the Log Analytics workspace"
  type        = bool
  default     = true
}

variable "enable_windows_event_logs" {
  description = "Create the Windows Event Log Data Collection Rule (Application/System/Sysmon + Security) that the GOAD hosts attach to in 4-onboard-goad. Its id is exported for that phase; leave true unless you are onboarding no Windows hosts."
  type        = bool
  default     = true
}

variable "openrouter_api_key" {
  description = "OpenRouter API key (optional). Prefer leaving this null and setting the Key Vault secret manually after apply."
  type        = string
  default     = null
  sensitive   = true
}

# --- Demo target app: Maison Miró (intentionally-vulnerable store, Flask on ACA) ---

variable "maison_image" {
  description = "Container image for Maison Miró. Built via .github/workflows/deploy-maison-miro.yml (GHCR); pin a :<SHA> tag for deterministic demos."
  type        = string
  default     = "ghcr.io/erikvabu-personal/aisoc-maison-miro:latest"
}

variable "soc_key" {
  description = "Maison Miró SOC API key (X-SOC-Key) for the /soc/* control plane."
  type        = string
  default     = "soc-demo-key"
  sensitive   = true
}

variable "soc_armed" {
  description = "Maison Miró automated SOC response armed on boot ('1' on / '0' off)."
  type        = string
  default     = "1"
}

variable "sign_secret" {
  description = "HMAC key backing Maison Miró's forged-session detection (auth.session_forged)."
  type        = string
  default     = "maison-miro-demo-signing-secret"
  sensitive   = true
}
