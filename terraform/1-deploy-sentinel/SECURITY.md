# Security notes

## Secrets

- `admin_password`, `mde_onboarding_script`, and `openrouter_api_key` are sensitive.
- Do **not** commit `terraform.tfvars`.
- Prefer a secure secrets store (e.g. Terraform Cloud variables, GitHub Actions secrets, or Key Vault) for production usage.

## Defender for Endpoint onboarding script

The onboarding script is tenant-specific and should be treated as sensitive. This module base64-encodes it into VM extension protected settings.
