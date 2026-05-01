#############################################
# Detection Rules Knowledge Base (Foundry IQ)
#
# Stands up:
#   - Azure Storage account + container "detection-rules" (the corpus
#     bucket the SOC operator drops Sigma / KQL / markdown rule files
#     into post-apply).
#   - Azure AI Search service (Basic SKU by default) — the underlying
#     retrieval engine for Foundry IQ.
#   - System-assigned MIs on both, plus role assignments so the search
#     service can read the storage container and the Foundry project's
#     MI can query the search index at runtime.
#   - A Foundry IQ knowledge source pointing at the blob container, a
#     knowledge base wrapping it, and a project connection
#     (RemoteTool / ProjectManagedIdentity) that exposes the knowledge
#     base over MCP to the Detection Engineer agent.
#
# All gated behind var.detection_rules_kb_enabled. The actual document
# corpus is intentionally NOT managed by Terraform — the user uploads
# files to the storage container after apply (the indexer picks them
# up on its next scheduled run).
#############################################

locals {
  drk_enabled = var.detection_rules_kb_enabled

  # Deterministic-but-unique resource names. Storage account names are
  # alphanumeric + 24-char-max; squash the suffix in.
  drk_storage_account_name = lower(replace("aisocdetrules${random_string.suffix.result}", "-", ""))
  drk_storage_container    = "detection-rules"

  drk_search_service_name  = "aisoc-detrules-${random_string.suffix.result}"

  # AI Search names are 2–60 chars, alphanumerics + "-" only, lowercase.
  drk_index_name           = "detection-rules-idx"
  drk_data_source_name     = "detection-rules-blob"
  drk_indexer_name         = "detection-rules-indexer"
  drk_knowledge_source     = "detection-rules-source"
  drk_knowledge_base_name  = "detection-rules"

  # MCP tool wiring. drk_mcp_endpoint isn't built here anymore — the
  # agent deploy script (scripts/deploy_prompt_agents_with_runner_tools.py)
  # constructs it from the search-endpoint output and its own
  # KB_MCP_API_VERSION constant. Centralising the version in one
  # place (the script) means a future GA bump is a single-line edit.
  drk_project_connection_name = "detection-rules-kb"
  drk_search_endpoint         = local.drk_enabled ? "https://${azurerm_search_service.detection_rules[0].name}.search.windows.net" : ""

  # Search data-plane API versions used by the seeder script.
  #
  # Microsoft.Search exposes only the searchServices resource through
  # ARM; sub-resources (datasources, indexes, indexers, knowledgeSources,
  # knowledgeBases) are data-plane only at every API version. We used
  # to declare them as azapi_resource against ARM and got 404 from the
  # management plane because those URLs simply don't exist (see the
  # seeder script header comment for the full diagnosis). The seeder
  # script PUTs each one to the data plane instead.
  #
  # 2024-07-01 is the current GA data-plane API and covers
  # datasources/indexes/indexers. 2025-11-01-preview is required for
  # knowledgeSources/knowledgeBases, which are still preview features
  # of the agentic-retrieval service.
  drk_search_dp_api_version = "2024-07-01"
  drk_search_kb_api_version = "2025-11-01-preview"
}


# ── Storage account + container for the rule corpus ────────────────

resource "azurerm_storage_account" "detection_rules" {
  count                    = local.drk_enabled ? 1 : 0
  name                     = local.drk_storage_account_name
  resource_group_name      = data.terraform_remote_state.sentinel.outputs.resource_group
  location                 = local.location_effective
  account_tier             = "Standard"
  account_replication_type = "LRS"

  # Public network access is left ON for demo simplicity (the indexer
  # uses the storage account's data plane). Production would lock this
  # down via private endpoints.
  public_network_access_enabled = true

  # Disable Storage account key auth for reads from the indexer; the
  # search service's MI is the read path. Demo-grade — keys still work
  # for `az storage blob upload` from the operator's CLI.
  shared_access_key_enabled = true
}

resource "azurerm_storage_container" "detection_rules" {
  count                 = local.drk_enabled ? 1 : 0
  name                  = local.drk_storage_container
  storage_account_id    = azurerm_storage_account.detection_rules[0].id
  container_access_type = "private"
}


# ── Azure AI Search service ─────────────────────────────────────────

