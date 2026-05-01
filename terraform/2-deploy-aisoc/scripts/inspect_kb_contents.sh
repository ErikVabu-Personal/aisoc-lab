#!/usr/bin/env bash
# inspect_kb_contents.sh — list everything indexed in the AISOC
# Search indexes, with a content snippet per doc, plus a sample
# semantic query. Useful for:
#   - "did the indexer actually pick up my new page?"
#   - "what's the agent going to see when it queries this KB?"
#   - demo screen-share: 30 seconds of "look, here's the corpus"
#
# Read-only. Uses the Search admin key from terraform output.

set -euo pipefail
cd "$(dirname "$0")/.."

SEARCH_EP="$(terraform output -raw detection_rules_search_endpoint 2>/dev/null || echo)"
SEARCH_NAME="$(echo "$SEARCH_EP" | sed 's|https://||' | sed 's|\.search\.windows\.net.*||')"
RG="$(terraform output -raw resource_group)"

if [[ -z "$SEARCH_EP" || -z "$SEARCH_NAME" || -z "$RG" ]]; then
  echo "ERROR: terraform outputs missing — run from terraform/2-deploy-aisoc/." >&2
  exit 2
fi

# Fetch the admin key (the seeder uses this; the inspect call needs
# data-plane read access too).
ADMIN_KEY="$(az search admin-key show \
  --resource-group "$RG" \
  --service-name "$SEARCH_NAME" \
  --query primaryKey -o tsv 2>/dev/null || echo "")"

if [[ -z "$ADMIN_KEY" ]]; then
  echo "ERROR: could not fetch Search admin key. Make sure you have"
  echo "       Search Service Contributor on $SEARCH_NAME (the deploy"
  echo "       script grants this to the deploying user)." >&2
  exit 3
fi

DP_API="2024-07-01"

# ---------------------------------------------------------------
# Pipeline-state diagnostics — runs BEFORE the index dumps so an
# operator hitting "0 docs" can see WHERE the pipeline broke
# without having to read 300 lines of empty output below.
# ---------------------------------------------------------------

DRK_STORAGE="$(terraform output -raw detection_rules_storage_account 2>/dev/null || echo)"
DRK_CONTAINER="$(terraform output -raw detection_rules_storage_container 2>/dev/null || echo)"
CCK_STORAGE="$(terraform output -raw company_context_storage_account 2>/dev/null || echo)"
CCK_CTX_CONTAINER="$(terraform output -raw company_context_storage_container 2>/dev/null || echo)"
CCK_POL_CONTAINER="$(terraform output -raw company_policies_storage_container 2>/dev/null || echo)"

count_blobs() {
  # count_blobs <storage-account> <container>
  local acct="$1" cont="$2"
  if [[ -z "$acct" || -z "$cont" ]]; then
    echo "n/a"
    return 0
  fi
  az storage blob list \
    --account-name "$acct" \
    --container-name "$cont" \
    --auth-mode login \
    --query 'length(@)' \
    -o tsv 2>/dev/null || echo "?"
}

indexer_status() {
  # indexer_status <indexer-name>
  local indexer="$1"
  curl -s -H "api-key: ${ADMIN_KEY}" \
    "${SEARCH_EP}/indexers/${indexer}/status?api-version=${DP_API}" \
    | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    last = d.get('lastResult') or {}
    print(f'{last.get(\"status\", \"never-run\"):<12}  '
          f'items={last.get(\"itemsProcessed\", 0):<5}  '
          f'failed={last.get(\"itemsFailed\", 0):<3}  '
          f'ended={(last.get(\"endTime\") or \"\")[:19]}')
    errors = last.get('errors') or []
    for e in errors[:3]:
        print(f'    ERROR: {(e.get(\"errorMessage\") or \"\")[:200]}')
except Exception as e:
    print(f'?  (parse failed: {e})')"
}

echo "================================================================"
echo "  Pipeline state — blobs uploaded vs indexer ran vs index count"
echo "================================================================"
printf "%-22s  %-10s  %-10s  %s\n" "Container" "Blobs" "Index docs" "Last indexer run"
echo "----------------------  ----------  ----------  ----------------------------------------"

# Run blob counts in parallel-ish — sequential is fine, each is <1s.
DRK_BLOBS=$(count_blobs "$DRK_STORAGE" "$DRK_CONTAINER")
CCK_CTX_BLOBS=$(count_blobs "$CCK_STORAGE" "$CCK_CTX_CONTAINER")
CCK_POL_BLOBS=$(count_blobs "$CCK_STORAGE" "$CCK_POL_CONTAINER")

count_index() {
  curl -s -H "api-key: ${ADMIN_KEY}" \
    "${SEARCH_EP}/indexes/$1/docs/\$count?api-version=${DP_API}" \
    | tr -d '\r\n﻿' | head -c 8 || echo "?"
}

printf "%-22s  %-10s  %-10s  %s\n" \
  "${DRK_CONTAINER:-detection-rules}" \
  "$DRK_BLOBS" \
  "$(count_index detection-rules-idx)" \
  "$(indexer_status detection-rules-indexer)"
