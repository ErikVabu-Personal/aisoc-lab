#!/usr/bin/env bash
set -euo pipefail

# Deploy Prompt (Native) agent into the existing Foundry project.
# Requires: az login (or azd auth login)

cd "$(dirname "$0")/.."

PROJECT_ENDPOINT="$(terraform output -raw foundry_project_endpoint 2>/dev/null || true)"
if [[ -z "$PROJECT_ENDPOINT" || "$PROJECT_ENDPOINT" == "null" ]]; then
  echo "ERROR: missing terraform output foundry_project_endpoint. For now, set it manually:" >&2
  echo "  export AZURE_AI_FOUNDRY_PROJECT_ENDPOINT=..." >&2
  exit 2
fi

export AZURE_AI_FOUNDRY_PROJECT_ENDPOINT="$PROJECT_ENDPOINT"
export AZURE_AI_MODEL_DEPLOYMENT="$(terraform output -raw foundry_model_deployment_name)"

export AISOC_RUNNER_OPENAPI_URL="$(terraform output -raw runner_url)/openapi.json"

KV_ID="$(terraform output -raw key_vault_id)"
KV_NAME="${KV_ID##*/}"
RUNNER_SECRET="$(terraform output -raw runner_bearer_token_secret_name)"
export AISOC_RUNNER_BEARER="$(az keyvault secret show --vault-name "$KV_NAME" --name "$RUNNER_SECRET" --query value -o tsv)"

python3 scripts/deploy_prompt_agent.py --agent-yaml agents/soc_analyst/agent.yaml
