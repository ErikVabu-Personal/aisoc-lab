#!/usr/bin/env bash
set -euo pipefail

# Deploy Sentinel scheduled analytics rule: Control Panel failed login attempts (user+IP)
#
# Why a script?
# Sentinel validates the KQL query at rule creation time. During initial provisioning,
# custom tables like ContainerAppConsoleLogs_CL may not exist yet, causing Terraform/ARM
# deployments to fail. This script can wait/retry until the table exists.

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
cd "$root"

# Prefer explicit env vars (useful when running from CI or when output names differ).
RG="${RG:-}"
LAW="${LAW:-}"

if [[ -z "${RG:-}" ]]; then
  RG="$(terraform output -raw resource_group 2>/dev/null || true)"
fi

if [[ -z "${LAW:-}" ]]; then
  LAW="$(terraform output -raw log_analytics_workspace_name 2>/dev/null || true)"
fi

SUB="$(az account show --query id -o tsv)"

if [[ -z "${RG:-}" || -z "${LAW:-}" ]]; then
  echo "ERROR: could not resolve RG/LAW. Set RG and LAW env vars, or run from terraform/1-deploy-sentinel with outputs available." >&2
  echo "Hint: RG=\"$(terraform output -raw resource_group 2>/dev/null || echo '')\"" >&2
  echo "Hint: LAW=\"$(terraform output -raw log_analytics_workspace_name 2>/dev/null || echo '')\"" >&2
  exit 2
fi

echo "RG=$RG" >&2
echo "LAW=$LAW" >&2

# Workspace customer id (GUID) is required for `az monitor log-analytics query`.
# (Workspace name won't work here.)
WSID="${WSID:-}"
if [[ -z "${WSID:-}" ]]; then
  WSID="$(terraform output -raw log_analytics_workspace_workspace_id 2>/dev/null || true)"
fi

if [[ -z "${WSID:-}" ]]; then
  echo "WARN: could not resolve WSID (Log Analytics workspace customer id). Skipping table readiness check." >&2
else
  echo "Waiting for table ContainerAppConsoleLogs_CL to exist in workspace..." >&2
  for i in $(seq 1 30); do
    # Query via LA API: if table missing, query fails.
    if az monitor log-analytics query \
        --workspace "$WSID" \
        --analytics-query "ContainerAppConsoleLogs_CL | take 1" \
        --timespan PT1H \
        >/dev/null 2>&1; then
      echo "OK: table exists." >&2
      break
    fi
    echo "  not yet (attempt $i/30); sleeping 20s..." >&2
    sleep 20
    if [[ $i -eq 30 ]]; then
      echo "ERROR: table did not appear after 10 minutes. Generate a log line from the Container App and retry." >&2
      exit 3
    fi
  done
fi

RULE_ID="${RULE_ID:-$(python3 - <<'PY'
import uuid
print(uuid.uuid4())
PY
)}"

RULE_NAME="controlpanel-auth-failures"

read -r -d '' QUERY <<'KQL'
ContainerAppConsoleLogs_CL
| where TimeGenerated > ago(5m)
| where Log_s has "auth.login.failure"
| extend j = parse_json(Log_s)
| where isnotnull(j)
| extend event = tostring(j.event), username = tostring(j.detail.username), clientIp = tostring(j.detail.client), userAgent = tostring(j.detail.userAgent)
| where event == "auth.login.failure"
| summarize FailureCount = count(), UserAgents = make_set(userAgent, 5), FirstSeen = min(TimeGenerated), LastSeen = max(TimeGenerated) by username, clientIp
| where FailureCount >= 3
| extend timestamp = LastSeen
KQL

# Create/Update rule via ARM (PUT is idempotent).
URL="https://management.azure.com/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.OperationalInsights/workspaces/${LAW}/providers/Microsoft.SecurityInsights/alertRules/${RULE_ID}?api-version=2025-09-01"

BODY=$(jq -n --arg displayName "Control Panel: multiple failed logins (user + IP)" \
  --arg desc "Creates an incident when repeated auth.login.failure events are observed for the same username from the same client IP within 5 minutes." \
  --arg query "$QUERY" \
  '{
    kind: "Scheduled",
    properties: {
      displayName: $displayName,
      description: $desc,
      enabled: true,
      severity: "Medium",
      query: $query,
      queryFrequency: "PT5M",
      queryPeriod: "PT5M",
      triggerOperator: "GreaterThan",
      triggerThreshold: 0,
      suppressionEnabled: false,
      suppressionDuration: "PT5M",
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
      tactics: ["CredentialAccess"]
    }
  }')

echo "Deploying rule (id=$RULE_ID) via az rest..." >&2
az rest --method put --url "$URL" --body "$BODY" >/dev/null

echo "OK: deployed. Rule id=$RULE_ID" >&2
