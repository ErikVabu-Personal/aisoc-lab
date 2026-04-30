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

  # Stable ARM API version for Microsoft.Search/searchServices/* —
  # confirmed in the Azure RP supported-versions list. Older preview
  # versions like "2025-08-01-preview" don't exist for this RP and
  # fail at apply with NoRegisteredProviderFound.
  drk_search_api_version    = "2025-05-01"
  # Knowledge bases / knowledge sources are preview features. The
  # latest preview that the searchServices RP actually advertises
  # (per a 400 NoRegisteredProviderFound list, May 2026) is
  # 2026-03-01-Preview.
  drk_kb_api_version        = "2026-03-01-Preview"
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
# 2) Foundry account MI -> Search Index Data Reader on the search service.
#    Lets the agent (via the Foundry project's MI proxy) issue
#    knowledge-base queries at runtime.
# 3) Search service MI -> Search Index Data Contributor on itself.
#    Required for the agentic-retrieval engine to write back the
#    semantic-rerank scoring profile during agentic queries.

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


# ── Knowledge source, knowledge base, and project connection ────────
#
# These are preview Foundry IQ resources, all created via azapi against
# the Azure AI Search management plane. They depend on the role
# assignments landing first so the indexer can read the corpus.

# Data source for the Blob container (consumed by the indexer below).
resource "azapi_resource" "drk_data_source" {
  count                     = local.drk_enabled ? 1 : 0
  type                      = "Microsoft.Search/searchServices/dataSources@${local.drk_search_api_version}"
  parent_id                 = azurerm_search_service.detection_rules[0].id
  name                      = local.drk_data_source_name
  schema_validation_enabled = false

  body = {
    properties = {
      type = "azureblob"
      credentials = {
        # ResourceId form lets the search service authenticate to the
        # storage account via its system-assigned MI (no key needed).
        connectionString = "ResourceId=${azurerm_storage_account.detection_rules[0].id};"
      }
      container = {
        name = azurerm_storage_container.detection_rules[0].name
      }
    }
  }

  depends_on = [
    azurerm_role_assignment.drk_search_to_storage,
  ]
}

# Index that the indexer fills + the knowledge source queries.
resource "azapi_resource" "drk_index" {
  count                     = local.drk_enabled ? 1 : 0
  type                      = "Microsoft.Search/searchServices/indexes@${local.drk_search_api_version}"
  parent_id                 = azurerm_search_service.detection_rules[0].id
  name                      = local.drk_index_name
  schema_validation_enabled = false

  body = {
    properties = {
      fields = [
        { name = "id",            type = "Edm.String", key = true,        searchable = false, filterable = true,  retrievable = true },
        { name = "content",       type = "Edm.String", key = false,       searchable = true,  filterable = false, retrievable = true,  analyzer = "standard.lucene" },
        { name = "metadata_storage_name", type = "Edm.String", searchable = true,  filterable = true,  retrievable = true },
        { name = "metadata_storage_path", type = "Edm.String", searchable = false, filterable = true,  retrievable = true, sortable = false },
        { name = "metadata_storage_last_modified", type = "Edm.DateTimeOffset", searchable = false, filterable = true, sortable = true, retrievable = true },
      ]
      semantic = {
        configurations = [{
          name = "default"
          prioritizedFields = {
            titleField = { fieldName = "metadata_storage_name" }
            contentFields = [{ fieldName = "content" }]
          }
        }]
      }
    }
  }

  depends_on = [
    azurerm_role_assignment.drk_search_self_contributor,
  ]
}

# Indexer pulls Blob contents into the index. fieldMapping handles the
# default Blob → index field rename for the document key.
resource "azapi_resource" "drk_indexer" {
  count                     = local.drk_enabled ? 1 : 0
  type                      = "Microsoft.Search/searchServices/indexers@${local.drk_search_api_version}"
  parent_id                 = azurerm_search_service.detection_rules[0].id
  name                      = local.drk_indexer_name
  schema_validation_enabled = false

  body = {
    properties = {
      dataSourceName = azapi_resource.drk_data_source[0].name
      targetIndexName = azapi_resource.drk_index[0].name
      schedule = {
        # Pull from blob every 30m; each pull is incremental (Blob
        # change-detection is built into the data source).
        interval = "PT30M"
      }
      parameters = {
        configuration = {
          # Pull text out of common rule formats. Sigma .yml, KQL .kql
          # (treated as text), .md writeups all index cleanly.
          parsingMode = "default"
          dataToExtract = "contentAndMetadata"
          indexedFileNameExtensions = ".yml,.yaml,.kql,.md,.txt,.json"
        }
      }
      fieldMappings = [
        { sourceFieldName = "metadata_storage_path", targetFieldName = "id", mappingFunction = { name = "base64Encode" } },
      ]
    }
  }

  depends_on = [
    azapi_resource.drk_data_source,
    azapi_resource.drk_index,
  ]
}

# Knowledge source — references the search index above and tells
# Foundry IQ how to query it (semantic + vector hybrid is the default).
resource "azapi_resource" "drk_knowledge_source" {
  count                     = local.drk_enabled ? 1 : 0
  type                      = "Microsoft.Search/searchServices/knowledgeSources@${local.drk_kb_api_version}"
  parent_id                 = azurerm_search_service.detection_rules[0].id
  name                      = local.drk_knowledge_source
  schema_validation_enabled = false

  body = {
    properties = {
      kind = "searchIndex"
      searchIndexParameters = {
        searchIndexName = azapi_resource.drk_index[0].name
      }
      description = "NVISO Cruiseways detection rule library — Sigma / KQL / writeups."
    }
  }

  depends_on = [
    azapi_resource.drk_indexer,
  ]
}

# Knowledge base — top-level Foundry IQ resource the agent connects to.
# Agentic retrieval planner runs over this with the configured
# reasoningEffort.
resource "azapi_resource" "drk_knowledge_base" {
  count                     = local.drk_enabled ? 1 : 0
  type                      = "Microsoft.Search/searchServices/knowledgeBases@${local.drk_kb_api_version}"
  parent_id                 = azurerm_search_service.detection_rules[0].id
  name                      = local.drk_knowledge_base_name
  schema_validation_enabled = false

  body = {
    properties = {
      description    = "Detection rule library for the AISOC Detection Engineer agent."
      knowledgeSources = [
        { name = azapi_resource.drk_knowledge_source[0].name }
      ]
      retrievalInstructions = "Detection rule corpus — Sigma rules, KQL queries, written analytic playbooks. When asked about analytics, prefer rules that already exist over inventing new ones."
      # "low" keeps the planner cheap; "medium" would decompose more
      # aggressively at higher token cost. Both work; revisit when the
      # corpus gets big.
      retrievalParameters = {
        reasoningEffort = "low"
      }
    }
  }

  depends_on = [
    azapi_resource.drk_knowledge_source,
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
