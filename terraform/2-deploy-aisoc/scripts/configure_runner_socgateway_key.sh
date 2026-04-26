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

# Allow callers (CI workflows, Terraform null_resource) to pass values
# via env vars. Fall back to `terraform output` so the script still works
# as a standalone local-dev convenience.
RG="${RG:-}"
FUNC_APP="${FUNC_APP:-}"
RUNNER_NAME="${RUNNER_NAME:-}"

if [[ -z "$RG" || "$RG" == "null" ]]; then
  RG="$(terraform output -raw resource_group 2>/dev/null || true)"
fi
if [[ -z "$FUNC_APP" || "$FUNC_APP" == "null" ]]; then
  FUNC_APP="$(terraform output -raw soc_gateway_function_name 2>/dev/null || true)"
fi
if [[ -z "$RUNNER_NAME" || "$RUNNER_NAME" == "null" ]]; then
  RUNNER_NAME="$(terraform output -raw runner_name 2>/dev/null || true)"
fi

if [[ -z "$RG" || "$RG" == "null" ]]; then
  echo "ERROR: resource_group not set (pass RG env var or run terraform output)" >&2
  exit 2
fi
if [[ -z "$FUNC_APP" || "$FUNC_APP" == "null" ]]; then
  echo "ERROR: soc_gateway_function_name not set (pass FUNC_APP env var or run terraform output)" >&2
  exit 3
fi
if [[ -z "$RUNNER_NAME" || "$RUNNER_NAME" == "null" ]]; then
  echo "ERROR: runner_name not set (pass RUNNER_NAME env var or run terraform output)" >&2
  exit 4
fi

# Try to fetch the function key for SOCGateway.
# CLI command shapes can vary across versions; prefer function-level key.
KEY=""

if az functionapp function keys list --help >/dev/null 2>&1; then
  KEY="$(az functionapp function keys list \
    -g "$RG" \
    -n "$FUNC_APP" \
    --function-name SOCGateway \
    --query default -o tsv 2>/dev/null || true)"
fi

# Fallback: host key (runner works with host keys too)
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
  --secrets "socgateway-function-code=$KEY" \
  >/dev/null

az containerapp update \
  -g "$RG" \
  -n "$RUNNER_NAME" \
  --set-env-vars SOCGATEWAY_FUNCTION_CODE=secretref:socgateway-function-code \
  >/dev/null

# Some az versions don't support `az containerapp restart`. To ensure the new secret
# is picked up, force a new revision by setting a harmless env var.
RESTART_TS="$(date +%s)"
az containerapp update \
  -g "$RG" \
  -n "$RUNNER_NAME" \
  --set-env-vars RESTART_TS="$RESTART_TS" \
  >/dev/null

# Wait until the new revision is serving and the env var is visible.
# Best-effort: if terraform state is unavailable (e.g. in CI), skip verify.
RUNNER_URL="${RUNNER_URL:-}"
RUNNER_BEARER_SECRET="${RUNNER_BEARER_SECRET:-}"
KV_NAME="${KV_NAME:-}"

if [[ -z "$RUNNER_URL" ]]; then
  RUNNER_URL="$(terraform output -raw runner_url 2>/dev/null || true)"
fi
if [[ -z "$RUNNER_BEARER_SECRET" ]]; then
  RUNNER_BEARER_SECRET="$(terraform output -raw runner_bearer_token_secret_name 2>/dev/null || true)"
fi
if [[ -z "$KV_NAME" ]]; then
  KV_NAME="$(terraform output -raw key_vault_name 2>/dev/null || true)"
fi

RUNNER_BEARER=""
if [[ -n "$KV_NAME" && -n "$RUNNER_BEARER_SECRET" ]]; then
  RUNNER_BEARER="$(az keyvault secret show --vault-name "$KV_NAME" --name "$RUNNER_BEARER_SECRET" --query value -o tsv 2>/dev/null || true)"
fi

if [[ -n "$RUNNER_BEARER" && -n "$RUNNER_URL" ]]; then
  echo "Waiting for runner to pick up SOCGATEWAY_FUNCTION_CODE..." >&2
  deadline=$(( $(date +%s) + 120 ))
  while [[ $(date +%s) -lt $deadline ]]; do
    cfg="$(curl -sS "$RUNNER_URL/debug/config" -H "x-aisoc-runner-key: $RUNNER_BEARER" 2>/dev/null || true)"
    if echo "$cfg" | grep -q '"socgateway_function_code_set":true'; then
      echo "OK: runner is updated." >&2
      echo "OK: runner configured with SOCGateway function code." >&2
      exit 0
    fi
    sleep 3
  done
  echo "WARN: timed out waiting for runner config to reflect the new function code. It may still converge shortly." >&2
else
  echo "WARN: could not fetch runner bearer from Key Vault to verify rollout; skipping wait." >&2
fi

echo "OK: runner configured with SOCGateway function code (new revision triggered)." >&2
