#############################################
# Company Context Knowledge Base (Foundry IQ)
#
# Holds the generic organisational context every SOC agent needs in
# the loop — fleet, subsystems, account naming conventions, VIP /
# sensitive accounts, IR runbooks, glossary, escalation matrix.
# Lets us trim common.md down to just the technical contract: the
# agent retrieves company-specific context only when it's relevant
# to the question being asked, instead of carrying it in every
# prompt.
#
# Architecture
# ------------
# Reuses the AI Search service from detection_rules_kb.tf — Search
# services can host many indexes / KBs side-by-side, so spinning up
# a second one would just be ~€80/month of waste. The corpus lives
# in its own Storage account though, so the SOC manager can edit
# the company context without touching the detection-rule library
# (separation of concerns + separate RBAC scopes).
#
# All gated behind var.company_context_kb_enabled. The corpus is
# intentionally NOT managed by Terraform — the operator uploads
# starter files from agents/company-context/ post-apply (the
# indexer picks them up on its next scheduled run).
#
# Demo angle: the "company-context" knowledge base is what you'd
# point at SharePoint in a real customer deployment. Foundry IQ
# treats both the same way — the project connection's MCP endpoint
# is the agent-facing contract; whether the underlying knowledge
# source is an Azure AI Search index over Blob, or a SharePoint
# site, is a portal-level config swap. See agents/company-context/
# README.md for the SharePoint swap procedure.
#############################################

locals {
  cck_enabled = (
    var.company_context_kb_enabled
    && var.detection_rules_kb_enabled
  )

  # Storage names — separate account so the SOC manager has its
  # own blob container for company docs, distinct from the
  # detection-rule corpus.
  cck_storage_account_name = lower(replace("aisoccompanyctx${random_string.suffix.result}", "-", ""))
  cck_storage_container    = "company-context"

  # Sub-resource names on the (reused) Search service. Kept short
  # to leave room within Search's 60-char identifier limit.
  #
  # The "context" set holds SOC-curated content (runbooks, naming,
  # glossary, escalation). The "policies" set is the second corpus —
  # HR / IT-curated content (acceptable-use policy, asset inventory,
  # vendor list). Both feed the SAME knowledgeBase
  # ("company-context") so the agents see one MCP endpoint with
  # federated retrieval across both sources. Demonstrates Foundry
  # IQ's source-agnostic pitch: more sources, same KB, no agent
  # changes.
  cck_index_name             = "company-context-idx"
  cck_data_source_name       = "company-context-blob"
  cck_indexer_name           = "company-context-indexer"
  cck_knowledge_source       = "company-context-source"
  cck_knowledge_base_name    = "company-context"

  cck_pol_container_name     = "company-policies"
  cck_pol_index_name         = "company-policies-idx"
  cck_pol_data_source_name   = "company-policies-blob"
  cck_pol_indexer_name       = "company-policies-indexer"
  cck_pol_knowledge_source   = "company-policies-source"

  cck_project_connection_name = "company-context-kb"
}


# ── Storage account + container for the company corpus ─────────────

resource "azurerm_storage_account" "company_context" {
  count                    = local.cck_enabled ? 1 : 0
  name                     = local.cck_storage_account_name
  resource_group_name      = data.terraform_remote_state.sentinel.outputs.resource_group
  location                 = local.location_effective
  account_tier             = "Standard"
  account_replication_type = "LRS"

  public_network_access_enabled = true
  shared_access_key_enabled     = true
}

resource "azurerm_storage_container" "company_context" {
  count                 = local.cck_enabled ? 1 : 0
  name                  = local.cck_storage_container
  storage_account_id    = azurerm_storage_account.company_context[0].id
  container_access_type = "private"
}

# Second container in the SAME storage account — holds the
# company-policies corpus (HR / IT-curated, separate from the SOC-
# curated runbooks in the company-context container). Lives on one
# storage account because there's no cost benefit to splitting and
# the per-container RBAC scope keeps separation-of-concerns clean
# enough for a demo. In production you'd typically split by
# functional team.
resource "azurerm_storage_container" "company_policies" {
  count                 = local.cck_enabled ? 1 : 0
  name                  = local.cck_pol_container_name
  storage_account_id    = azurerm_storage_account.company_context[0].id
  container_access_type = "private"
}


