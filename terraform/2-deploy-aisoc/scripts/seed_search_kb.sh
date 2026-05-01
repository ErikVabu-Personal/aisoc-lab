#!/usr/bin/env bash
# seed_search_kb.sh — populate a Foundry IQ knowledge base on
# Azure AI Search via the data-plane REST API.
#
# Originally named seed_detection_rules_search.sh and hard-wired to
# the Detection Rules corpus. Generalised when we added a second KB
# (company-context) on the same Search service. The two callers pass
# different storage accounts, container names, index/source/KB names,
# and descriptions; everything else (auth, retry logic, idempotency)
# is shared.
#
# Background
# ----------
# Microsoft.Search exposes ONLY the searchServices resource through ARM.
# Sub-resources (dataSources, indexes, indexers, knowledgeSources,
# knowledgeBases) are data-plane only — they live at
#   https://<service>.search.windows.net/<type>/<name>?api-version=...
# and were never addressable via the management plane at any API
# version. An earlier Terraform version tried azapi_resource against
# Microsoft.Search/searchServices/dataSources@2025-05-01 etc and got
# 404 from ARM ("Response contained no body") because those URLs
# simply do not exist. This script is the replacement: it uses the
# Search service's admin key to PUT each sub-resource through the
# data plane, idempotently.
#
# Required env vars
# -----------------
#   SEARCH_ENDPOINT          https://<service>.search.windows.net
#   SEARCH_ADMIN_KEY         primary admin key (treat as secret)
#   STORAGE_ACCOUNT_ID       /subscriptions/.../storageAccounts/<name>
#   STORAGE_CONTAINER        blob container holding the rule corpus
#   INDEX_NAME               name for the search index
#   DATA_SOURCE_NAME         name for the data source
#   INDEXER_NAME             name for the indexer
#   KNOWLEDGE_SOURCE_NAME    name for the Foundry IQ knowledge source
#   KNOWLEDGE_BASE_NAME      name for the Foundry IQ knowledge base
#
# Optional env vars
# -----------------
#   DP_API_VERSION           default 2024-07-01 (stable; covers
#                            datasources/indexes/indexers)
#   KB_API_VERSION           default 2025-11-01-preview (preview;
#                            covers knowledgeSources/knowledgeBases —
#                            agentic-retrieval feature is preview-only
#                            as of April 2026)
#   KS_DESCRIPTION           free-form description on the knowledge
#                            source resource (shown in the Foundry
#                            portal). Defaults to a generic string.
#   KB_DESCRIPTION           same, but on the knowledge base.
#   FILE_EXTENSIONS          comma-separated list passed to the
#                            indexer's indexedFileNameExtensions
#                            parameter. Default suits both rule
#                            (.yml/.kql/.json/.md/.txt) and prose-doc
#                            (.md/.txt) corpora.
#
# Idempotency
# -----------
# Every Search data-plane PUT is idempotent: running this script twice
# is safe. The only side effect of a re-run is that the indexer is
# re-created — Azure resets its watermark, so the next run pulls the
# whole corpus again. This is acceptable for a demo deploy.

set -euo pipefail

: "${SEARCH_ENDPOINT:?required}"
: "${SEARCH_ADMIN_KEY:?required}"
: "${STORAGE_ACCOUNT_ID:?required}"
: "${STORAGE_CONTAINER:?required}"
: "${INDEX_NAME:?required}"
: "${DATA_SOURCE_NAME:?required}"
: "${INDEXER_NAME:?required}"
: "${KNOWLEDGE_SOURCE_NAME:?required}"
: "${KNOWLEDGE_BASE_NAME:?required}"

DP_API_VERSION="${DP_API_VERSION:-2024-07-01}"
KB_API_VERSION="${KB_API_VERSION:-2025-11-01-preview}"
KS_DESCRIPTION="${KS_DESCRIPTION:-Foundry IQ knowledge source.}"
KB_DESCRIPTION="${KB_DESCRIPTION:-Foundry IQ knowledge base.}"
FILE_EXTENSIONS="${FILE_EXTENSIONS:-.yml,.yaml,.kql,.md,.txt,.json}"

put() {
  # put <path> <api-version> <body>
  local path="$1" api="$2" body="$3"
  local url="${SEARCH_ENDPOINT}/${path}?api-version=${api}"
  echo ">> PUT ${url}"

  # --fail-with-body so we get the response body on error (curl swallows
  # it with --fail). --silent --show-error is the usual "quiet on
  # success, loud on failure" combo. Retry transient 5xx / connection
  # resets but not 4xx (those are programmer errors and need fixing).
  local http_code
  http_code=$(
    curl --silent --show-error --location \
         --retry 3 --retry-delay 5 --retry-connrefused \
         --write-out '%{http_code}' \
         --output /tmp/search_dp_response.txt \
         -X PUT "${url}" \
         -H "api-key: ${SEARCH_ADMIN_KEY}" \
         -H "Content-Type: application/json" \
         --data-binary "${body}"
  )

  case "${http_code}" in
    20*|201|204)
      echo "   ok (${http_code})"
      ;;
    *)
      echo "   FAILED (${http_code})"
      echo "--- response body -----------------------------------------"
      cat /tmp/search_dp_response.txt || true
      echo
      echo "-----------------------------------------------------------"
      return 1
      ;;
  esac
}

