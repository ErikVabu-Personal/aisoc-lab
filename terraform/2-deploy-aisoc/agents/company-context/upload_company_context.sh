#!/usr/bin/env bash
# upload_company_context.sh — push the seed corpus into the
# company-context blob container.
#
# Run from this folder, after Phase 2 Terraform has applied. The
# storage account name is discovered from `terraform output`; the
# container name is fixed by the Terraform module (`company-context`).
#
# Usage:
#   ./upload_company_context.sh
#
# Requires: az CLI logged in with permission to write to the storage
# account (the operator's identity, not the indexer MI).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="${HERE}/../.."

cd "${TF_DIR}"

ACCOUNT="$(terraform output -raw company_context_storage_account 2>/dev/null || echo)"
CONTAINER="$(terraform output -raw company_context_storage_container 2>/dev/null || echo)"

if [[ -z "${ACCOUNT}" || -z "${CONTAINER}" ]]; then
  echo "ERROR: terraform outputs missing — is the company-context KB enabled?" >&2
  echo "       Check 'terraform output | grep company_context'" >&2
  exit 2
fi

echo "Storage account: ${ACCOUNT}"
echo "Container:       ${CONTAINER}"
echo "Source folder:   ${HERE}"
echo

# Upload every .md / .txt in the folder, skipping README + this script.
shopt -s nullglob
files=( "${HERE}"/*.md "${HERE}"/*.txt )
shopt -u nullglob

# Filter out the README + the script itself + anything that starts
# with a dot.
to_upload=()
for f in "${files[@]}"; do
  base="$(basename "${f}")"
  case "${base}" in
    README.md|.*) continue ;;
  esac
  to_upload+=( "${f}" )
done

if [[ ${#to_upload[@]} -eq 0 ]]; then
  echo "Nothing to upload — folder is empty (excluding README)."
  exit 0
fi

echo "Uploading ${#to_upload[@]} files…"
for f in "${to_upload[@]}"; do
  base="$(basename "${f}")"
  echo "  -> ${base}"
  az storage blob upload \
    --account-name "${ACCOUNT}" \
    --container-name "${CONTAINER}" \
    --name "${base}" \
    --file "${f}" \
    --overwrite \
    --auth-mode login \
    --only-show-errors
done

echo
echo "Triggering the Search indexer so the new blobs land in the"
echo "index immediately (rather than waiting up to 30 min)…"

SEARCH_EP="$(terraform output -raw company_context_search_endpoint 2>/dev/null \
  || terraform output -raw detection_rules_search_endpoint 2>/dev/null \
  || echo "")"
SEARCH_NAME="$(echo "$SEARCH_EP" | sed 's|https://||' | sed 's|\.search\.windows\.net.*||')"
RG="$(terraform output -raw resource_group)"

if [[ -n "$SEARCH_NAME" && -n "$RG" ]]; then
  # Reset clears the high-water-mark so the next run is a from-
  # scratch enumeration. Without reset, blobs uploaded "in time"
  # with the indexer's first run may fall on the wrong side of
  # the watermark and never get picked up — that's the failure
  # mode we hit on the May 2026 redeploy. Best-effort.
  ADMIN_KEY="$(az search admin-key show --resource-group "$RG" \
    --service-name "$SEARCH_NAME" --query primaryKey -o tsv 2>/dev/null || echo "")"
  if [[ -n "$ADMIN_KEY" ]]; then
    curl -s -o /dev/null -X POST \
      -H "api-key: ${ADMIN_KEY}" -H "Content-Length: 0" \
      "https://${SEARCH_NAME}.search.windows.net/indexers/company-context-indexer/reset?api-version=2024-07-01" \
      && echo "  reset (clear watermark) ok"
  fi
  az search indexer run \
    --service-name "$SEARCH_NAME" \
    --name company-context-indexer \
    --resource-group "$RG" \
    --only-show-errors \
    && echo "  ok — indexer running. Should land in the index within 30-60s." \
    || echo "  WARN: indexer trigger failed (the blobs are uploaded; the indexer will pick them up on its scheduled run)."
else
  echo "WARN: could not derive Search service name; skipping indexer trigger."
  echo "      To run manually: az search indexer run --service-name <svc> \\"
  echo "        --name company-context-indexer --resource-group <rg>"
fi

echo
echo "Done. Inspect the result with:"
echo "  ./scripts/inspect_kb_contents.sh"
