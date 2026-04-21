#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

export AZURE_AI_FOUNDRY_PROJECT_ENDPOINT="$(terraform output -raw foundry_project_endpoint)"
export AZURE_AI_MODEL_DEPLOYMENT="$(terraform output -raw foundry_model_deployment_name)"
export AISOC_RUNNER_URL="$(terraform output -raw runner_url)"

KV_ID="$(terraform output -raw key_vault_id)"
KV_NAME="${KV_ID##*/}"
RUNNER_SECRET="$(terraform output -raw runner_bearer_token_secret_name)"
export AISOC_RUNNER_BEARER="$(az keyvault secret show --vault-name "$KV_NAME" --name "$RUNNER_SECRET" --query value -o tsv)"

python3 scripts/deploy_prompt_agents_with_runner_tools.py
