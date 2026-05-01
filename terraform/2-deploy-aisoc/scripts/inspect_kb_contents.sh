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
