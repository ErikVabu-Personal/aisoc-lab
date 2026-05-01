#!/usr/bin/env bash
# diagnose_indexer_errors.sh — print the full errors[] / warnings[]
# array from an indexer's last execution status. Useful when
# inspect_kb_contents.sh shows itemsFailed > 0 and you need to know
# WHICH document broke and WHY before deciding the fix.
#
# Usage:
#   ./diagnose_indexer_errors.sh                  # all 3 KB indexers
#   ./diagnose_indexer_errors.sh detection-rules-indexer  # one indexer

set -euo pipefail
cd "$(dirname "$0")/.."

SEARCH_EP="$(terraform output -raw detection_rules_search_endpoint 2>/dev/null || echo)"
SEARCH_NAME="$(echo "$SEARCH_EP" | sed 's|https://||' | sed 's|\.search\.windows\.net.*||')"
RG="$(terraform output -raw resource_group)"

if [[ -z "$SEARCH_EP" || -z "$RG" || -z "$SEARCH_NAME" ]]; then
  echo "ERROR: terraform outputs missing — run from terraform/2-deploy-aisoc/." >&2
  exit 2
fi

ADMIN_KEY="$(az search admin-key show \
  --resource-group "$RG" \
  --service-name "$SEARCH_NAME" \
  --query primaryKey -o tsv 2>/dev/null || echo "")"

if [[ -z "$ADMIN_KEY" ]]; then
  echo "ERROR: could not fetch Search admin key." >&2
  exit 3
fi

DP_API="2024-07-01"

if [[ $# -ge 1 ]]; then
  INDEXERS=( "$1" )
else
  INDEXERS=(
    "detection-rules-indexer"
    "company-context-indexer"
    "company-policies-indexer"
  )
fi

for idx in "${INDEXERS[@]}"; do
  echo
  echo "================================================================"
  echo "  Indexer: ${idx}"
  echo "================================================================"

  curl -s -H "api-key: ${ADMIN_KEY}" \
    "${SEARCH_EP}/indexers/${idx}/status?api-version=${DP_API}" \
    | python3 -c "
import sys, json
d = json.load(sys.stdin)
last = d.get('lastResult') or {}
print(f\"status: {last.get('status', 'never-run')}\")
print(f\"items processed: {last.get('itemsProcessed', 0)}\")
print(f\"items failed:    {last.get('itemsFailed', 0)}\")
print(f\"start: {last.get('startTime', '')[:19]}\")
print(f\"end:   {last.get('endTime', '')[:19]}\")
errors = last.get('errors') or []
warnings = last.get('warnings') or []
if errors:
    print()
    print(f'ERRORS ({len(errors)}):')
    for e in errors:
        print(f\"  key:           {e.get('key', '')}\")
        print(f\"  name:          {e.get('name', '')}\")
        print(f\"  errorMessage:  {e.get('errorMessage', '')}\")
        print(f\"  statusCode:    {e.get('statusCode', '')}\")
        print(f\"  details:       {e.get('details', '')}\")
        print(f\"  documentationLink: {e.get('documentationLink', '')}\")
        print()
if warnings:
    print(f'WARNINGS ({len(warnings)} — showing up to 10):')
    for w in warnings[:10]:
        print(f\"  key:           {w.get('key', '')}\")
        print(f\"  name:          {w.get('name', '')}\")
        print(f\"  message:       {w.get('message', '')}\")
        print(f\"  details:       {w.get('details', '')}\")
        print()
if not errors and not warnings:
    print()
    print('(no errors or warnings)')
"
done
