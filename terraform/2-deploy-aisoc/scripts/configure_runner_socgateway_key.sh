#!/usr/bin/env bash
set -euo pipefail

# Configure AISOC Runner with SOCGateway Function key.
#
# What it does:
# - Fetches the SOCGateway function key (code=...) from the Azure Function App
# - Stores it as a Container App secret
# - Sets SOCGATEWAY_FUNCTION_CODE env var to secretref:...
#
# Prereqs:
# - az login
# - terraform apply completed in terraform/2-deploy-aisoc

here="$(cd "$(dirname "${BASH_SOURCE[0]}" )" && pwd)"
root="$(cd "$here/.." && pwd)"
cd "$root"

RG="$(terraform output -raw resource_group)"
FUNC_APP="$(terraform output -raw soc_gateway_function_name)"
RUNNER_NAME="$(terraform output -raw runner_name)"

if [[ -z "$RG" || "$RG" == "null" ]]; then
  echo "ERROR: terraform output resource_group is empty" >&2
  exit 2
fi
if [[ -z "$FUNC_APP" || "$FUNC_APP" == "null" ]]; then
  echo "ERROR: terraform output soc_gateway_function_name is empty" >&2
  exit 3
fi
if [[ -z "$RUNNER_NAME" || "$RUNNER_NAME" == "null" ]]; then
  echo "ERROR: terraform output runner_name is empty" >&2
  exit 4
fi

# Try to fetch the function key for SOCGateway.
# CLI command shapes can vary across versions; we try a couple approaches.
KEY=""

if az functionapp function keys list --help >/dev/null 2>&1; then
  KEY="$(az functionapp function keys list \
    -g "$RG" \
    -n "$FUNC_APP" \
    --function-name SOCGateway \
    --query default -o tsv 2>/dev/null || true)"
fi

# Fallback: some setups expose only host keys in CLI; runner typically works with host keys too.
if [[ -z "$KEY" || "$KEY" == "null" ]]; then
  KEY="$(az functionapp keys list \
    -g "$RG" \
    -n "$FUNC_APP" \
    --query functionKeys.default -o tsv 2>/dev/null || true)"
fi

if [[ -z "$KEY" || "$KEY" == "null" ]]; then
  echo "ERROR: Could not retrieve SOCGateway function/host key via az CLI." >&2
  echo "Try in Portal: Function App -> Functions -> SOCGateway -> Function Keys" >&2
  exit 5
fi

echo "Setting SOCGATEWAY_FUNCTION_CODE on runner $RUNNER_NAME (RG: $RG)" >&2

az containerapp secret set \
  -g "$RG" \
  -n "$RUNNER_NAME" \
  --secrets socgateway-function-code="$KEY" \
  >/dev/null

az containerapp update \
  -g "$RG" \
  -n "$RUNNER_NAME" \
  --set-env-vars SOCGATEWAY_FUNCTION_CODE=secretref:socgateway-function-code \
  >/dev/null

echo "OK: runner configured with SOCGateway function code." >&2
