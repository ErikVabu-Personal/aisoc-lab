# ---------------------------------------------------------------------------
# RedAmon — autonomous AI red-team attacker, deployed into the GOAD Azure VNet.
#
# GOAD is deployed separately (goad.sh -p azure); this component discovers its
# VNet/subnet by name and drops a RedAmon VM into GOAD's subnet, so RedAmon can
# reach the AD boxes intra-VNet. It reaches the Maison Miró store via its public
# Container App URL. Opt-in — deploy with `aisoc_demo.sh deploy --with-redamon`.
# ---------------------------------------------------------------------------

variable "admin_cidrs" {
  description = <<-EOT
    Who may SSH (22) / reach the RedAmon UI (3000) on the RedAmon box. STRONGLY
    lock this to your own IP, e.g. ["203.0.113.10/32"]. NOTE: GOAD's subnet NSG
    only permits SSH inbound, so the RedAmon UI (3000) is reached via an SSH
    tunnel (see outputs) unless you also open 3000 on GOAD's subnet NSG.
  EOT
  type        = set(string)
  default     = ["0.0.0.0/0"]
}

variable "goad_resource_group" {
  description = <<-EOT
    GOAD's Azure resource group. Its lab_identifier is "GOAD-<workspace-hash>-goad-azure"
    (e.g. "GOAD-aa6e32-goad-azure"), NOT just "GOAD", and the hash changes per install.
    Pass the actual RG: `az group list -o table | grep goad-azure`.
  EOT
  type        = string
  default     = "GOAD"
}

# The VNet/subnet/NSG use the lab NAME ("GOAD"), not the hashed lab_identifier —
# so these defaults are correct regardless of the workspace hash.
variable "goad_vnet_name" {
  description = "GOAD's virtual network name (GOAD sets '<lab>-virtual-network')."
  type        = string
  default     = "GOAD-virtual-network"
}

variable "goad_subnet_name" {
  description = "GOAD's subnet name (GOAD sets '<lab>-vm-subnet')."
  type        = string
  default     = "GOAD-vm-subnet"
}

variable "redamon_vm_name" {
  description = "Name for the RedAmon VM."
  type        = string
  default     = "redamon"
}

variable "redamon_size" {
  description = "VM size. --gvm (OpenVAS) wants 4 vCPU / 16 GB — Standard_D4s_v3."
  type        = string
  default     = "Standard_D4s_v3"
}

variable "redamon_disk_gb" {
  description = "OS disk size (GB). GVM + build cache + feeds need headroom (200)."
  type        = number
  default     = 200
}

variable "ssh_username" {
  description = "Admin username on the RedAmon VM."
  type        = string
  default     = "azureuser"
}

variable "redamon_enable_gvm" {
  description = "Run './redamon.sh install --gvm' (adds the OpenVAS/GVM scanner)."
  type        = bool
  default     = true
}

variable "redamon_repo_url" {
  description = "Git URL RedAmon is cloned from on the box."
  type        = string
  default     = "https://github.com/samugit83/redamon.git"
}

variable "redamon_branch" {
  description = "RedAmon git branch to check out."
  type        = string
  default     = "master"
}

# --- Optional: RedAmon -> self-hosted LLM over Tailscale (same as the AWS box) ---
variable "home_llm_tailscale_ip" {
  description = "Tailnet IP of a self-hosted LLM. Set it and cloud-init installs Tailscale + a keepalive to it. Empty = skip."
  type        = string
  default     = ""
}

variable "redamon_tailscale_authkey" {
  description = "Optional Tailscale pre-auth key to join unattended (sensitive; lands in custom_data). Empty = join by hand."
  type        = string
  default     = ""
  sensitive   = true
}

variable "redamon_tailscale_hostname" {
  description = "Tailnet hostname when an auth key is supplied."
  type        = string
  default     = "redamon-goad"
}