# ── Role assignment: Search service MI -> Storage Blob Data Reader ─

resource "azurerm_role_assignment" "cck_search_to_storage" {
  count                = local.cck_enabled ? 1 : 0
  scope                = azurerm_storage_account.company_context[0].id
  role_definition_name = "Storage Blob Data Reader"
  principal_id         = azurerm_search_service.detection_rules[0].identity[0].principal_id
  description          = "Company Context KB indexer reads the corpus from Blob via MI."
}

# Note: the Foundry account/hub MI already has Search Index Data
# Reader on the Search service (granted in detection_rules_kb.tf via
# drk_foundry_to_search). The same applies to the Foundry project
# MI (granted post-apply by the agent deploy script). Both KBs ride
# the same RBAC — no new grants needed here.


# ── Search sub-resources via the data-plane API ─────────────────────
#
# Same pattern as detection_rules_kb.tf — Microsoft.Search ARM
# exposes only the searchServices resource itself, sub-resources
# (datasources/indexes/indexers/knowledgeSources/knowledgeBases) are
# data-plane only. We invoke the same generic seed_search_kb.sh
# helper with company-context-specific parameters.

# Seed pass 1 — context source (SOC-curated). Creates datasource +
# index + indexer + knowledgeSource for the company-context blob,
# plus a knowledgeBase that points at JUST this source (one item in
# its knowledgeSources[] list).
resource "null_resource" "cck_search_seed_context" {
  count = local.cck_enabled ? 1 : 0

  triggers = {
    inputs_hash = sha256(jsonencode({
      endpoint           = local.drk_search_endpoint
      storage_account_id = azurerm_storage_account.company_context[0].id
      container          = azurerm_storage_container.company_context[0].name
      index              = local.cck_index_name
      data_source        = local.cck_data_source_name
      indexer            = local.cck_indexer_name
      knowledge_source   = local.cck_knowledge_source
      knowledge_base     = local.cck_knowledge_base_name
      dp_api             = local.drk_search_dp_api_version
      kb_api             = local.drk_search_kb_api_version
    }))
  }

  provisioner "local-exec" {
    command = "${path.module}/scripts/seed_search_kb.sh"

    environment = {
      SEARCH_ENDPOINT       = local.drk_search_endpoint
      SEARCH_ADMIN_KEY      = azurerm_search_service.detection_rules[0].primary_key
      STORAGE_ACCOUNT_ID    = azurerm_storage_account.company_context[0].id
      STORAGE_CONTAINER     = azurerm_storage_container.company_context[0].name
      INDEX_NAME            = local.cck_index_name
      DATA_SOURCE_NAME      = local.cck_data_source_name
      INDEXER_NAME          = local.cck_indexer_name
      KNOWLEDGE_SOURCE_NAME = local.cck_knowledge_source
      KNOWLEDGE_BASE_NAME   = local.cck_knowledge_base_name
      DP_API_VERSION        = local.drk_search_dp_api_version
      KB_API_VERSION        = local.drk_search_kb_api_version
      KS_DESCRIPTION        = "NVISO Cruiseways SOC context — fleet, subsystems, account naming, IR runbooks, glossary, escalation."
      KB_DESCRIPTION        = "Generic organisational context for the AISOC SOC agents. Federates SOC-curated runbooks + HR/IT-curated policies into one KB."
      FILE_EXTENSIONS       = ".md,.txt"
    }
  }

  depends_on = [
    azurerm_role_assignment.cck_search_to_storage,
    azurerm_search_service.detection_rules,
    azurerm_role_assignment.drk_search_self_contributor,
  ]
}

