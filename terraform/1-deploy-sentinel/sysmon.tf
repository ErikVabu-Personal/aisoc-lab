#############################################
# Sysmon — Microsoft Sysinternals event tracer
#
# Installs Sysmon on the lab VM with the SwiftOnSecurity community
# config (the de-facto verbose-but-sane baseline). Sysmon writes to
# the `Microsoft-Windows-Sysmon/Operational` event channel; the
# DCR in main.tf is extended to forward that channel into the
# Sentinel workspace alongside Application/System/Security.
#
# Why a CustomScriptExtension and not a feature of the AMA?
# The AMA collects events that already exist on the host. Sysmon
# itself has to be installed on the host before it can produce any
# events. A CSE is the simplest way to push a one-shot install +
# config-load step from a Terraform apply.
#
# What lands on the VM
#   C:\Windows\System32\Sysmon64.exe
#   C:\ProgramData\AISOC\Sysmon\sysmonconfig.xml   (staged config)
#   C:\ProgramData\AISOC\Sysmon\install.log         (script log)
#   Service "Sysmon64" running
#
# Re-runs of the same Terraform apply are idempotent: the install
# script detects an existing Sysmon service and reloads the config
# in place rather than reinstalling.
#############################################

variable "enable_sysmon" {
  description = <<-EOT
    Install Sysmon on the lab VM with the SwiftOnSecurity verbose
    config + extend the DCR to forward Sysmon events into Sentinel.
    Adds a CustomScriptExtension that downloads + installs Sysmon
    on first apply, and reloads the config on re-applies. Default:
    true (Sysmon is the standard EDR-lite signal source for the
    AISOC demo).
  EOT
  type    = bool
  default = true
}

variable "sysmon_install_script_url" {
  description = <<-EOT
    Raw URL of the Sysmon install PowerShell script. Defaults to
    this repo's main branch on GitHub. Override if you've forked
    the repo or want to pin to a specific commit SHA.
  EOT
  type    = string
  default = "https://raw.githubusercontent.com/ErikVabu-Personal/aisoc-lab/main/terraform/1-deploy-sentinel/scripts/install_sysmon.ps1"
}

variable "sysmon_config_url" {
  description = <<-EOT
    Raw URL of the Sysmon config XML. Defaults to the
    SwiftOnSecurity community config (the de-facto verbose
    baseline). Override to pin a specific commit, swap to
    Olaf Hartong's sysmon-modular, or point at your own.
  EOT
  type    = string
  default = "https://raw.githubusercontent.com/SwiftOnSecurity/sysmon-config/master/sysmonconfig-export.xml"
}


# CustomScriptExtension — runs the install script on the VM. The
# extension downloads BOTH the install script AND the config XML
# from the URLs above (CSE handles the download to its working
# directory, the script picks up the staged config from there).
#
# Re-run trigger:
#   CSE extensions are sticky — once the first apply succeeds (or
#   fails), Azure won't re-run the same `settings` block on a later
#   `terraform apply`. That's a problem for us: every time we patch
#   install_sysmon.ps1 we want the VM to pick up the new version.
#   Solution: include the local script's filemd5 in `settings` so
#   any edit changes the JSON, which forces Azure to delete the
#   extension and re-deploy it (re-running the script). Use a
#   harmless field name (`scriptHash`) that the CSE itself ignores
#   but Terraform/Azure see as a settings change.
resource "azurerm_virtual_machine_extension" "sysmon" {
  count = var.enable_sysmon ? 1 : 0

  name                       = "InstallSysmon"
  virtual_machine_id         = azurerm_windows_virtual_machine.vm.id
  publisher                  = "Microsoft.Compute"
  type                       = "CustomScriptExtension"
  type_handler_version       = "1.10"
  auto_upgrade_minor_version = true

  settings = jsonencode({
    fileUris = [
      var.sysmon_install_script_url,
      var.sysmon_config_url,
    ]
    # ExecutionPolicy Bypass — we trust our own script, and CSE
    # already authenticates the download via Azure infrastructure.
    # -File is the safest way to invoke a downloaded .ps1 (no
    # quoting horrors).
    commandToExecute = "powershell.exe -ExecutionPolicy Bypass -NoProfile -File install_sysmon.ps1"
    # Harmless cache-buster: changes whenever the local install
    # script changes, which forces the extension to re-deploy and
    # re-run on the VM. The CSE handler ignores unknown keys.
    scriptHash = filemd5("${path.module}/scripts/install_sysmon.ps1")
  })

  tags = local.tags

  # AMA must be present first — the DCR association extension
  # depends on it and reapplying the DCR after Sysmon installs is
  # what gets the channel forwarded. Order: AMA → Sysmon → DCR
  # association (the association already depends_on AMA in main.tf).
  depends_on = [azurerm_virtual_machine_extension.ama]
}


output "sysmon_enabled" {
  description = "Whether Sysmon was installed on the lab VM."
  value       = var.enable_sysmon
}
