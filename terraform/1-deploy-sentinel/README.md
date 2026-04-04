# Azure Sentinel test environment (Terraform)

Creates:
- Resource Group
- Log Analytics Workspace
- Microsoft Sentinel onboarding (SecurityInsights)
- Windows 11 VM (Azure Virtual Desktop / Windows Client image)

## Prereqs

- Terraform >= 1.6
- Azure CLI logged in: `az login`
- Subscription selected: `az account set -s <SUBSCRIPTION_ID>`

## Deploy

```bash
cd terraform/azure-sentinel-test
terraform init
terraform apply
```

## Destroy

```bash
terraform destroy
```

## Logs flowing into Sentinel

Sentinel is just a solution on top of a Log Analytics Workspace. To get host logs into Sentinel, this stack:

- installs **Azure Monitor Agent (AMA)** on the VM
- creates a **Data Collection Rule (DCR)** to collect Windows Event Logs (Application/System/Security)
- associates the DCR to the VM

Note: the DCR uses the default ingestion endpoint (no DCE) to keep payloads simple and avoid API validation edge-cases.

Once deployed, you should see events arriving in Log Analytics tables (WindowsEvent) and they’ll be available for Sentinel analytics rules.

## Defender for Endpoint (MDE)

There are two parts:

1) **Onboard the VM to MDE** (tenant-level feature). Terraform can do this **only if you provide** the PowerShell onboarding script exported from the MDE portal.
2) **Enable the Sentinel data connector for MDE** so MDE alerts/incidents flow into Sentinel.

This stack includes optional resources for both, but they are disabled by default.

## Notes

- Windows 11 images in Azure are typically "Windows 11 Enterprise multi-session" (AVD). This module uses an Azure Marketplace image reference.
- To keep cost down, pick a small VM size and set auto-shutdown.

## DCR troubleshooting

If you see `InvalidPayload: Data collection rule is invalid`, it's usually caused by invalid XPath queries or an output stream/table mismatch.
This module uses a conservative set of XPath queries (Level 1-3 only) to improve compatibility.
