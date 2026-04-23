#!/usr/bin/env bash
set -euo pipefail

# Deploy Foundry agents via Azure Developer CLI (azd) extension: azure.ai.agents
#
# Prereqs:
# - az login
# - azd installed
# - terraform apply completed in this folder
#
# This script initializes an azd agent project pinned to the existing Foundry Project Id
# and model deployment name from Terraform outputs.

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"

cd "$root"

# Pull required outputs
PROJECT_ID="$(terraform output -raw foundry_project_id)"
MODEL_DEPLOYMENT="$(terraform output -raw foundry_model_deployment_name)"

if [[ -z "$PROJECT_ID" ]]; then
  echo "ERROR: foundry_project_id output is empty. Ensure terraform apply succeeded, then create the project via scripts/legacy/deploy_foundry_project.py." >&2
  exit 2
fi

if [[ -z "$MODEL_DEPLOYMENT" || "$MODEL_DEPLOYMENT" == "null" ]]; then
  echo "ERROR: foundry_model_deployment_name output is empty. Set it in terraform.tfvars." >&2
  exit 3
fi

# Create a unique azd env name based on the TF suffix if present
SUFFIX=""
SUFFIX_JSON="$(terraform output -json 2>/dev/null || true)"
if command -v python3 >/dev/null 2>&1; then
  SUFFIX="$(python3 - <<'PY'
import json,sys
try:
  j=json.load(sys.stdin)
  # random suffix output doesn't exist; best-effort: derive from project id
  pid=j.get('foundry_project_id',{}).get('value','')
  if pid:
    print(pid.split('/')[-1].split('-')[-1])
except Exception:
  pass
PY
<<<"$SUFFIX_JSON")"
fi

ENV_NAME="aisoc-agent-${SUFFIX:-env}"

echo "Using Foundry Project Id: $PROJECT_ID"
echo "Using model deployment:   $MODEL_DEPLOYMENT"
echo "Using azd environment:    $ENV_NAME"

# Ensure the extension is installed (idempotent)
azd ai agent version >/dev/null

# Init into a local folder under terraform/2-deploy-aisoc/.azd-agent
AGENT_DIR="$root/.azd-agent"
mkdir -p "$AGENT_DIR"

# Configure ACR endpoint for hosted agent builds
ACR_SERVER="$(terraform output -raw acr_login_server 2>/dev/null || true)"
if [[ -z "$ACR_SERVER" || "$ACR_SERVER" == "null" ]]; then
  echo "ERROR: acr_login_server output is empty. Run terraform apply after pulling the ACR changes." >&2
  exit 4
fi
export AZURE_CONTAINER_REGISTRY_ENDPOINT="$ACR_SERVER"

# Persist env var into the default azd environment file (best-effort)
ENV_DIR="$root/.azure/2-deploy-aisoc-dev"
if [[ -d "$ENV_DIR" ]]; then
  ENV_FILE="$ENV_DIR/.env"
  if [[ -f "$ENV_FILE" ]]; then
    # remove any existing line
    grep -v '^AZURE_CONTAINER_REGISTRY_ENDPOINT=' "$ENV_FILE" >"$ENV_FILE.tmp" || true
    mv "$ENV_FILE.tmp" "$ENV_FILE"
    echo "AZURE_CONTAINER_REGISTRY_ENDPOINT=$AZURE_CONTAINER_REGISTRY_ENDPOINT" >>"$ENV_FILE"
  fi
fi

# Initialize (non-interactive)
azd ai agent init "$AGENT_DIR" \
  --environment "$ENV_NAME" \
  --project-id "$PROJECT_ID" \
  --model-deployment "$MODEL_DEPLOYMENT" \
  --no-prompt

echo "Initialized azd agent project in $AGENT_DIR"

echo "\nNEXT STEP: deploy hosted agent (no provision):"
echo "- cd $root"
echo "- run: azd deploy 2-deploy-aisoc"
