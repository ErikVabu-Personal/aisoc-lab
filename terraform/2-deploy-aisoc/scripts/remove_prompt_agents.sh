#!/usr/bin/env bash
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}" )" && pwd)"
root="$(cd "$here/.." && pwd)"
cd "$root"

export AZURE_AI_FOUNDRY_PROJECT_ENDPOINT="$(terraform output -raw foundry_project_endpoint)"

# Ensure a local venv exists with required deps.
VENV_DIR="$root/.venv"
PY_BIN="$VENV_DIR/bin/python"

if [[ ! -x "$PY_BIN" ]]; then
  echo "Creating venv at $VENV_DIR" >&2
  python3 -m venv "$VENV_DIR"
fi

"$PY_BIN" -m pip install -q --upgrade pip
"$PY_BIN" -m pip install -q -r "$root/scripts/requirements.txt"

"$PY_BIN" scripts/remove_prompt_agents.py "$@"
