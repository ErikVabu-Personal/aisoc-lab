# MDE onboarding (simple)

This lab supports onboarding the VM to Microsoft Defender for Endpoint (MDE) **without pasting scripts into Terraform**.

## How it works

- Terraform creates a Key Vault.
- You upload the tenant-specific onboarding script as a Key Vault secret.
- The VM uses its **system-assigned managed identity** to fetch the secret and execute it.

## Steps

1) Enable MDE onboarding in `terraform.tfvars`:

```hcl
enable_defender_for_endpoint = true
mde_onboarding_secret_name   = "MDE-ONBOARD"
```

2) Apply once to create the Key Vault + permissions:

```bash
terraform apply
```

3) Upload the onboarding script to Key Vault.

**Option A (recommended for non-lab):** upload via `az keyvault secret set` (does NOT store the script in TF state).

```bash
az keyvault secret set --vault-name <vaultName> --name MDE-ONBOARD --file onboarding.cmd
```

**Option B (LAB ONLY):** let Terraform upload it (stores the script in TF state).

```hcl
mde_onboarding_script_path = "./onboarding.cmd"
```

4) Apply again so the extension pulls and runs the script:

```bash
terraform apply
```

## Sentinel MDE connector

Enabling the Sentinel connector can fail with `InvalidLicense` / `Missing consent` if your tenant hasn't granted consent.
Keep `enable_sentinel_mde_connector=false` until:

- MDE is licensed and set up in the tenant
- Consent is granted for Sentinel to read MDE data
