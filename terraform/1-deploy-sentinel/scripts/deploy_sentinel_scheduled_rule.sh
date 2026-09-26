#!/usr/bin/env bash
set -euo pipefail

# Generic Sentinel scheduled-analytics-rule deployer (idempotent PUT by RULE_ID),
# with an OPTIONAL table-readiness poll for custom (_CL) tables that Log Analytics
# creates lazily on first ingest. Same ARM shape as the original SCP rule script,
# parameterised so one script serves every Maison rule.
#
# Required env: RG, LAW, RULE_ID, DISPLAY_NAME, QUERY_FILE
# Optional env: DESCRIPTION, SEVERITY(=Medium), TACTICS_JSON(=[]),
#               ENTITY_MAPPINGS_JSON(=[]), READINESS_TABLE, WSID (workspace GUID)
#
# If READINESS_TABLE is set but never appears (e.g. a cold deploy with no store
# traffic yet), the rule is skipped with a warning and exit 0 — the null_resource
# re-runs on the next apply, so it converges once the table exists.

: "${RG:?set RG}"
: "${LAW:?set LAW (workspace name)}"
: "${RULE_ID:?set RULE_ID}"
: "${DISPLAY_NAME:?set DISPLAY_NAME}"
: "${QUERY_FILE:?set QUERY_FILE}"
SEVERITY="${SEVERITY:-Medium}"
DESCRIPTION="${DESCRIPTION:-}"
TACTICS_JSON="${TACTICS_JSON:-[]}"
ENTITY_MAPPINGS_JSON="${ENTITY_MAPPINGS_JSON:-[]}"
READINESS_TABLE="${READINESS_TABLE:-}"
WSID="${WSID:-}"

[[ -f "$QUERY_FILE" ]] || { echo "ERROR: QUERY_FILE not found: $QUERY_FILE" >&2; exit 2; }
QUERY="$(cat "$QUERY_FILE")"
SUB="$(az account show --query id -o tsv)"

if [[ -n "$READINESS_TABLE" && -n "$WSID" ]]; then
  echo "Waiting for table $READINESS_TABLE to exist..." >&2
  table_ready=0
  for i in $(seq 1 30); do
    if az monitor log-analytics query --workspace "$WSID" \
         --analytics-query "$READINESS_TABLE | take 1" --timespan PT1H >/dev/null 2>&1; then
      echo "OK: $READINESS_TABLE exists." >&2
      table_ready=1
      break
    fi
    echo "  not yet ($i/30); sleeping 20s..." >&2
    sleep 20
  done
  if [[ "$table_ready" -eq 0 ]]; then
    echo "WARN: $READINESS_TABLE not present after ~10min — skipping '$DISPLAY_NAME'." >&2
    echo "      Generate a log line (hit the store) and re-run apply; the rule will deploy then." >&2
    exit 0
  fi
fi

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
      queryFrequency: "PT15M",
      queryPeriod: "PT15M",
      triggerOperator: "GreaterThan",
      triggerThreshold: 0,
      suppressionEnabled: false,
      suppressionDuration: "PT15M",
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
