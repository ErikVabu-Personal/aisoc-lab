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
    Resource group GOAD created on Azure. GOAD's azure provider names it after
    its lab_identifier, which is "GOAD-<workspace-hash>-goad-azure" (e.g.
    "GOAD-aa6e32-goad-azure") — NOT just "GOAD", and the hash changes per
    `goad.sh` install. There is no stable default; pass the actual RG:
    `az group list -o table | grep goad-azure`.
  EOT
  type        = string
  default     = "GOAD"
}

variable "goad_location" {
  description = <<-EOT
    Azure region GOAD is deployed in. Leave null to reuse Phase 1's region
    (same-region onboarding). Set it (e.g. "westus2") when GOAD is in a different
    region than Phase 1 — Phase 4 then creates the DCR in that region (a DCR must
    be co-located with the VMs it associates) while still routing to the Phase-1
    Sentinel workspace (DCR → workspace is allowed cross-region). Must match the
    region you passed to goad.sh (goad.ini az_location).
  EOT
  type        = string
  default     = null
}

variable "goad_vm_names" {
  description = <<-EOT
    Azure *resource* names of the GOAD Windows VMs (GOAD's azure provider names
    them "goad-vm-<host>", so the compute resource is goad-vm-dc01 even though the
    in-OS hostname — what Sentinel records as Computer — is dc01). Discovery is by
    the Azure resource name; the KB/analytic rules key off the in-OS hostname.
  EOT
  type        = list(string)
  default     = ["goad-vm-dc01", "goad-vm-dc02", "goad-vm-dc03", "goad-vm-srv02", "goad-vm-srv03"]
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
