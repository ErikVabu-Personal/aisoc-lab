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

# Ensure the project connection exists (SDK can't create it in our environment)
CONN_NAME="aisoc-runner-key"
if ! az cognitiveservices account project connection show \
  -g "$RG" -n "$HUB" --project-name "$PROJ" --connection-name "$CONN_NAME" >/dev/null 2>&1; then

  TMP_FILE="/tmp/${CONN_NAME}.connection.json"
  cat >"$TMP_FILE" <<EOF
{
  "type": "CustomKeys",
  "displayName": "AISOC Runner Key",
  "target": "${AISOC_RUNNER_URL}",
  "customKeys": {
    "x-aisoc-runner-key": "${AISOC_RUNNER_BEARER}"
  }
}
EOF

  az cognitiveservices account project connection create \
    -g "$RG" \
    -n "$HUB" \
    --project-name "$PROJ" \
    --connection-name "$CONN_NAME" \
    --file "$TMP_FILE" \
    >/dev/null

  echo "Created Foundry project connection: $CONN_NAME"
fi

python3 scripts/deploy_prompt_agents_with_runner_tools.py
