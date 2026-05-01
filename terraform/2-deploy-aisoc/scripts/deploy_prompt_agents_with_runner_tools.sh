#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
cd "$root"

# Project endpoint is discovered after project creation (we create the project via script, not Terraform).
# Prefer env var if set, else fall back to scripts/deploy_foundry_project.py to read it.
if [[ -n "${AZURE_AI_FOUNDRY_PROJECT_ENDPOINT:-}" ]]; then
  export AZURE_AI_FOUNDRY_PROJECT_ENDPOINT
else
  # Attempt to read from terraform output if present (legacy), otherwise query the project resource.
  export AZURE_AI_FOUNDRY_PROJECT_ENDPOINT="$(terraform output -raw foundry_project_endpoint 2>/dev/null || true)"
  if [[ -z "${AZURE_AI_FOUNDRY_PROJECT_ENDPOINT:-}" || "${AZURE_AI_FOUNDRY_PROJECT_ENDPOINT}" == "null" ]]; then
    if command -v python3 >/dev/null 2>&1; then
      # This script prints the project id when ready; we also need endpoints.
      # Query the project resource via ARM to extract the AI Foundry API endpoint.
      hub_id="$(terraform output -raw foundry_account_id)"
      proj_name="$(terraform output -raw foundry_project_name)"
      api_ver="$(terraform output -raw foundry_api_version 2>/dev/null || echo 2025-06-01)"
      proj_url="https://management.azure.com${hub_id}/projects/${proj_name}?api-version=${api_ver}"
      token="$(az account get-access-token --resource https://management.azure.com/ -o tsv --query accessToken)"
      AZURE_AI_FOUNDRY_PROJECT_ENDPOINT="$(curl -sS -H "Authorization: Bearer ${token}" "${proj_url}" | python3 -c 'import sys,json; j=json.load(sys.stdin); print((j.get("properties",{}).get("endpoints",{}) or {}).get("AI Foundry API") or "")')"
      export AZURE_AI_FOUNDRY_PROJECT_ENDPOINT
    fi
  fi
fi

if [[ -z "${AZURE_AI_FOUNDRY_PROJECT_ENDPOINT:-}" ]]; then
  echo "ERROR: AZURE_AI_FOUNDRY_PROJECT_ENDPOINT is empty. Run ./scripts/deploy_foundry_project.sh first." >&2
  exit 2
fi
export AZURE_AI_MODEL_DEPLOYMENT="$(terraform output -raw foundry_model_deployment_name)"
export AISOC_RUNNER_URL="$(terraform output -raw runner_url)"

# Export deterministic identifiers so the Python script can build the portal-compatible
# project connection ARM id:
# /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.CognitiveServices/accounts/<hub>/projects/<proj>/connections/<name>
export AZURE_SUBSCRIPTION_ID="$(terraform output -raw subscription_id 2>/dev/null || az account show --query id -o tsv)"
export AZURE_RESOURCE_GROUP="$(terraform output -raw resource_group)"
export AZURE_FOUNDRY_HUB_NAME="$(terraform output -raw foundry_hub_name)"
export AZURE_FOUNDRY_PROJECT_NAME="$(terraform output -raw foundry_project_name)"

# Detection Rules knowledge base wiring (optional). Empty values
# trigger the Python script to skip the MCP-tool attach for the
# Detection Engineer agent — the rest of the deploy works unchanged.
export AISOC_DETECTION_RULES_KB_ENABLED="$(terraform output -raw detection_rules_kb_enabled 2>/dev/null || echo false)"
export AISOC_DETECTION_RULES_KB_SEARCH_ENDPOINT="$(terraform output -raw detection_rules_search_endpoint 2>/dev/null || echo)"
export AISOC_DETECTION_RULES_KB_NAME="$(terraform output -raw detection_rules_kb_name 2>/dev/null || echo)"
export AISOC_DETECTION_RULES_KB_PROJECT_CONNECTION="$(terraform output -raw detection_rules_project_connection_name 2>/dev/null || echo)"

# Bing Grounding wiring (optional). When enabled, Phase 2 Terraform
# provisioned the Microsoft.Bing/accounts resource and exposed the
# name + API key here. The Python script uses them to lazily create
# the Foundry project connection and attach bing_grounding to the
# Threat Intel agent.
export AISOC_BING_GROUNDING_ENABLED="$(terraform output -raw bing_grounding_enabled 2>/dev/null || echo false)"
export AISOC_BING_GROUNDING_ACCOUNT="$(terraform output -raw bing_grounding_account_name 2>/dev/null || echo)"
export AISOC_BING_GROUNDING_API_KEY="$(terraform output -raw bing_grounding_api_key 2>/dev/null || echo)"

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

# Ensure a local venv exists with required deps for the Python deploy script.
VENV_DIR="$root/.venv"
PY_BIN="$VENV_DIR/bin/python"

if [[ ! -x "$PY_BIN" ]]; then
  echo "Creating venv at $VENV_DIR" >&2
  python3 -m venv "$VENV_DIR"
fi

# Install dependencies (idempotent)
"$PY_BIN" -m pip install -q --upgrade pip
"$PY_BIN" -m pip install -q -r "$root/scripts/requirements.txt"

"$PY_BIN" scripts/deploy_prompt_agents_with_runner_tools.py
