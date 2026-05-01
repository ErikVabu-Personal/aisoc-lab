#!/usr/bin/env bash
# upload_company_policies.sh — push the policies seed corpus into
# the company-policies blob container.
#
# Run from this folder, after Phase 2 Terraform has applied. Mirrors
# upload_company_context.sh in the sibling company-context folder.
#
# Usage:
#   ./upload_company_policies.sh
#
# Requires: az CLI logged in with permission to write to the storage
# account.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TF_DIR="${HERE}/../.."

cd "${TF_DIR}"

ACCOUNT="$(terraform output -raw company_context_storage_account 2>/dev/null || echo)"
CONTAINER="$(terraform output -raw company_policies_storage_container 2>/dev/null || echo)"

if [[ -z "${ACCOUNT}" || -z "${CONTAINER}" ]]; then
  echo "ERROR: terraform outputs missing — is the company-context KB enabled?" >&2
  echo "       Check 'terraform output | grep company_'" >&2
  exit 2
fi

echo "Storage account: ${ACCOUNT}"
echo "Container:       ${CONTAINER}"
echo "Source folder:   ${HERE}"
echo

shopt -s nullglob
files=( "${HERE}"/*.md "${HERE}"/*.txt )
shopt -u nullglob

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
echo "Done. The Search indexer (company-policies-indexer) picks up"
echo "new blobs every 30 minutes."
