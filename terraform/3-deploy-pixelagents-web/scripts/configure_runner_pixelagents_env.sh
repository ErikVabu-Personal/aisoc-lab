#!/usr/bin/env bash
set -euo pipefail

# Configure AISOC Runner to emit telemetry events to PixelAgents Web.
#
# Wiring:
# - Runner emits POST <PIXELAGENTS_URL> with header x-pixelagents-token=PIXELAGENTS_TOKEN
# - PixelAgents Web ingests at POST /events
#
# This script reads outputs from Terraform states:
# - Phase 2 (2-deploy-aisoc): runner_name, resource_group
# - Phase 3 (3-deploy-pixelagents-web): pixelagents_url, pixelagents_token
#
# Prereqs:
# - az login
# - terraform apply completed in both phases

here="$(cd "$(dirname "${BASH_SOURCE[0]}" )" && pwd)"
root="$(cd "$here/.." && pwd)"
cd "$root"

# Allow callers (CI workflows, Terraform null_resource) to pass values
# via env vars. Fall back to `terraform output` so the script still works
# as a standalone local-dev convenience.
RG="${RG:-}"
RUNNER_NAME="${RUNNER_NAME:-}"
PIXEL_URL="${PIXEL_URL:-}"
PIXEL_TOKEN="${PIXEL_TOKEN:-}"

if [[ -z "$PIXEL_URL" || "$PIXEL_URL" == "null" ]]; then
  PIXEL_URL="$(terraform output -raw pixelagents_url 2>/dev/null || true)"
fi
if [[ -z "$PIXEL_TOKEN" || "$PIXEL_TOKEN" == "null" ]]; then
  PIXEL_TOKEN="$(terraform output -raw pixelagents_token 2>/dev/null || true)"
fi
if [[ -z "$RG" || "$RG" == "null" ]]; then
  RG="$(terraform output -raw resource_group 2>/dev/null || true)"
fi
if [[ -z "$RUNNER_NAME" || "$RUNNER_NAME" == "null" ]]; then
  RUNNER_NAME="$(terraform -chdir=../2-deploy-aisoc output -raw runner_name 2>/dev/null || true)"
fi
if [[ -z "$RG" || "$RG" == "null" ]]; then
  RG="$(terraform -chdir=../2-deploy-aisoc output -raw resource_group 2>/dev/null || true)"
fi

if [[ -z "$PIXEL_URL" || "$PIXEL_URL" == "null" ]]; then
  echo "ERROR: pixelagents_url not set (pass PIXEL_URL env var or run terraform apply in 3-deploy-pixelagents-web)" >&2
  exit 2
fi
if [[ -z "$RUNNER_NAME" || "$RUNNER_NAME" == "null" ]]; then
  echo "ERROR: runner_name not set (pass RUNNER_NAME env var or apply Phase 2)" >&2
  exit 3
fi
if [[ -z "$RG" || "$RG" == "null" ]]; then
  echo "ERROR: resource_group not set (pass RG env var or apply Phase 1/2)" >&2
  exit 4
fi

EVENTS_URL="${PIXEL_URL%/}/events"

# Optional: set PixelAgents roster from Phase 2 agent deploy outputs (slug form).
ROSTER_FILE="$(cd "$root/../2-deploy-aisoc" && pwd)/agents/roster.slugs.txt"
ROSTER=""
if [[ -f "$ROSTER_FILE" ]]; then
  ROSTER="$(tr -d '\n' <"$ROSTER_FILE" | tr -d ' ')"
fi

echo "Configuring runner '$RUNNER_NAME' to emit PixelAgents events to: $EVENTS_URL" >&2
if [[ -n "$ROSTER" ]]; then
  echo "Using PixelAgents agent roster: $ROSTER" >&2
fi

# Set a secret for the PixelAgents token, then reference it via env var.
az containerapp secret set \
  -g "$RG" \
  -n "$RUNNER_NAME" \
  --secrets "pixelagents-token=$PIXEL_TOKEN" \
  >/dev/null

# Foundry project endpoint — needed by the runner's
# query_threat_intel tool, which invokes the threat-intel agent
# directly via /openai/v1/responses. Pulled from Phase 2's output;
# best-effort (the runner's TI tool will surface a clear 503 if it's
# missing).
FOUNDRY_ENDPOINT="$(cd "$root/../2-deploy-aisoc" && terraform output -raw foundry_project_endpoint 2>/dev/null || echo)"

az containerapp update \
  -g "$RG" \
  -n "$RUNNER_NAME" \
  --set-env-vars \
    PIXELAGENTS_URL="$EVENTS_URL" \
    PIXELAGENTS_TOKEN=secretref:pixelagents-token \
    ${ROSTER:+PIXELAGENTS_AGENT_ROSTER="$ROSTER"} \
    ${FOUNDRY_ENDPOINT:+AZURE_AI_FOUNDRY_PROJECT_ENDPOINT="$FOUNDRY_ENDPOINT"} \
    RESTART_TS="$(date +%s)" \
  >/dev/null

echo "OK: runner updated (new revision triggered)." >&2

# Best-effort verify: PixelAgents healthz + runner debug config shows URL is set.
if command -v curl >/dev/null 2>&1; then
  curl -fsS "${PIXEL_URL%/}/healthz" >/dev/null && echo "OK: pixelagents_web healthz reachable" >&2 || true
fi
