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

RG="$(terraform output -raw resource_group 2>/dev/null || true)"
PIXEL_URL="$(terraform output -raw pixelagents_url)"
PIXEL_TOKEN="$(terraform output -raw pixelagents_token)"

if [[ -z "$PIXEL_URL" || "$PIXEL_URL" == "null" ]]; then
  echo "ERROR: missing terraform output pixelagents_url (run terraform apply in 3-deploy-pixelagents-web)" >&2
  exit 2
fi

# Get runner info from Phase 2 state
RUNNER_NAME="$(terraform -chdir=../2-deploy-aisoc output -raw runner_name)"
if [[ -z "$RG" || "$RG" == "null" ]]; then
  RG="$(terraform -chdir=../2-deploy-aisoc output -raw resource_group)"
fi

if [[ -z "$RUNNER_NAME" || "$RUNNER_NAME" == "null" ]]; then
  echo "ERROR: missing runner_name from 2-deploy-aisoc outputs" >&2
  exit 3
fi

if [[ -z "$RG" || "$RG" == "null" ]]; then
  echo "ERROR: could not determine resource group" >&2
  exit 4
fi

EVENTS_URL="${PIXEL_URL%/}/events"

echo "Configuring runner '$RUNNER_NAME' to emit PixelAgents events to: $EVENTS_URL" >&2

# Set a secret for the PixelAgents token, then reference it via env var.
az containerapp secret set \
  -g "$RG" \
  -n "$RUNNER_NAME" \
  --secrets "pixelagents-token=$PIXEL_TOKEN" \
  >/dev/null

az containerapp update \
  -g "$RG" \
  -n "$RUNNER_NAME" \
  --set-env-vars \
    PIXELAGENTS_URL="$EVENTS_URL" \
    PIXELAGENTS_TOKEN=secretref:pixelagents-token \
    RESTART_TS="$(date +%s)" \
  >/dev/null

echo "OK: runner updated (new revision triggered)." >&2

# Best-effort verify: PixelAgents healthz + runner debug config shows URL is set.
if command -v curl >/dev/null 2>&1; then
  curl -fsS "${PIXEL_URL%/}/healthz" >/dev/null && echo "OK: pixelagents_web healthz reachable" >&2 || true
fi