# Seed pass 2 — policies source (HR/IT-curated). Creates a SECOND
# datasource + index + indexer + knowledgeSource for the company-
# policies blob, then idempotently re-PUTs the same knowledgeBase
# but with BOTH sources in its knowledgeSources[] list (via
# EXTRA_KNOWLEDGE_SOURCES). The KB is the same name; a single PUT
# overwrites the previous (single-source) definition. This is what
# demonstrates Foundry IQ's federation: one MCP endpoint, multiple
# sources behind it, agents see no difference.
#
# depends_on the first pass so we never re-PUT a single-source KB
# AFTER the two-source PUT (which would silently drop the policies
# source from the federation until the next plan).
resource "null_resource" "cck_search_seed_policies" {
  count = local.cck_enabled ? 1 : 0

  triggers = {
    inputs_hash = sha256(jsonencode({
      endpoint           = local.drk_search_endpoint
      storage_account_id = azurerm_storage_account.company_context[0].id
      container          = azurerm_storage_container.company_policies[0].name
      index              = local.cck_pol_index_name
      data_source        = local.cck_pol_data_source_name
      indexer            = local.cck_pol_indexer_name
      knowledge_source   = local.cck_pol_knowledge_source
      knowledge_base     = local.cck_knowledge_base_name
      extra_sources      = local.cck_knowledge_source
      dp_api             = local.drk_search_dp_api_version
      kb_api             = local.drk_search_kb_api_version
    }))
  }

  provisioner "local-exec" {
    command = "${path.module}/scripts/seed_search_kb.sh"

    environment = {
      SEARCH_ENDPOINT          = local.drk_search_endpoint
      SEARCH_ADMIN_KEY         = azurerm_search_service.detection_rules[0].primary_key
      STORAGE_ACCOUNT_ID       = azurerm_storage_account.company_context[0].id
      STORAGE_CONTAINER        = azurerm_storage_container.company_policies[0].name
      INDEX_NAME               = local.cck_pol_index_name
      DATA_SOURCE_NAME         = local.cck_pol_data_source_name
      INDEXER_NAME             = local.cck_pol_indexer_name
      KNOWLEDGE_SOURCE_NAME    = local.cck_pol_knowledge_source
      KNOWLEDGE_BASE_NAME      = local.cck_knowledge_base_name
      DP_API_VERSION           = local.drk_search_dp_api_version
      KB_API_VERSION           = local.drk_search_kb_api_version
      KS_DESCRIPTION           = "NVISO Cruiseways HR / IT policies — acceptable use, asset inventory, vendor list."
      KB_DESCRIPTION           = "Generic organisational context for the AISOC SOC agents. Federates SOC-curated runbooks + HR/IT-curated policies into one KB."
      FILE_EXTENSIONS          = ".md,.txt"
      # The federation move — re-PUT the same knowledgeBase but with
      # BOTH sources in its knowledgeSources[] list.
      EXTRA_KNOWLEDGE_SOURCES  = local.cck_knowledge_source
    }
  }

  depends_on = [
    null_resource.cck_search_seed_context,
    azurerm_role_assignment.cck_search_to_storage,
  ]
}


# ── Outputs (consumed by the agent deploy script) ───────────────────

output "company_context_kb_enabled" {
  description = "Whether the Company Context KB subsystem is provisioned in this state."
  value       = local.cck_enabled
}

output "company_context_storage_account" {
  description = "Storage account holding the company-context corpus. Drop markdown / text files into the 'company-context' container after apply."
  value       = local.cck_enabled ? azurerm_storage_account.company_context[0].name : ""
}

output "company_context_storage_container" {
  description = "Blob container name for the SOC-curated company-context corpus."
  value       = local.cck_enabled ? azurerm_storage_container.company_context[0].name : ""
}

output "company_policies_storage_container" {
  description = "Blob container name for the HR/IT-curated company-policies corpus (federated into the same Foundry IQ knowledge base as company-context)."
  value       = local.cck_enabled ? azurerm_storage_container.company_policies[0].name : ""
}

output "company_context_search_endpoint" {
  description = "Azure AI Search endpoint hosting the Company Context knowledge base. Same service as the Detection Rules KB."
  value       = local.cck_enabled ? local.drk_search_endpoint : ""
}

output "company_context_kb_name" {
  description = "Foundry IQ knowledge base name."
  value       = local.cck_enabled ? local.cck_knowledge_base_name : ""
}

output "company_context_project_connection_name" {
  description = "Foundry project connection name that exposes the company-context KB over MCP."
  value       = local.cck_enabled ? local.cck_project_connection_name : ""
}
