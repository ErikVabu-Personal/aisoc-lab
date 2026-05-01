variable "azure_location" {
  description = "Default Azure region for Sentinel + lab VM. Defaults to West US — the combination of West US (Phase 1) + West Central US (Phase 2) is the empirically-validated happy path for new subs whose other regions have zero App Service quota."
  type        = string
  default     = "westus"
}

variable "auto_select_location_and_sku" {
  description = "If true, uses Azure CLI to pick the first available (location, VM SKU) from the candidate lists. Default is false so the deploy is deterministic — `azure_location` + `vm_size` are used as-is."
  type        = bool
  default     = false
}

variable "location_candidates" {
  description = "Ordered list of regions to try when auto-selecting"
  type        = list(string)
  default     = ["northeurope", "westeurope", "westus"]
}

variable "vm_size_candidates" {
  description = "Ordered list of VM sizes to try when auto-selecting (cost-effective first)"
  type        = list(string)
  default     = [
    "Standard_B2s",
    "Standard_B1ms",
    "Standard_D2as_v5",
    "Standard_D2s_v5",
    "Standard_D2s_v3",
    "Standard_D2as_v4",
  ]
}

variable "openrouter_api_key" {
  description = "OpenRouter API key (optional). Prefer leaving this null and setting the Key Vault secret manually after apply."
  type        = string
  default     = null
  sensitive   = true
}


variable "resource_group_name" {
  description = "Resource group name"
  type        = string
  default     = "rg-sentinel-test"
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

variable "enable_ama" {
  description = "Install Azure Monitor Agent on the VM"
  type        = bool
  default     = true
}

variable "enable_windows_event_logs" {
  description = "Collect Windows Event Logs (Application/System/Security) into Log Analytics via AMA + DCR"
  type        = bool
  default     = true
}

variable "enable_defender_for_endpoint" {
  description = "Onboard the VM to Microsoft Defender for Endpoint (MDE) by fetching an onboarding script from Key Vault and executing it."
  type        = bool
  default     = true
}

variable "mde_onboarding_secret_name" {
  description = "Key Vault secret name containing the MDE onboarding script content (CMD/BAT). Set to null to skip running the onboarding extension."
  type        = string
  default     = "MDE-ONBOARD"
}

variable "mde_onboarding_script_path" {
  description = "Local path to the MDE onboarding script file (CMD/BAT). If set, Terraform will upload it to Key Vault as a secret (LAB ONLY: stored in TF state)."
  type        = string
  default     = null
}

# NOTE: lifecycle.prevent_destroy must be a constant; we cannot toggle it with a variable.
# If you want a safety rail, uncomment the prevent_destroy block in mde_kv.tf.

variable "enable_sentinel_mde_connector" {
  description = "Enable the Microsoft Defender for Endpoint data connector in Sentinel. Requires MDE licensing + tenant consent in Sentinel; otherwise Azure returns InvalidLicense/Missing consent."
  type        = bool
  default     = false
}


variable "vm_name" {
  description = "Windows VM name"
  type        = string
  default     = "win11-test"
}

variable "vm_size" {
  description = "Azure VM size (pick something you have quota for; B/Dv3 are usually widely available)"
  type        = string
  default     = "Standard_D2s_v3"
}

variable "admin_username" {
  description = <<-EOT
    Local admin username for the lab VM. Defaults to `jack.sparrow`
    on purpose: the AISOC demo's narrative leans on the captain
    (Jack Sparrow per the company-context KB org chart) being the
    interactive user on the lab VM. Failed-login bursts on the
    Ship Control Panel originating from the VM's IP are the
    captain mistyping his password — and the agent should reach
    that conclusion by retrieving the org chart from the
    `company-context` KB. Override via TF_VAR_admin_username only
    if you want to tell a different story.

    Constraints (Azure VM admin_username): 1–20 chars; cannot end
    with a period; cannot use reserved names like "administrator"
    or "admin"; cannot contain spaces or @\\:.
  EOT
  type        = string
  default     = "jack.sparrow"
}

variable "admin_password" {
  description = "Local admin password for the VM. If null (default), Terraform generates a random one and surfaces it via the vm_password output."
  type        = string
  sensitive   = true
  default     = null
}

variable "auto_shutdown_time" {
  description = "Auto-shutdown time in HHMM (e.g., 1900). Set null to disable."
  type        = string
  default     = "1900"
}

variable "auto_shutdown_timezone" {
  description = "Timezone for auto-shutdown"
  type        = string
  default     = "Romance Standard Time"
}

# --- Demo target app: Ship Control Panel (Next.js on ACA) ---

variable "ship_control_panel_image" {
  description = "Container image for the Ship Control Panel (Next.js). Build via GH Actions and deploy by SHA for determinism."
  type        = string
  default     = "ghcr.io/erikvabu-personal/aisoc-ship-control-panel:latest"
}
