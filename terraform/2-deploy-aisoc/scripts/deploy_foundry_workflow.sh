#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}" )" && pwd)"
root="$(cd "$here/.." && pwd)"
cd "$root"

# Export deterministic identifiers (same as deploy_prompt_agents_with_runner_tools.sh)
export AZURE_SUBSCRIPTION_ID="$(terraform output -raw subscription_id 2>/dev/null || az account show --query id -o tsv)"
export AZURE_RESOURCE_GROUP="$(terraform output -raw resource_group)"
export AZURE_FOUNDRY_HUB_NAME="$(terraform output -raw foundry_hub_name)"
export AZURE_FOUNDRY_PROJECT_NAME="$(terraform output -raw foundry_project_name)"

export AISOC_WORKFLOW_NAME="${AISOC_WORKFLOW_NAME:-aisoc-incident-pipeline}"
export AISOC_WORKFLOW_YAML="${AISOC_WORKFLOW_YAML:-workflows/aisoc-incident-pipeline.yaml}"

# Ensure a local venv exists with required deps.
VENV_DIR="$root/.venv"
PY_BIN="$VENV_DIR/bin/python"

if [[ ! -x "$PY_BIN" ]]; then
  echo "Creating venv at $VENV_DIR" >&2
  python3 -m venv "$VENV_DIR"
fi

"$PY_BIN" -m pip install -q --upgrade pip
"$PY_BIN" -m pip install -q -r "$root/scripts/requirements.txt"

"$PY_BIN" scripts/deploy_foundry_workflow.py