echo "=== Data source: ${DATA_SOURCE_NAME} ==="
put "datasources/${DATA_SOURCE_NAME}" "${DP_API_VERSION}" "$(cat <<JSON
{
  "name": "${DATA_SOURCE_NAME}",
  "type": "azureblob",
  "credentials": { "connectionString": "ResourceId=${STORAGE_ACCOUNT_ID};" },
  "container": { "name": "${STORAGE_CONTAINER}" }
}
JSON
)"

echo "=== Index: ${INDEX_NAME} ==="
put "indexes/${INDEX_NAME}" "${DP_API_VERSION}" "$(cat <<JSON
{
  "name": "${INDEX_NAME}",
  "fields": [
    { "name": "id",                            "type": "Edm.String",         "key": true,  "searchable": false, "filterable": true,  "retrievable": true },
    { "name": "content",                       "type": "Edm.String",         "searchable": true,  "filterable": false, "retrievable": true,  "analyzer": "standard.lucene" },
    { "name": "metadata_storage_name",         "type": "Edm.String",         "searchable": true,  "filterable": true,  "retrievable": true },
    { "name": "metadata_storage_path",         "type": "Edm.String",         "searchable": false, "filterable": true,  "retrievable": true,  "sortable": false },
    { "name": "metadata_storage_last_modified","type": "Edm.DateTimeOffset", "searchable": false, "filterable": true,  "retrievable": true,  "sortable": true }
  ],
  "semantic": {
    "configurations": [
      {
        "name": "default",
        "prioritizedFields": {
          "titleField":               { "fieldName": "metadata_storage_name" },
          "prioritizedContentFields": [ { "fieldName": "content" } ]
        }
      }
    ]
  }
}
JSON
)"

echo "=== Indexer: ${INDEXER_NAME} ==="
put "indexers/${INDEXER_NAME}" "${DP_API_VERSION}" "$(cat <<JSON
{
  "name": "${INDEXER_NAME}",
  "dataSourceName":  "${DATA_SOURCE_NAME}",
  "targetIndexName": "${INDEX_NAME}",
  "schedule": { "interval": "PT30M" },
  "parameters": {
    "configuration": {
      "parsingMode":               "default",
      "dataToExtract":             "contentAndMetadata",
      "indexedFileNameExtensions": "${FILE_EXTENSIONS}"
    }
  },
  "fieldMappings": [
    {
      "sourceFieldName": "metadata_storage_path",
      "targetFieldName": "id",
      "mappingFunction": { "name": "base64Encode" }
    }
  ]
}
JSON
)"

echo "=== Knowledge source: ${KNOWLEDGE_SOURCE_NAME} ==="
put "knowledgeSources/${KNOWLEDGE_SOURCE_NAME}" "${KB_API_VERSION}" "$(cat <<JSON
{
  "name": "${KNOWLEDGE_SOURCE_NAME}",
  "kind": "searchIndex",
  "description": "${KS_DESCRIPTION}",
  "searchIndexParameters": {
    "searchIndexName": "${INDEX_NAME}"
  }
}
JSON
)"

echo "=== Knowledge base: ${KNOWLEDGE_BASE_NAME} ==="
# Note: 2025-11-01-preview RENAMED 2025-08-01-preview "knowledge agents"
# to "knowledge bases" and reshaped the body. retrievalParameters is
# gone — it now lives on the retrieve action, not the resource. The
# reasoning effort is a top-level retrievalReasoningEffort object with
# {"kind": "minimal"|"low"|"medium"}.
#
# We omit models[], retrievalInstructions, and use "minimal" reasoning
# effort. The API enforces a coherence rule: BOTH retrievalInstructions
# AND any reasoning effort above "minimal" require a models[] entry to
# be wired (they're inputs to the planner LLM, useless without one).
# "minimal" is the explicit no-LLM tier — the KB just runs direct
# index retrieval against the agent's query, no rewriting/decomposition.
#
# Wiring an LLM at the KB level would require a Cognitive Services
# User role assignment from the Search service MI to the Foundry
# account plus a models[] block — for the AISOC demo that's redundant
# work, since the Detection Engineer agent does its own reasoning and
# supplies queries directly when calling the KB. The KB just retrieves;
# the agent does the thinking.
put "knowledgeBases/${KNOWLEDGE_BASE_NAME}" "${KB_API_VERSION}" "$(cat <<JSON
{
  "name": "${KNOWLEDGE_BASE_NAME}",
  "description": "${KB_DESCRIPTION}",
  "knowledgeSources": [
    { "name": "${KNOWLEDGE_SOURCE_NAME}" }
  ],
  "retrievalReasoningEffort": { "kind": "minimal" }
}
JSON
)"

echo
echo "All Search KB resources created/updated successfully (KB: ${KNOWLEDGE_BASE_NAME})."
