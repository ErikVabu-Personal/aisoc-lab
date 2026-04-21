#!/usr/bin/env bash
set -euo pipefail

# Deploy the SOCGateway Azure Function code for Phase 2.
#
# Preferred path: trigger the existing GitHub Actions workflow that builds a Linux-ready
# zip package including vendored dependencies under .python_packages/.
# Fallback path: local zip deploy (useful if gh is unavailable).
#
# Prereqs (preferred path):
# - gh CLI authenticated to GitHub
# - workflow exists: .github/workflows/deploy-soc-gateway.yml
#
# Prereqs (fallback path):
# - az login
# - zip installed
#
# Always:
# - terraform apply completed in terraform/2-deploy-aisoc

here="$(cd "$(dirname "${BASH_SOURCE[0]}" )" && pwd)"
root="$(cd "$here/.." && pwd)"
cd "$root"

RG="$(terraform output -raw resource_group)"
FUNC_APP="$(terraform output -raw soc_gateway_function_name)"

if [[ -z "$RG" || "$RG" == "null" ]]; then
  echo "ERROR: terraform output resource_group is empty" >&2
  exit 2
fi

if [[ -z "$FUNC_APP" || "$FUNC_APP" == "null" ]]; then
  echo "ERROR: terraform output soc_gateway_function_name is empty" >&2
  exit 3
fi

WORKFLOW_NAME="Deploy SOC Gateway Function"

if command -v gh >/dev/null 2>&1; then
  echo "Triggering GitHub Actions workflow '$WORKFLOW_NAME' to deploy SOCGateway..." >&2

  # Verify auth early (gives a clear error instead of failing later)
  if ! gh auth status >/dev/null 2>&1; then
    echo "WARN: gh is installed but not authenticated. Falling back to local zip deploy." >&2
  else
    gh workflow run "$WORKFLOW_NAME" \
      -f function_app_name="$FUNC_APP" \
      -f resource_group="$RG" \
      >/dev/null

    echo "OK: workflow dispatched." >&2
    echo "Monitor it here:" >&2
    echo "  gh run list --workflow \"$WORKFLOW_NAME\" --limit 3" >&2
    echo "Or in the GitHub UI: Actions -> $WORKFLOW_NAME" >&2
    exit 0
  fi
fi

# -----------------
# Fallback: local zip deploy
# -----------------
FUNC_DIR="$root/foundry/function_app"
if [[ ! -f "$FUNC_DIR/host.json" ]]; then
  echo "ERROR: expected Function App source at $FUNC_DIR (missing host.json)" >&2
  exit 4
fi

zip_path="/tmp/socgateway-function_app.zip"
rm -f "$zip_path"

(
  cd "$FUNC_DIR"
  zip -qr "$zip_path" .
)

echo "Deploying SOCGateway function package locally to Function App: $FUNC_APP (RG: $RG)" >&2
az functionapp deployment source config-zip \
  -g "$RG" \
  -n "$FUNC_APP" \
  --src "$zip_path" \
  >/dev/null

echo "OK: deployed SOCGateway code." >&2

echo "Next: retrieve a function key and set it on the runner:" >&2
echo "- Function App -> Functions -> SOCGateway -> Function Keys" >&2
echo "- Set SOCGATEWAY_FUNCTION_CODE as a Container App secret/env var" >&2
