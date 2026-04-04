variable "location" {
  description = "Default Azure region (used if auto-selection is disabled)"
  type        = string
  default     = "westeurope"
}

variable "auto_select_location_and_sku" {
  description = "If true, uses Azure CLI to pick the first available (location, VM SKU) from the candidate lists"
  type        = bool
  default     = true
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

variable "function_plan_sku" {
  description = "App Service Plan SKU for the SOC gateway Function. Use B1 if Consumption (Y1) is blocked by Dynamic VMs quota."
  type        = string
  default     = "B1"
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
  description = "Attempt to onboard the VM to Microsoft Defender for Endpoint using a provided onboarding script"
  type        = bool
  default     = false
}

variable "mde_onboarding_script" {
  description = <<EOT
Onboarding script content for Microsoft Defender for Endpoint (as provided by the MDE portal).

The MDE onboarding script is typically a CMD/BAT script with an interactive Y/N prompt.
Terraform will write it to disk and execute it non-interactively (auto-confirm).
EOT
  type      = string
  default   = null
  sensitive = true
}

variable "enable_sentinel_mde_connector" {
  description = "Enable the Microsoft Defender for Endpoint data connector in Sentinel (requires MDE already set up in tenant)"
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
  default     = "Standard_B2s"
}

variable "admin_username" {
  description = "Local admin username for the VM"
  type        = string
  default     = "azureadmin"
}

variable "admin_password" {
  description = "Local admin password for the VM"
  type        = string
  sensitive   = true
}

variable "allowed_rdp_cidr" {
  description = "CIDR allowed to RDP (TCP/3389). Ignored when auto_detect_rdp_cidr=true."
  type        = string
  default     = "203.0.113.10/32"
}

variable "auto_detect_rdp_cidr" {
  description = "If true, Terraform detects your current public IP and allow-lists it (/32) for RDP."
  type        = bool
  default     = true
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
