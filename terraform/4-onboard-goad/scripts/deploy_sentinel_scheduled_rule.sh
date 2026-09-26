#!/usr/bin/env bash
set -euo pipefail

# Generic Sentinel scheduled-analytics-rule deployer (idempotent PUT by RULE_ID).
# Parameterised via env so one script serves every AD rule. Same ARM pattern as
# Phase 1's deploy_sentinel_rule_controlpanel_auth_failures.sh, but table-agnostic
# and with no _CL readiness poll (SecurityEvent is a built-in table, so ARM
# validates the KQL even before GOAD data arrives).
#
# Required env: RG, LAW, RULE_ID, DISPLAY_NAME, QUERY_FILE
# Optional env: DESCRIPTION, SEVERITY(=Medium), TACTICS_JSON(=[]), ENTITY_MAPPINGS_JSON(=[])

: "${RG:?set RG}"
: "${LAW:?set LAW (workspace name)}"
: "${RULE_ID:?set RULE_ID}"
: "${DISPLAY_NAME:?set DISPLAY_NAME}"
: "${QUERY_FILE:?set QUERY_FILE}"
SEVERITY="${SEVERITY:-Medium}"
DESCRIPTION="${DESCRIPTION:-}"
TACTICS_JSON="${TACTICS_JSON:-[]}"
ENTITY_MAPPINGS_JSON="${ENTITY_MAPPINGS_JSON:-[]}"

if [[ ! -f "$QUERY_FILE" ]]; then
  echo "ERROR: QUERY_FILE not found: $QUERY_FILE" >&2
  exit 2
fi
QUERY="$(cat "$QUERY_FILE")"
SUB="$(az account show --query id -o tsv)"

URL="https://management.azure.com/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.OperationalInsights/workspaces/${LAW}/providers/Microsoft.SecurityInsights/alertRules/${RULE_ID}?api-version=2025-09-01"

BODY=$(jq -n \
  --arg displayName "$DISPLAY_NAME" \
  --arg desc "$DESCRIPTION" \
  --arg query "$QUERY" \
  --arg severity "$SEVERITY" \
  --argjson tactics "$TACTICS_JSON" \
  --argjson entities "$ENTITY_MAPPINGS_JSON" \
  '{
    kind: "Scheduled",
    properties: {
      displayName: $displayName,
      description: $desc,
      enabled: true,
      severity: $severity,
      query: $query,
      queryFrequency: "PT1H",
      queryPeriod: "PT1H",
      triggerOperator: "GreaterThan",
      triggerThreshold: 0,
      suppressionEnabled: false,
      suppressionDuration: "PT1H",
      incidentConfiguration: {
        createIncident: true,
        groupingConfiguration: {
          enabled: false,
          reopenClosedIncident: false,
          lookbackDuration: "PT1H",
          matchingMethod: "AllEntities",
          groupByEntities: [],
          groupByAlertDetails: [],
          groupByCustomDetails: []
        }
      },
      eventGroupingSettings: { aggregationKind: "SingleAlert" },
      tactics: $tactics,
      entityMappings: $entities
    }
  }')

echo "Deploying rule '$DISPLAY_NAME' (id=$RULE_ID) into $RG/$LAW ..." >&2
resp="$(az rest --method put --url "$URL" --body "$BODY" -o json 2>&1)" || {
  echo "ERROR: az rest failed" >&2
  echo "$resp" | head -c 1200 >&2
  exit 4
}
echo "OK: deployed '$DISPLAY_NAME'." >&2
