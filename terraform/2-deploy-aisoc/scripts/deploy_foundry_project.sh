#!/usr/bin/env bash
set -euo pipefail

# Deploy (create/confirm) the Azure AI Foundry Project under the already-provisioned Hub.
#
# We intentionally create the project via script (not Terraform) because AzAPI can intermittently fail
# reading the project resource identity after creation.

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
cd "$root"

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 not found" >&2
  exit 2
fi

echo "Deploying Foundry project via scripts/legacy/deploy_foundry_project.py ..." >&2
python3 scripts/legacy/deploy_foundry_project.py "$@"

echo "OK: Foundry project deploy script completed." >&2
