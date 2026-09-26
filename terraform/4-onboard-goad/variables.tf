# ---------------------------------------------------------------------------
# Phase 4 — onboard the GOAD Active Directory lab into the aisoc-lab Sentinel.
#
# GOAD is deployed separately with `goad.sh -p azure` (its own Terraform/state).
# This phase DISCOVERS GOAD's Windows VMs by name in their resource group and
# attaches them to the Sentinel workspace created in Phase 1 (read via
# terraform_remote_state): Azure Monitor Agent + an association to Phase 1's
# existing DCR (which already forwards SecurityEvent + Sysmon), plus a Sysmon +
# AD-audit-policy install via run_command, plus a starter set of AD analytic
# rules. No new workspace/DCR is created.
#
# PREREQUISITES:
#   - Phase 1 applied (Sentinel workspace + DCR) with AMA enabled (the default),
#     so its `dcr_id` output is non-null.
#   - GOAD deployed on Azure IN THE SAME REGION as Phase 1 (a DCR only associates
#     with VMs in its own region).
# ---------------------------------------------------------------------------

variable "goad_resource_group" {
  description = <<-EOT
    Resource group GOAD created on Azure. GOAD names it after its lab_identifier
    (RG = "{{lab_identifier}}" in GOAD's azure provider). For the full lab this is
    typically "GOAD". Check with: az group list -o table.
  EOT
  type        = string
  default     = "GOAD"
}

variable "goad_vm_names" {
  description = "Azure resource names of the GOAD Windows VMs to onboard (GOAD's default full-lab roster)."
  type        = list(string)
  default     = ["dc01", "dc02", "dc03", "srv02", "srv03"]
}

variable "enable_sysmon" {
  description = "Install Sysmon + enable AD audit subcategories on each GOAD host (via run_command)."
  type        = bool
  default     = true
}

variable "enable_ad_rules" {
  description = "Deploy the starter set of AD-attack Sentinel analytic rules (Kerberoast, DCSync, password spray, AS-REP roast)."
  type        = bool
  default     = true
}

variable "sysmon_config_url" {
  description = "Sysmon config XML URL. Default: SwiftOnSecurity (matches Phase 1's lab VM). Swap for Olaf Hartong's sysmon-modular if preferred."
  type        = string
  default     = "https://raw.githubusercontent.com/SwiftOnSecurity/sysmon-config/master/sysmonconfig-export.xml"
}
