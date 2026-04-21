output "runner_url" {
  value       = "https://${azurerm_container_app.runner.ingress[0].fqdn}"
  description = "Runner base URL (public)"
}

output "runner_bearer_token_secret_name" {
  value       = azurerm_key_vault_secret.runner_token.name
  description = "Key Vault secret name storing the runner bearer token."
}
