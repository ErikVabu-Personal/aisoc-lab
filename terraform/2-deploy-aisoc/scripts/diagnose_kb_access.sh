#!/usr/bin/env bash
# diagnose_kb_access.sh — print every relevant piece of state that
# the Foundry IQ knowledge-base subsystem depends on.
#
# Run this when the agents (Detection Engineer / company-context-
# enabled agents) report HTTP 403 against the KB MCP endpoint, or
# when the Foundry portal's Knowledge Bases tab fails to fetch.
#
# It checks, in order:
#   1. Foundry account/hub MI principal id
#   2. Foundry project MI principal id
#   3. Logged-in user's object id
#   4. All role assignments on the Search service (for context)
#   5. The Foundry project connection record for the KB
#   6. A live unauthenticated probe against the MCP endpoint
#      (sanity-check that the URL itself is reachable)
#
# Outputs are plain — copy/paste the result into a debugging
# session. Read-only — never mutates state.
#
# Usage:
#   cd terraform/2-deploy-aisoc
#   ./scripts/diagnose_kb_access.sh
#
# Requires: `az` logged in, `terraform` available in PATH.

set -euo pipefail
cd "$(dirname "$0")/.."

print_section() {
  echo
  echo "================================================================"
  echo "  $1"
  echo "================================================================"
}

read_tf_output() {
  local name="$1"
  local val
  val="$(terraform output -raw "$name" 2>/dev/null || echo "")"
  echo "$val"
}

# ---- Read the relevant outputs + names -------------------------------

SUB="$(read_tf_output subscription_id)"
[ -z "$SUB" ] && SUB="$(az account show --query id -o tsv)"
RG="$(read_tf_output resource_group)"
HUB="$(read_tf_output foundry_hub_name)"
PROJECT="$(read_tf_output foundry_project_name)"
SEARCH_EP="$(read_tf_output detection_rules_search_endpoint)"
KB_NAME="$(read_tf_output detection_rules_kb_name)"
KB_CONN_NAME="$(read_tf_output detection_rules_project_connection_name)"

if [[ -z "$RG" || -z "$HUB" || -z "$PROJECT" || -z "$SEARCH_EP" ]]; then
  echo "ERROR: missing terraform outputs. Run from terraform/2-deploy-aisoc/ and ensure phase 2 has applied."
  exit 2
fi

# Derive the Search service ARM id from the endpoint URL.
# https://<svc>.search.windows.net → <svc>
SEARCH_NAME="$(echo "$SEARCH_EP" | sed 's|https://||' | sed 's|\.search\.windows\.net.*||')"
SEARCH_ID="/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.Search/searchServices/${SEARCH_NAME}"

print_section "Inputs"
cat <<EOF
Subscription:       ${SUB}
Resource group:     ${RG}
Foundry hub:        ${HUB}
Foundry project:    ${PROJECT}
Search service:     ${SEARCH_NAME}
Search endpoint:    ${SEARCH_EP}
KB name:            ${KB_NAME}
KB project conn:    ${KB_CONN_NAME}
Search ARM id:      ${SEARCH_ID}
EOF

# ---- 1. Hub / account MI principal id -------------------------------

print_section "1. Foundry hub/account MI principalId"
HUB_MI="$(az rest --method GET \
  --url "https://management.azure.com/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.CognitiveServices/accounts/${HUB}?api-version=2025-06-01" \
  --query 'identity.principalId' -o tsv 2>/dev/null || echo "")"
if [ -z "$HUB_MI" ]; then
  echo "WARN: could not fetch hub MI. Hub may not exist or RBAC denies the read."
else
  echo "${HUB_MI}"
fi

# ---- 2. Project MI principal id -------------------------------------

print_section "2. Foundry project MI principalId"
PROJECT_MI="$(az rest --method GET \
  --url "https://management.azure.com/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.CognitiveServices/accounts/${HUB}/projects/${PROJECT}?api-version=2025-06-01" \
  --query 'identity.principalId' -o tsv 2>/dev/null || echo "")"
if [ -z "$PROJECT_MI" ]; then
  echo "WARN: could not fetch project MI. Project may not exist yet (run deploy_foundry_project.py)."
else
  echo "${PROJECT_MI}"
fi

# ---- 3. Current az user ---------------------------------------------

print_section "3. Logged-in 'az' principal"
USER_ID="$(az ad signed-in-user show --query id -o tsv 2>/dev/null || echo "")"
if [ -n "$USER_ID" ]; then
  USER_UPN="$(az ad signed-in-user show --query userPrincipalName -o tsv 2>/dev/null || echo "")"
  echo "User: ${USER_UPN}"
  echo "OID:  ${USER_ID}"
