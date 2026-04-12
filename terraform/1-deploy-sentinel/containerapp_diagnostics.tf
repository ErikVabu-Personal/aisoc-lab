#############################################
# Azure Container Apps → Log Analytics diagnostics
#
# NOTE:
# - Diagnostic categories for Azure Container Apps vary by API/provider/region.
# - In your subscription/region, both "ContainerAppConsoleLogs" and "ConsoleLogs"
#   are reported as unsupported for Microsoft.App/containerApps.
#
# To avoid breaking `terraform apply` for the demo, this file is intentionally
# left empty for now.
#
# Next step (requires provider discovery):
# - Use `az monitor diagnostic-settings categories list --resource <containerAppId>`
#   to see supported categories, then re-enable an azurerm_monitor_diagnostic_setting
#   with those exact category names.
#
# Workaround (no diagnostics):
# - Use Container App -> Log stream in Azure Portal to view console logs.
#############################################
