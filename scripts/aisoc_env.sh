#!/usr/bin/env bash
set -euo pipefail

# Print shell exports for AISOC demo environment variables.
# Usage:
#   eval "$(./scripts/aisoc_env.sh)"
#
# Requirements:
# - Azure CLI logged in to the subscription
# - Terraform state present for phase 1 and phase 2 (local backend)

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

PHASE1_DIR="$ROOT_DIR/terraform/1-deploy-sentinel"
PHASE2_DIR="$ROOT_DIR/terraform/2-deploy-aisoc"

RG="$(terraform -chdir="$PHASE1_DIR" output -raw resource_group 2>/dev/null || echo "rg-sentinel-test")"
FUNCAPP="$(terraform -chdir="$PHASE2_DIR" output -raw soc_gateway_function_name)"
KV_URI="$(terraform -chdir="$PHASE2_DIR" output -raw key_vault_uri)"
READ_SECRET_NAME="$(terraform -chdir="$PHASE2_DIR" output -raw aisoc_read_key_secret_name)"

# Fetch AISOC read key from Key Vault
AISOC_READ_KEY="$(az keyvault secret show --id "${KV_URI}secrets/${READ_SECRET_NAME}" --query value -o tsv)"

# Fetch Azure Functions function key for SOCGateway
AISOC_FUNCTION_CODE="$(az functionapp function keys list -g "$RG" -n "$FUNCAPP" --function-name SOCGateway --query "default" -o tsv 2>/dev/null || true)"

# Fallback: if the function doesn't have a 'default' key name, just take the first key value
if [[ -z "$AISOC_FUNCTION_CODE" || "$AISOC_FUNCTION_CODE" == "null" ]]; then
  AISOC_FUNCTION_CODE="$(az functionapp function keys list -g "$RG" -n "$FUNCAPP" --function-name SOCGateway -o json | python3 -c 'import json,sys; d=json.load(sys.stdin); print(next(iter(d.values())))')"
fi

AISOC_GATEWAY_BASE_URL="https://${FUNCAPP}.azurewebsites.net/api"

cat <<EOF
export AISOC_GATEWAY_BASE_URL="${AISOC_GATEWAY_BASE_URL}"
export AISOC_FUNCTION_CODE="${AISOC_FUNCTION_CODE}"
export AISOC_READ_KEY="${AISOC_READ_KEY}"
WRITE_SECRET_NAME="$(terraform -chdir="$PHASE2_DIR" output -raw aisoc_write_key_secret_name)"
AISOC_WRITE_KEY="$(az keyvault secret show --id "${KV_URI}secrets/${WRITE_SECRET_NAME}" --query value -o tsv)"

cat <<EOF
export AISOC_GATEWAY_BASE_URL="${AISOC_GATEWAY_BASE_URL}"
export AISOC_FUNCTION_CODE="${AISOC_FUNCTION_CODE}"
export AISOC_READ_KEY="${AISOC_READ_KEY}"
export AISOC_WRITE_KEY="${AISOC_WRITE_KEY}"
EOF