printf "%-22s  %-10s  %-10s  %s\n" \
  "${CCK_CTX_CONTAINER:-company-context}" \
  "$CCK_CTX_BLOBS" \
  "$(count_index company-context-idx)" \
  "$(indexer_status company-context-indexer)"
printf "%-22s  %-10s  %-10s  %s\n" \
  "${CCK_POL_CONTAINER:-company-policies}" \
  "$CCK_POL_BLOBS" \
  "$(count_index company-policies-idx)" \
  "$(indexer_status company-policies-indexer)"

cat <<'EOF'

How to read this:
  Blobs=0           → upload step never ran (or failed). Run the
                      upload helpers:
                        cd terraform/2-deploy-aisoc/agents/company-context
                        ./upload_company_context.sh
                        cd ../company-policies
                        ./upload_company_policies.sh
                        cd ../..
                        ./scripts/refresh_sigma_corpus.sh
  Blobs>0 but Index docs=0 with last run "Succeeded items=0"
                    → indexer can't read the blobs (RBAC issue on
                      the search MI) or the file extensions are
                      filtered out. Check the indexer ERROR lines.
  Blobs>0 but Index docs=0 and no last run shown
                    → indexer hasn't run yet. Trigger it manually:
                        az search indexer run --service-name <svc> \
                          --name <indexer> --resource-group <rg>
                      OR re-run an upload helper (they auto-trigger).
  Blobs>>Index docs with last run "transientFailure" / failed>0
                    → indexer hit a per-document failure and bailed
                      under the maxFailedItems threshold. Drill in:
                        ./scripts/diagnose_indexer_errors.sh <indexer>
                      Then either fix the doc, raise INDEXER_MAX_FAILED,
                      or skip the file extension. After the fix:
                        ./scripts/reset_kb_indexers.sh
  Blobs>0, Index docs>0
                    → the pipeline is healthy.

EOF

dump_index() {
  # dump_index <index-name> <human-label>
  local idx="$1" label="$2"
  echo
  echo "================================================================"
  echo "  Index: ${idx}    (${label})"
  echo "================================================================"

  # Document count
  local count
  count="$(curl -s -H "api-key: ${ADMIN_KEY}" \
    "${SEARCH_EP}/indexes/${idx}/docs/\$count?api-version=${DP_API}" \
    | tr -d '\n' || echo "?")"
  echo "Document count: ${count}"
  echo

  # List all docs with name + first 200 chars of content
  echo "Documents:"
  curl -s -H "api-key: ${ADMIN_KEY}" \
    "${SEARCH_EP}/indexes/${idx}/docs?api-version=${DP_API}&\$select=metadata_storage_name,metadata_storage_last_modified,content&\$top=50" \
    | python3 -c "
import sys, json
data = json.load(sys.stdin)
for i, d in enumerate(data.get('value', []), 1):
    name = d.get('metadata_storage_name', '?')
    mod = d.get('metadata_storage_last_modified', '')[:19]
    content = (d.get('content') or '').strip().replace('\n', ' ')
    snippet = content[:160] + ('…' if len(content) > 160 else '')
    print(f'  {i}. {name}  [{mod}]')
    print(f'     {snippet}')
    print()
"
}

dump_index "company-context-idx"  "SOC-curated runbooks, naming, glossary, escalation, org chart"
dump_index "company-policies-idx" "HR/IT-curated AUP + asset inventory"
dump_index "detection-rules-idx"  "Sigma / KQL / writeups for the Detection Engineer"

# ---- A sample semantic query against company-context ---------------
#
# Demonstrates what an agent sees when it queries the KB. Uses the
# default semantic configuration we set up in seed_search_kb.sh.

cat <<EOF

================================================================
  Sample semantic query against company-context-idx
================================================================
Query: "who is the captain"
EOF

curl -s -H "api-key: ${ADMIN_KEY}" \
  -H "Content-Type: application/json" \
  -X POST \
  "${SEARCH_EP}/indexes/company-context-idx/docs/search?api-version=${DP_API}" \
  -d '{
    "search": "who is the captain",
    "queryType": "semantic",
    "semanticConfiguration": "default",
    "top": 3,
    "select": "metadata_storage_name,content"
  }' \
  | python3 -c "
import sys, json
data = json.load(sys.stdin)
hits = data.get('value', [])
if not hits:
    print('  (no results)')
else:
    for i, h in enumerate(hits, 1):
        name = h.get('metadata_storage_name', '?')
        score = h.get('@search.rerankerScore') or h.get('@search.score')
        content = (h.get('content') or '').strip().replace('\n', ' ')
        snippet = content[:200] + ('…' if len(content) > 200 else '')
        print(f'  Hit {i}  [{name}]  score={score}')
        print(f'    {snippet}')
        print()
"

echo
echo "Done. Foundry portal view: AI Foundry → company-context KB → Knowledge sources."
echo "Azure portal view:        Search service → Indexes → <name> → Search explorer."
