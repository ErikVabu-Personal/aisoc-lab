# NOTE: `pixelagents_token` is output as sensitive. This is fine for a demo stack, but be mindful
# it will still exist in local terraform state.
#
# The resource group and Azure region are inherited directly from
# Phase 1's remote-state outputs — no overrides here, matching how
# Phase 2 handles the same concern. If you ever need to deploy
# PixelAgents Web into a different RG / region than the rest of the
# stack, reintroduce variables and wrap the consumers in coalesce().

variable "container_app_environment_id" {
  type        = string
  description = "Optional override: reuse an existing Container Apps Environment ID. If null/empty, reuses Phase 1 env when available; otherwise creates a new one."
  default     = null
}

variable "pixelagents_container_app_name" {
  type        = string
  description = "Name of the PixelAgents Web container app"
  default     = "ca-pixelagents-web"
}

variable "image" {
  type        = string
  description = "Container image reference for pixelagents_web"
  default     = "ghcr.io/erikvabu-personal/aisoc-lab-pixelagents-web:latest"
}

variable "create_log_analytics" {
  type        = bool
  description = "Create a Log Analytics workspace for ACA (if env is created)"
  default     = true
}

variable "pixelagents_users" {
  # Use `any` so callers can pass either:
  #   (a) {email = {password, roles}}      — preferred (with role gates)
  #   (b) {email = "password"}             — legacy shape, still accepted
  # The PixelAgents server's _load_users() handles both shapes
  # transparently, so old tfvars files keep deploying cleanly.
  type = any
  description = <<-EOT
    Demo login roster. Two accepted shapes:

      {
        "alice@example.com" = { password = "...", roles = ["soc-analyst"] }
        "bob@example.com"   = { password = "...", roles = ["soc-manager", "detection-engineer"] }
      }

      OR the legacy shape (no roles):

      {
        "alice@example.com" = "password"
      }

    Wired into the Container App as a secret + env var
    (AISOC_USERS_JSON), so adding/removing demo accounts is a one-line
    tfvars change. Leave empty {} to fall back to the hardcoded
    server-side roster (useful for first-deploy bootstrap).

    Known role slugs: "soc-manager", "detection-engineer",
    "soc-analyst". Anything else is silently dropped server-side.
    Only soc-manager users can access /config and the user-management
    UI.

    Demo-grade only — passwords are stored verbatim in the Container
    App secret. For anything closer to production, hash the values
    and run them through a real identity provider.
  EOT
  default     = {}
  sensitive   = true
}

# Note: the Foundry project endpoint used by the ad-hoc chat endpoint is
# inherited from Phase 2's `foundry_project_endpoint` output; it is no longer
# a Phase 3 variable. If Phase 2's output scheme ever needs overriding,
# reintroduce a variable here and wrap the consumer in coalesce().