resource "azurerm_search_service" "detection_rules" {
  count               = local.drk_enabled ? 1 : 0
  name                = local.drk_search_service_name
  resource_group_name = data.terraform_remote_state.sentinel.outputs.resource_group
  location            = local.location_effective
  sku                 = var.detection_rules_kb_search_sku

  # Semantic ranker — REQUIRED by Foundry IQ's agentic-retrieval
  # engine. Without it, the Foundry portal's Knowledge bases tab
  # shows "Semantic ranker is required Creating and querying
  # knowledge bases requires semantic ranker to be enabled on this
  # Azure AI Search service" and the project connection's MCP
  # endpoint refuses to list KBs.
  #
  # "free" gives 1000 semantic queries / month at no extra cost;
  # plenty for the demo. Bump to "standard" if/when query volume
  # grows. Requires Basic SKU or higher (it's a no-op on Free SKU,
  # but Free can't host KBs anyway).
  semantic_search_sku = "free"

  # System-assigned identity so the indexer can pull from Blob using
  # RBAC instead of a connection string.
  identity {
    type = "SystemAssigned"
  }

  # Local auth (admin key) is enabled so the post-apply seed script /
  # operator can POST to the management plane during initial setup.
  # The MCP tool itself uses Entra (project MI) — so this is a dev
  # convenience, not the runtime auth path.
  local_authentication_enabled = true
}


# ── Role assignments ──────────────────────────────────────────────────
#
# 1) Search service MI -> Storage Blob Data Reader on the corpus.
#    Lets the indexer read the rule files without a connection string.
# 2) Foundry account/hub MI -> Search Index Data Reader on the search
#    service. Hub-level operations (e.g. Foundry's own KB management
#    UI inside the portal) authenticate as the account MI.
# 3) Search service MI -> Search Index Data Contributor on itself.
#    Required for the agentic-retrieval engine to write back the
#    semantic-rerank scoring profile during agentic queries.
# 4) Deploying user (current az login) -> Search Index Data Contributor
#    on the search service. Azure AI Search has a notorious gotcha:
#    even subscription Owners do NOT get data-plane access on the
#    Search service automatically. Without this, the Foundry portal's
#    "Knowledge bases" tab fails with "Failed to fetch knowledge
#    bases for connection <svc>…" because the portal calls the
#    Search data plane as the LOGGED-IN USER, not as a managed
#    identity. Granting the deploying user the data-plane role makes
#    the portal experience work.
#    Contributor (vs. Reader) — the portal's Knowledge-bases UI lets
#    you create / edit / delete; Reader is enough for read-only
#    listing but the portal also tries write probes and fails
#    silently on Reader.
#
# The Foundry **project** has its own system-assigned MI, distinct
# from the account MI. The KB project connection uses
# ProjectManagedIdentity auth, which means the project MI — not the
# account MI — is what calls the Search MCP endpoint at runtime.
# Terraform can't grant the role to the project MI here because the
# project doesn't exist at apply time (it's created post-apply by
# scripts/deploy_foundry_project.py). The role assignment happens
# instead in scripts/deploy_prompt_agents_with_runner_tools.py via
# `_ensure_search_role_for_project_mi`, which is idempotent and safe
# to re-run.

resource "azurerm_role_assignment" "drk_search_to_storage" {
  count                = local.drk_enabled ? 1 : 0
  scope                = azurerm_storage_account.detection_rules[0].id
  role_definition_name = "Storage Blob Data Reader"
  principal_id         = azurerm_search_service.detection_rules[0].identity[0].principal_id
  description          = "Detection Rules KB indexer reads the corpus from Blob via MI."
}

resource "azurerm_role_assignment" "drk_foundry_to_search" {
  count                = local.drk_enabled ? 1 : 0
  scope                = azurerm_search_service.detection_rules[0].id
  role_definition_name = "Search Index Data Reader"
  principal_id         = azapi_resource.foundry_account.output.identity.principalId
  description          = "Foundry agents (via project MI) query the Detection Rules knowledge base."
}

resource "azurerm_role_assignment" "drk_search_self_contributor" {
  count                = local.drk_enabled ? 1 : 0
  scope                = azurerm_search_service.detection_rules[0].id
  role_definition_name = "Search Index Data Contributor"
  principal_id         = azurerm_search_service.detection_rules[0].identity[0].principal_id
  description          = "Search service MI writes agentic-retrieval rerank state on its own indexes."
}

# Grants the identity that's running `terraform apply` (Erik's
# `az login` user, or the CI service principal) data-plane access
# on the Search service, so the Foundry portal's Knowledge Bases
# UI loads without "Failed to fetch knowledge bases for connection".
# The portal authenticates against Search as the *logged-in user*,
# not as a managed identity — RBAC at the management plane (Owner
# / Contributor at subscription level) does NOT grant data-plane
# access to AI Search. This is one of the highest-friction
# gotchas in setting up Foundry IQ for the first time.
resource "azurerm_role_assignment" "drk_user_to_search" {
  count                = local.drk_enabled ? 1 : 0
  scope                = azurerm_search_service.detection_rules[0].id
  role_definition_name = "Search Index Data Contributor"
  principal_id         = data.azurerm_client_config.current.object_id
  description          = "Deploying user can list / inspect KBs in the Foundry portal Knowledge Bases tab."
}