else
  # Probably a service principal (CI / OIDC)
  SP_ID="$(az account show --query 'user.name' -o tsv 2>/dev/null || echo "")"
  echo "Service principal: ${SP_ID}"
fi

# ---- 4. All role assignments on the Search service -----------------

print_section "4. All role assignments on the Search service"
echo "Looking up role assignments scoped to ${SEARCH_NAME}…"
az role assignment list \
  --scope "${SEARCH_ID}" \
  --query '[].{principalId:principalId, principalType:principalType, role:roleDefinitionName, scope:scope}' \
  -o table

echo
echo "What you SHOULD see (one row each):"
echo "  - Hub MI                (Search Index Data Reader)        [from drk_foundry_to_search]"
echo "  - Search service MI     (Search Index Data Contributor)   [from drk_search_self_contributor]"
echo "  - Deploying user / SP   (Search Service Contributor)      [from drk_user_to_search]"
echo "  - Project MI            (Search Service Contributor)      [from deploy_prompt_agents_with_runner_tools.py]"

# ---- 5. The Foundry project connection record ----------------------

print_section "5. Foundry project connection (${KB_CONN_NAME})"
CONN_URL="https://management.azure.com/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.CognitiveServices/accounts/${HUB}/projects/${PROJECT}/connections/${KB_CONN_NAME}?api-version=2025-06-01"
echo "GET ${CONN_URL}"
echo
az rest --method GET --url "${CONN_URL}" 2>/dev/null \
  | python3 -c "import sys, json; d = json.load(sys.stdin); p = d.get('properties', {}); print(json.dumps({'category': p.get('category'), 'authType': p.get('authType'), 'target': p.get('target'), 'audience': p.get('audience'), 'isSharedToAll': p.get('isSharedToAll'), 'metadata': p.get('metadata')}, indent=2))" \
  || echo "ERROR: could not fetch the connection record. Run deploy_prompt_agents_with_runner_tools.py to (re)create it."

echo
echo "What you SHOULD see:"
echo "  category:  RemoteTool"
echo "  authType:  ProjectManagedIdentity"
echo "  target:    https://<svc>.search.windows.net/knowledgebases/<kb>/mcp?api-version=…"
echo "  audience:  https://search.azure.com/"

# ---- 6. Reachability probe of the MCP endpoint ---------------------

print_section "6. MCP endpoint reachability probe (unauth, expect 401)"
MCP_URL="${SEARCH_EP}/knowledgebases/${KB_NAME}/mcp?api-version=2025-11-01-preview"
echo "GET ${MCP_URL}"
echo
HTTP_CODE="$(curl -s -o /tmp/mcp_probe.txt -w '%{http_code}' "${MCP_URL}" || echo 000)"
echo "HTTP ${HTTP_CODE}"
if [ "${HTTP_CODE}" = "401" ]; then
  echo "OK: endpoint exists, requires auth (expected). RBAC grants are what determine if the MI/user can call it."
elif [ "${HTTP_CODE}" = "404" ]; then
  echo "FAIL: endpoint returns 404 — the KB does NOT exist on the service. Re-run the seeder:"
  echo "  terraform apply -target=null_resource.drk_search_seed"
elif [ "${HTTP_CODE}" = "000" ]; then
  echo "FAIL: endpoint unreachable. DNS / network issue."
else
  echo "Unexpected. Body:"
  cat /tmp/mcp_probe.txt
fi

# ---- Summary -------------------------------------------------------

print_section "Summary"
cat <<EOF
If the Detection Engineer agent is still getting HTTP 403 against
the MCP endpoint, the most likely root causes — in order of
probability — are:

1. Section 4: project MI is missing from the role-assignment list.
   Fix:
     python3 scripts/deploy_prompt_agents_with_runner_tools.py
   (idempotent — re-runs the role grant).

2. Section 5: the connection record's authType is something other
   than 'ProjectManagedIdentity', or target / audience are wrong.
   Fix: same script as above will re-PUT the connection.

3. RBAC propagation lag (1–5 minutes; sometimes longer for newly-
   added Search-specific roles). Wait, then retry.

4. Section 6: HTTP 404 on the MCP probe means the KB doesn't exist
   on the Search service. The seeder didn't run successfully.
   Fix:
     terraform apply -target=null_resource.drk_search_seed

5. Foundry portal caches failed responses for ~60s. Hard-reload
   any portal pages after fixing.
EOF
