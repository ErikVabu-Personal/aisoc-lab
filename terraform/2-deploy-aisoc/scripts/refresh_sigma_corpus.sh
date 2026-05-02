#!/usr/bin/env bash
# refresh_sigma_corpus.sh — fetch the SigmaHQ/sigma rule library and
# upload it into the detection-rules blob container, then trigger
# the Search indexer.
#
# The Detection Engineer agent uses the Sigma rules as INPUT /
# INSPIRATION when proposing new analytic rules. The rules are
# vendor-neutral (logsource + detection-syntax YAML), so the agent
# still has to translate the relevant ones into Sentinel KQL — but
# it gets to start from a curated, MITRE-mapped catalogue rather
# than its training-data approximation of one.
#
# Runs at three triggers:
#   - terraform apply (post-deploy, via null_resource.drk_sigma_corpus)
#     so the KB is populated immediately on first deploy.
#   - GitHub Actions daily cron
#     (.github/workflows/refresh-detection-rules.yml) so the
#     corpus stays current as SigmaHQ adds rules upstream.
#   - Manual operator run (e.g. before a demo)
#     ./scripts/refresh_sigma_corpus.sh
#
# Inputs (all auto-detected from terraform output when run from
# terraform/2-deploy-aisoc/, or via env vars when run from CI):
#
#   AISOC_DETECTION_RULES_STORAGE_ACCOUNT — blob target account
#   AISOC_DETECTION_RULES_STORAGE_CONTAINER — container ('detection-rules')
#   AISOC_DETECTION_RULES_SEARCH_SERVICE — Search service name
#   AISOC_RESOURCE_GROUP — RG holding both
#
# Idempotency: --overwrite on every blob upload, indexer trigger
# always re-runs (it picks up changed blobs since last run).

set -euo pipefail

# When run interactively from terraform/2-deploy-aisoc/, derive the
# inputs from `terraform output`. When run from CI / a null_resource
# environment block, expect them as env vars.
ACCOUNT="${AISOC_DETECTION_RULES_STORAGE_ACCOUNT:-}"
CONTAINER="${AISOC_DETECTION_RULES_STORAGE_CONTAINER:-}"
SEARCH_NAME="${AISOC_DETECTION_RULES_SEARCH_SERVICE:-}"
RG="${AISOC_RESOURCE_GROUP:-}"

if [[ -z "$ACCOUNT" || -z "$CONTAINER" || -z "$SEARCH_NAME" || -z "$RG" ]]; then
  HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  cd "${HERE}/.."
  ACCOUNT="${ACCOUNT:-$(terraform output -raw detection_rules_storage_account 2>/dev/null || echo "")}"
  CONTAINER="${CONTAINER:-$(terraform output -raw detection_rules_storage_container 2>/dev/null || echo "")}"
  SEARCH_EP="$(terraform output -raw detection_rules_search_endpoint 2>/dev/null || echo "")"
  SEARCH_NAME="${SEARCH_NAME:-$(echo "$SEARCH_EP" | sed 's|https://||' | sed 's|\.search\.windows\.net.*||')}"
  RG="${RG:-$(terraform output -raw resource_group 2>/dev/null || echo "")}"
fi

if [[ -z "$ACCOUNT" || -z "$CONTAINER" || -z "$SEARCH_NAME" || -z "$RG" ]]; then
  echo "ERROR: missing inputs. Need AISOC_DETECTION_RULES_STORAGE_ACCOUNT, _CONTAINER, _SEARCH_SERVICE, AISOC_RESOURCE_GROUP." >&2
  exit 2
fi

echo "Sigma corpus refresh starting"
echo "  storage account:  ${ACCOUNT}"
echo "  container:        ${CONTAINER}"
echo "  search service:   ${SEARCH_NAME}"
echo "  resource group:   ${RG}"

# Sparse-clone SigmaHQ — we only need the rule directories, not the
# tooling / docs / tests. --filter=blob:none + sparse-checkout keeps
# the clone <30 MB instead of pulling the whole 700+ MB history.
TMPDIR="$(mktemp -d)"
trap "rm -rf '$TMPDIR'" EXIT

echo
echo "Cloning SigmaHQ/sigma (sparse: rules/ + rules-emerging-threats/ + rules-threat-hunting/)…"
git clone --depth 1 --filter=blob:none --sparse \
  https://github.com/SigmaHQ/sigma.git "$TMPDIR/sigma" >/dev/null 2>&1

cd "$TMPDIR/sigma"
git sparse-checkout set rules rules-emerging-threats rules-threat-hunting >/dev/null 2>&1

# Quick stats so the operator + the CI logs can see what's flowing.
for dir in rules rules-emerging-threats rules-threat-hunting; do
  if [[ -d "$dir" ]]; then
    count=$(find "$dir" -name '*.yml' -type f | wc -l)
    echo "  ${dir}: ${count} rules"
  fi
done

# Upload to blob in batches per directory. upload-batch is much
# faster than per-file upload (parallelises). The destination-path
# preserves the directory hierarchy so a search hit's metadata_storage_name
# tells you which Sigma category the rule belongs to.
upload_dir() {
  local src="$1"
  local prefix="$2"
  if [[ ! -d "$src" ]]; then
    echo "  skip ${src} (not present)"
    return 0
  fi
  echo "Uploading ${src} → ${CONTAINER}/${prefix}/…"
  az storage blob upload-batch \
    --destination "$CONTAINER" \
    --destination-path "$prefix" \
    --account-name "$ACCOUNT" \
    --source "$src" \
    --pattern "*.yml" \
    --auth-mode login \
    --overwrite \
    --only-show-errors
}

echo
upload_dir "rules"                  "sigma/rules"
upload_dir "rules-emerging-threats" "sigma/rules-emerging-threats"
upload_dir "rules-threat-hunting"   "sigma/rules-threat-hunting"

# Trigger the Search indexer so the new blobs are searchable now,
# rather than waiting up to 30 min for the scheduled run.
echo
echo "Resetting + triggering detection-rules-indexer (clears the high-"
echo "water-mark so a from-scratch indexing pass picks up everything)…"
ADMIN_KEY="$(az search admin-key show \
    --resource-group "$RG" \
    --service-name "$SEARCH_NAME" \
    --query primaryKey -o tsv 2>/dev/null || echo "")"
if [[ -n "$ADMIN_KEY" ]]; then
  curl -s -o /dev/null -X POST \
    -H "api-key: ${ADMIN_KEY}" -H "Content-Length: 0" \
    "https://${SEARCH_NAME}.search.windows.net/indexers/detection-rules-indexer/reset?api-version=2024-07-01" \
    && echo "  reset ok"
  # Trigger run via the data-plane REST API (no `az search`
  # extension dependency).
  code="$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    -H "api-key: ${ADMIN_KEY}" -H "Content-Length: 0" \
    "https://${SEARCH_NAME}.search.windows.net/indexers/detection-rules-indexer/run?api-version=2024-07-01")"
  case "$code" in
    20*|202|204) echo "  ok — indexer running (HTTP $code)." ;;
    *)           echo "  WARN: indexer trigger returned HTTP $code; the scheduled run will pick up the new blobs." ;;
  esac
else
  echo "  WARN: could not fetch Search admin key. Indexer trigger skipped; the scheduled run will pick up the new blobs."
fi

echo
echo "Done. Inspect the result with:"
echo "  ./scripts/inspect_kb_contents.sh"
