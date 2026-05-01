#!/usr/bin/env bash
# reset_kb_indexers.sh — clear the high-water-mark on all KB
# indexers and re-run them.
#
# Why this exists: Azure Search blob indexers track the
# `metadata_storage_last_modified` of the most recent blob they've
# processed. On the next run they only look at blobs newer than
# that watermark. If the indexer ran when the container was empty
# (or partially empty) — e.g. during a fresh terraform apply where
# the upload null_resource hadn't finished but the indexer trigger
# already fired — the watermark gets set in a way that skips
# subsequent blobs.
#
# Symptom: `inspect_kb_contents.sh` shows blobs > 0 but index docs
# = 0 with the indexer's last run reporting `success items=0`.
#
# Fix: POST /reset (clears watermark) + POST /run (triggers a
# from-scratch indexing pass). Idempotent — safe to run any time
# you want to force a full re-index, e.g. after editing the
# corpus.

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
  echo "ERROR: could not fetch Search admin key. Need Search Service" >&2
  echo "       Contributor on $SEARCH_NAME (the deploy grants this)." >&2
  exit 3
fi

DP_API="2024-07-01"

INDEXERS=(
  "detection-rules-indexer"
  "company-context-indexer"
  "company-policies-indexer"
)

reset_one() {
  local idx="$1"
  echo
  echo "── ${idx} ──"

  echo -n "  reset…  "
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST \
    -H "api-key: ${ADMIN_KEY}" \
    -H "Content-Length: 0" \
    "${SEARCH_EP}/indexers/${idx}/reset?api-version=${DP_API}" || echo 000)"
  case "$code" in
    20*|204) echo "ok (HTTP ${code})" ;;
    404)     echo "skip — indexer doesn't exist" ; return 0 ;;
    *)       echo "FAILED (HTTP ${code})" ; return 1 ;;
  esac

  echo -n "  run…    "
  code="$(curl -s -o /dev/null -w '%{http_code}' \
    -X POST \
    -H "api-key: ${ADMIN_KEY}" \
    -H "Content-Length: 0" \
    "${SEARCH_EP}/indexers/${idx}/run?api-version=${DP_API}" || echo 000)"
  case "$code" in
    20*|202|204) echo "ok (HTTP ${code})" ;;
    *)           echo "FAILED (HTTP ${code})" ; return 1 ;;
  esac
}

echo "Resetting + re-running KB indexers on ${SEARCH_NAME}…"
for idx in "${INDEXERS[@]}"; do
  reset_one "$idx" || true
done

cat <<'EOF'

Done. Indexers are now running from a cleared watermark.

  - company-context / company-policies: 30-60s to complete
  - detection-rules: 60-180s to complete (3000+ Sigma rules)

Re-run inspect_kb_contents.sh in ~90 seconds and the doc counts
should match the blob counts. If they still don't, check the
errors[] array on the indexer status — the inspect script prints
up to 3 of them.
EOF
