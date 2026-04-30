#!/usr/bin/env bash
# seed_detection_rules_search.sh — populate the Detection Rules KB on
# Azure AI Search via the data-plane REST API.
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
          "titleField":    { "fieldName": "metadata_storage_name" },
          "contentFields": [ { "fieldName": "content" } ]
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
      "indexedFileNameExtensions": ".yml,.yaml,.kql,.md,.txt,.json"
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
  "description": "NVISO detection rule library — Sigma / KQL / writeups.",
  "searchIndexParameters": {
    "searchIndexName": "${INDEX_NAME}"
  }
}
JSON
)"

echo "=== Knowledge base: ${KNOWLEDGE_BASE_NAME} ==="
put "knowledgeBases/${KNOWLEDGE_BASE_NAME}" "${KB_API_VERSION}" "$(cat <<JSON
{
  "name": "${KNOWLEDGE_BASE_NAME}",
  "description": "Detection rule library for the AISOC Detection Engineer agent.",
  "knowledgeSources": [
    { "name": "${KNOWLEDGE_SOURCE_NAME}" }
  ],
  "retrievalInstructions": "Detection rule corpus — Sigma rules, KQL queries, written analytic playbooks. When asked about analytics, prefer rules that already exist over inventing new ones.",
  "retrievalParameters": {
    "reasoningEffort": "low"
  }
}
JSON
)"

echo
echo "All Detection Rules Search resources created/updated successfully."
