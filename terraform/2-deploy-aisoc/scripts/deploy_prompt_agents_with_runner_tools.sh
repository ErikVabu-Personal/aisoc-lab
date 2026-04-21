#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

export AZURE_AI_FOUNDRY_PROJECT_ENDPOINT="$(terraform output -raw foundry_project_endpoint)"
export AZURE_AI_MODEL_DEPLOYMENT="$(terraform output -raw foundry_model_deployment_name)"
export AISOC_RUNNER_URL="$(terraform output -raw runner_url)"

# Export deterministic identifiers so the Python script can build the portal-compatible
# project connection ARM id:
# /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.CognitiveServices/accounts/<hub>/projects/<proj>/connections/<name>
export AZURE_SUBSCRIPTION_ID="$(terraform output -raw subscription_id 2>/dev/null || az account show --query id -o tsv)"
export AZURE_RESOURCE_GROUP="$(terraform output -raw resource_group)"
export AZURE_FOUNDRY_HUB_NAME="$(terraform output -raw foundry_hub_name)"
export AZURE_FOUNDRY_PROJECT_NAME="$(terraform output -raw foundry_project_name)"

RG="$AZURE_RESOURCE_GROUP"
HUB="$AZURE_FOUNDRY_HUB_NAME"
PROJ="$AZURE_FOUNDRY_PROJECT_NAME"

KV_ID="$(terraform output -raw key_vault_id)"
KV_NAME="${KV_ID##*/}"
RUNNER_SECRET="$(terraform output -raw runner_bearer_token_secret_name)"
export AISOC_RUNNER_BEARER="$(az keyvault secret show --vault-name "$KV_NAME" --name "$RUNNER_SECRET" --query value -o tsv)"

# Ensure the project connection exists with the correct authType.
#
# Problem observed in some tenants/CLI versions:
# - `az cognitiveservices ... project connection create` can create a connection that reports
#   `properties.authType = AAD` even when using a CustomKeys payload.
# Foundry OpenAPI tools require a CustomKeys connection (`authType=CustomKeys`).
CONN_NAME="aisoc-runner-key"

conn_exists() {
  az cognitiveservices account project connection show \
    -g "$RG" -n "$HUB" --project-name "$PROJ" --connection-name "$CONN_NAME" >/dev/null 2>&1
}

conn_auth_type() {
  az cognitiveservices account project connection show \
    -g "$RG" -n "$HUB" --project-name "$PROJ" --connection-name "$CONN_NAME" \
    --query properties.authType -o tsv 2>/dev/null || true
}

conn_delete() {
  # This subcommand doesn't consistently support --yes across az versions.
  # Force-confirm and ignore errors (e.g., already deleted).
  printf 'y\n' | az cognitiveservices account project connection delete \
    -g "$RG" -n "$HUB" --project-name "$PROJ" --connection-name "$CONN_NAME" \
    >/dev/null 2>&1 || true
}

conn_create_via_cli() {
  local tmp_file
  tmp_file="/tmp/${CONN_NAME}.connection.json"
  # Write valid JSON to a file (az CLI accepts JSON/YAML here).
  cat >"$tmp_file" <<EOF
$1
EOF
  az cognitiveservices account project connection create \
    -g "$RG" \
    -n "$HUB" \
    --project-name "$PROJ" \
    --connection-name "$CONN_NAME" \
    --file "$tmp_file" \
    >/dev/null
}

conn_create_via_rest() {
  # ARM PUT to the connection resource id.
  local conn_id url token
  conn_id="/subscriptions/${AZURE_SUBSCRIPTION_ID}/resourceGroups/${RG}/providers/Microsoft.CognitiveServices/accounts/${HUB}/projects/${PROJ}/connections/${CONN_NAME}"
  url="https://management.azure.com${conn_id}?api-version=2025-06-01"
  token="$(az account get-access-token --resource https://management.azure.com/ -o tsv --query accessToken)"

  # Payload modelled after GUI-created connections:
  # - properties.authType/category CustomKeys
  # - metadata.type openapi
  # - target '-' (GUI uses '-')
  # NOTE: The RP requires `credentials` to be present for CustomKeys, even though
  # it is not returned on GET (secrets are redacted).
  az rest \
    --method put \
    --url "$url" \
    --headers "Authorization=Bearer $token" "Content-Type=application/json" \
    --body "{\"properties\":{\"authType\":\"CustomKeys\",\"category\":\"CustomKeys\",\"metadata\":{\"type\":\"openapi\"},\"target\":\"-\",\"credentials\":{\"keys\":{\"x-aisoc-runner-key\":\"${AISOC_RUNNER_BEARER}\"}}}}" \
    >/dev/null
}

ensure_conn() {
  if conn_exists; then
    local at
    at="$(conn_auth_type)"
    if [[ "$at" == "CustomKeys" ]]; then
      return 0
    fi
    echo "WARN: Foundry connection '$CONN_NAME' exists but authType='$at' (expected CustomKeys). Recreating..." >&2
    conn_delete
  fi

  echo "Creating Foundry project connection '$CONN_NAME' via az cognitiveservices..." >&2

  # Attempt 1: CLI payload (top-level fields)
  if conn_create_via_cli "{
  \"type\": \"CustomKeys\",
  \"displayName\": \"AISOC Runner Key\",
  \"target\": \"-\",
  \"metadata\": {\"type\": \"openapi\"},
  \"authType\": \"CustomKeys\",
  \"customKeys\": {
    \"x-aisoc-runner-key\": \"${AISOC_RUNNER_BEARER}\"
  }
}"; then
    local at
    at="$(conn_auth_type)"
    if [[ "$at" == "CustomKeys" ]]; then
      echo "OK: connection created with authType=CustomKeys" >&2
      return 0
    fi
    echo "WARN: CLI create produced authType='$at'. Retrying with alternate payload..." >&2
    conn_delete
  fi

  # Attempt 2: CLI payload (properties wrapper)
  if conn_create_via_cli "{
  \"properties\": {
    \"authType\": \"CustomKeys\",
    \"category\": \"CustomKeys\",
    \"metadata\": {\"type\": \"openapi\"},
    \"target\": \"-\",
    \"customKeys\": {
      \"x-aisoc-runner-key\": \"${AISOC_RUNNER_BEARER}\"
    }
  }
}"; then
    local at
    at="$(conn_auth_type)"
    if [[ "$at" == "CustomKeys" ]]; then
      echo "OK: connection created with authType=CustomKeys" >&2
      return 0
    fi
    echo "WARN: Alternate CLI create produced authType='$at'. Falling back to ARM PUT (az rest)..." >&2
    conn_delete
  fi

  echo "Creating Foundry project connection '$CONN_NAME' via az rest (ARM PUT)..." >&2
  conn_create_via_rest
  local at
  at="$(conn_auth_type)"
  if [[ "$at" != "CustomKeys" ]]; then
    echo "ERROR: connection created but authType='$at' (expected CustomKeys)." >&2
    echo "Inspect connection: az cognitiveservices account project connection show -g '$RG' -n '$HUB' --project-name '$PROJ' --connection-name '$CONN_NAME' -o json" >&2
    exit 5
  fi
  echo "OK: connection created with authType=CustomKeys" >&2
}

ensure_conn

python3 scripts/deploy_prompt_agents_with_runner_tools.py
