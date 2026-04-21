#!/usr/bin/env bash
set -euo pipefail

# Deploy the SOCGateway Azure Function code for Phase 2.
#
# Why this exists:
# - Terraform provisions the Function App infrastructure, but does not publish code.
# - Runner requires SOCGATEWAY_FUNCTION_CODE (function key) to call the gateway.
#
# Prereqs:
# - az login
# - terraform apply completed in terraform/2-deploy-aisoc

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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

FUNC_DIR="$root/foundry/function_app"
if [[ ! -f "$FUNC_DIR/host.json" ]]; then
  echo "ERROR: expected Function App source at $FUNC_DIR (missing host.json)" >&2
  exit 4
fi

zip_path="/tmp/socgateway-function_app.zip"
rm -f "$zip_path"

# Zip from within the function_app folder so host.json is at the archive root.
(
  cd "$FUNC_DIR"
  zip -qr "$zip_path" .
)

echo "Deploying SOCGateway function package to Function App: $FUNC_APP (RG: $RG)" >&2
az functionapp deployment source config-zip \
  -g "$RG" \
  -n "$FUNC_APP" \
  --src "$zip_path" \
  >/dev/null

echo "OK: deployed SOCGateway code." >&2

echo "Next: retrieve a function key and set it on the runner:" >&2
echo "- Function App -> Functions -> SOCGateway -> Function Keys" >&2
echo "- Set SOCGATEWAY_FUNCTION_CODE as a Container App secret/env var" >&2
