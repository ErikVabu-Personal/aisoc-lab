#!/usr/bin/env bash
set -euo pipefail

# Deploy AISOC Orchestrator Function code.
# Preferred: trigger GitHub Actions workflow.
# Fallback: local zip deploy.

here="$(cd "$(dirname "${BASH_SOURCE[0]}" )" && pwd)"
root="$(cd "$here/.." && pwd)"
cd "$root"

RG="$(terraform output -raw resource_group)"
FUNC_APP="$(terraform output -raw orchestrator_function_name)"

if [[ -z "$RG" || "$RG" == "null" ]]; then
  echo "ERROR: terraform output resource_group is empty" >&2
  exit 2
fi

if [[ -z "$FUNC_APP" || "$FUNC_APP" == "null" ]]; then
  echo "ERROR: terraform output orchestrator_function_name is empty (apply terraform first)" >&2
  exit 3
fi

WORKFLOW_NAME="Deploy AISOC Orchestrator Function"

if command -v gh >/dev/null 2>&1; then
  echo "Triggering GitHub Actions workflow '$WORKFLOW_NAME'..." >&2
  if gh auth status >/dev/null 2>&1; then
    gh workflow run "$WORKFLOW_NAME" \
      -f function_app_name="$FUNC_APP" \
      -f resource_group="$RG" \
      >/dev/null

    echo "OK: workflow dispatched." >&2
    echo "Monitor: gh run list --workflow \"$WORKFLOW_NAME\" --limit 3" >&2
    exit 0
  else
    echo "WARN: gh installed but not authenticated; falling back to local deploy." >&2
  fi
fi

# Fallback local deploy
FUNC_DIR="$root/orchestrator/function_app"
zip_path="/tmp/aisoc-orchestrator-function_app.zip"
rm -f "$zip_path"
(
  cd "$FUNC_DIR"
  zip -qr "$zip_path" .
)

echo "Deploying orchestrator function package locally to Function App: $FUNC_APP (RG: $RG)" >&2
az functionapp deployment source config-zip \
  -g "$RG" \
  -n "$FUNC_APP" \
  --src "$zip_path" \
  >/dev/null

echo "OK: deployed AISOC orchestrator code." >&2
