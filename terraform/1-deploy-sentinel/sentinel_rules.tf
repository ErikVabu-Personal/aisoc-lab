#############################################
# Sentinel analytics rules (scheduled)
#
# IMPORTANT:
# We intentionally do NOT deploy analytics rules via Terraform.
# Sentinel validates KQL at rule creation time, so rules that query tables
# like ContainerAppConsoleLogs_CL can fail during initial provisioning.
#
# Deploy rules after infra provisioning via scripts under scripts/.
#############################################
