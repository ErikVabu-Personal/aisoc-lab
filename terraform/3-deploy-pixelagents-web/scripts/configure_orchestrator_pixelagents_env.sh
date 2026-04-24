#!/usr/bin/env bash
set -euo pipefail

# Configure the AISOC Orchestrator to emit per-incident cost records to
# PixelAgents Web.
#
# Wiring:
# - Orchestrator POSTs to <PIXELAGENTS_URL_BASE>/api/cost/record for every
#   agent turn inside a workflow, tagged with incident number + agent +
#   workflow_run_id. PixelAgents Web aggregates in-memory and exposes
#   /api/sentinel/incidents/{n}/cost for the UI.
# - Same PIXELAGENTS_TOKEN gate as the runner.
#
# This script reads outputs from Terraform states:
# - Phase 2 (2-deploy-aisoc): orchestrator_function_name, resource_group
# - Phase 3 (3-deploy-pixelagents-web): pixelagents_url, pixelagents_token
#
# Prereqs:
# - az login
# - terraform apply completed in both phases

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
cd "$root"

RG="$(terraform output -raw resource_group 2>/dev/null || true)"
PIXEL_URL="$(terraform output -raw pixelagents_url)"
PIXEL_TOKEN="$(terraform output -raw pixelagents_token)"

if [[ -z "$PIXEL_URL" || "$PIXEL_URL" == "null" ]]; then
  echo "ERROR: missing terraform output pixelagents_url (run terraform apply in 3-deploy-pixelagents-web)" >&2
  exit 2
fi

ORCH_NAME="$(terraform -chdir=../2-deploy-aisoc output -raw orchestrator_function_name)"
if [[ -z "$RG" || "$RG" == "null" ]]; then
  RG="$(terraform -chdir=../2-deploy-aisoc output -raw resource_group)"
fi

if [[ -z "$ORCH_NAME" || "$ORCH_NAME" == "null" ]]; then
  echo "ERROR: missing orchestrator_function_name from 2-deploy-aisoc outputs" >&2
  exit 3
fi

if [[ -z "$RG" || "$RG" == "null" ]]; then
  echo "ERROR: could not determine resource group" >&2
  exit 4
fi

# Orchestrator uses the same env var the runner uses (PIXELAGENTS_URL).
# The orchestrator's code strips a trailing /events off this value
# before calling /api/cost/record, so passing the events URL or the
# bare base both work — we pass the events URL for consistency with
# the runner wiring.
EVENTS_URL="${PIXEL_URL%/}/events"

echo "Configuring orchestrator '$ORCH_NAME' with PixelAgents URL: $EVENTS_URL" >&2

az functionapp config appsettings set \
  -g "$RG" \
  -n "$ORCH_NAME" \
  --settings \
    PIXELAGENTS_URL="$EVENTS_URL" \
    PIXELAGENTS_TOKEN="$PIXEL_TOKEN" \
  >/dev/null

echo "OK: orchestrator updated (new revision will pick up on next call)." >&2
