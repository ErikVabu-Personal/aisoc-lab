output "redamon_public_ip" {
  value = azurerm_public_ip.redamon.ip_address
}

output "redamon_private_ip" {
  description = "Intra-VNet IP RedAmon attacks from (the GOAD boxes see this)."
  value       = azurerm_network_interface.redamon.private_ip_address
}

output "ssh_redamon" {
  value = "ssh -i ${local_sensitive_file.redamon_pem.filename} ${var.ssh_username}@${azurerm_public_ip.redamon.ip_address}"
}

output "redamon_ui_tunnel" {
  description = "Reach the RedAmon UI at http://localhost:3000 after opening this tunnel (GOAD's subnet NSG only allows SSH)."
  value       = "ssh -i ${local_sensitive_file.redamon_pem.filename} -L 3000:localhost:3000 ${var.ssh_username}@${azurerm_public_ip.redamon.ip_address}"
}

output "next_steps" {
  value = <<-EOT

    RedAmon is installing on first boot (watch: ssh in, then
    'sudo tmux attach -t redamon'; log: /var/log/redamon-install.log).
    Open the UI via the tunnel:  ${"ssh -i ${local_sensitive_file.redamon_pem.filename} -L 3000:localhost:3000 ${var.ssh_username}@${azurerm_public_ip.redamon.ip_address}"}
      then browse http://localhost:3000, create the admin account, add an LLM key.
    Point RedAmon at: the GOAD AD range (intra-VNet) and the Maison Miró store URL
    (terraform -chdir=../1-deploy-sentinel output -raw maison_url).
  EOT
}