# ── Search sub-resources via the data-plane API ─────────────────────
#
# Microsoft.Search exposes ONLY the searchServices resource itself
# through ARM. Every sub-resource — datasources, indexes, indexers,
# knowledgeSources, knowledgeBases — must be created via the data
# plane (https://<service>.search.windows.net/...). An earlier
# revision tried azapi_resource against
# Microsoft.Search/searchServices/dataSources@2025-05-01 and got
# 404 from ARM with no body — those URLs simply don't exist at any
# API version. Confirmed against the official ARM template docs for
# both 2025-05-01 (stable) and 2026-03-01-preview (latest preview).
#
# We use a single null_resource that invokes the seeder script.
# Each PUT is idempotent so re-runs are safe; `triggers` re-runs the
# seeder when any of the wire-arguments change.

resource "null_resource" "drk_search_seed" {
  count = local.drk_enabled ? 1 : 0

  # Re-run the seeder on any change to the wire-args. Hash via
  # jsonencode so re-runs are deterministic and stable across plans.
  triggers = {
    inputs_hash = sha256(jsonencode({
      endpoint           = local.drk_search_endpoint
      storage_account_id = azurerm_storage_account.detection_rules[0].id
      container          = azurerm_storage_container.detection_rules[0].name
      index              = local.drk_index_name
      data_source        = local.drk_data_source_name
      indexer            = local.drk_indexer_name
      knowledge_source   = local.drk_knowledge_source
      knowledge_base     = local.drk_knowledge_base_name
      dp_api             = local.drk_search_dp_api_version
      kb_api             = local.drk_search_kb_api_version
    }))
  }

  provisioner "local-exec" {
    # Path is relative to the Terraform working directory
    # (terraform/2-deploy-aisoc) so this works whether plan/apply is
    # invoked from there directly or from the repo-root deploy script.
    command = "${path.module}/scripts/seed_search_kb.sh"

    environment = {
      SEARCH_ENDPOINT       = local.drk_search_endpoint
      SEARCH_ADMIN_KEY      = azurerm_search_service.detection_rules[0].primary_key
      STORAGE_ACCOUNT_ID    = azurerm_storage_account.detection_rules[0].id
      STORAGE_CONTAINER     = azurerm_storage_container.detection_rules[0].name
      INDEX_NAME            = local.drk_index_name
      DATA_SOURCE_NAME      = local.drk_data_source_name
      INDEXER_NAME          = local.drk_indexer_name
      KNOWLEDGE_SOURCE_NAME = local.drk_knowledge_source
      KNOWLEDGE_BASE_NAME   = local.drk_knowledge_base_name
      DP_API_VERSION        = local.drk_search_dp_api_version
      KB_API_VERSION        = local.drk_search_kb_api_version
      KS_DESCRIPTION        = "NVISO detection rule library — Sigma / KQL / writeups."
      KB_DESCRIPTION        = "Detection rule library for the AISOC Detection Engineer agent."
      FILE_EXTENSIONS       = ".yml,.yaml,.kql,.md,.txt,.json"
    }
  }

  depends_on = [
    # Indexer needs Blob read RBAC to be in place before its first run.
    azurerm_role_assignment.drk_search_to_storage,
    # Knowledge base writes back into the index for agentic-retrieval
    # rerank state — needs Search Index Data Contributor on self.
    azurerm_role_assignment.drk_search_self_contributor,
  ]
}

# Project connection — RemoteTool / ProjectManagedIdentity.
#
# Intentionally NOT created here. The Foundry project itself is
# created post-apply by scripts/deploy_foundry_project.py (see
# foundry.tf for why the project resource isn't in Terraform).
# Trying to create this connection during `terraform apply` would
# fail because parent_id references a project that doesn't exist
# yet.
#
# Instead, scripts/deploy_prompt_agents_with_runner_tools.py creates
# the connection idempotently right before it attaches the MCP tool
# to the Detection Engineer agent. It uses the search endpoint + KB
# name + project connection name from the Terraform outputs we
# expose below.


# ── Outputs (consumed by the agent deploy script) ───────────────────

output "detection_rules_kb_enabled" {
  description = "Whether the Detection Rules KB subsystem is provisioned in this state."
  value       = local.drk_enabled
}

output "detection_rules_storage_account" {
  description = "Storage account holding the rule corpus (drop Sigma / KQL / md files into the 'detection-rules' container after apply)."
  value       = local.drk_enabled ? azurerm_storage_account.detection_rules[0].name : ""
}

output "detection_rules_storage_container" {
  description = "Blob container name for the rule corpus."
  value       = local.drk_enabled ? azurerm_storage_container.detection_rules[0].name : ""
}

output "detection_rules_search_endpoint" {
  description = "Azure AI Search endpoint hosting the Detection Rules knowledge base."
  value       = local.drk_enabled ? local.drk_search_endpoint : ""
}

output "detection_rules_kb_name" {
  description = "Foundry IQ knowledge base name."
  value       = local.drk_enabled ? local.drk_knowledge_base_name : ""
}

output "detection_rules_project_connection_name" {
  description = "Foundry project connection name that exposes the knowledge base over MCP."
  value       = local.drk_enabled ? local.drk_project_connection_name : ""
}
