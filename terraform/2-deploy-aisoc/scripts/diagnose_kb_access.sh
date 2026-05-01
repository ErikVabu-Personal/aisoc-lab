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

# Company-context KB — same Search service, second KB. Probed
# alongside detection-rules so a single diagnostic run covers
# every agent (detection-engineer uses detection-rules; triage /
# investigator / reporter / soc-manager / threat-intel use
# company-context).
CCK_KB_NAME="$(read_tf_output company_context_kb_name)"
CCK_KB_CONN_NAME="$(read_tf_output company_context_project_connection_name)"

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
Subscription:           ${SUB}
Resource group:         ${RG}
Foundry hub:            ${HUB}
Foundry project:        ${PROJECT}
Search service:         ${SEARCH_NAME}
Search endpoint:        ${SEARCH_EP}
detection-rules KB:     ${KB_NAME}
  project conn:         ${KB_CONN_NAME}
company-context KB:     ${CCK_KB_NAME:-(disabled)}
  project conn:         ${CCK_KB_CONN_NAME:-(disabled)}
Search ARM id:          ${SEARCH_ID}
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

# ---- 5. The Foundry project connection records --------------------

show_project_connection() {
  local label="$1" conn_name="$2"
  local url="https://management.azure.com/subscriptions/${SUB}/resourceGroups/${RG}/providers/Microsoft.CognitiveServices/accounts/${HUB}/projects/${PROJECT}/connections/${conn_name}?api-version=2025-06-01"
  echo
  echo "── ${label} (${conn_name}) ──"
  echo "GET ${url}"
  echo
  az rest --method GET --url "${url}" 2>/dev/null \
    | python3 -c "import sys, json; d = json.load(sys.stdin); p = d.get('properties', {}); print(json.dumps({'category': p.get('category'), 'authType': p.get('authType'), 'target': p.get('target'), 'audience': p.get('audience'), 'isSharedToAll': p.get('isSharedToAll'), 'metadata': p.get('metadata')}, indent=2))" \
    || echo "ERROR: connection ${conn_name} not found. Re-run deploy_prompt_agents_with_runner_tools.sh to recreate."
}

print_section "5. Foundry project connection records"
show_project_connection "detection-rules" "${KB_CONN_NAME}"
if [ -n "${CCK_KB_CONN_NAME}" ]; then
  show_project_connection "company-context" "${CCK_KB_CONN_NAME}"
fi

echo
echo "What you SHOULD see for each:"
echo "  category:  RemoteTool"
echo "  authType:  ProjectManagedIdentity"
echo "  target:    https://<svc>.search.windows.net/knowledgebases/<kb>/mcp?api-version=…"
echo "  audience:  https://search.azure.com/"

# ---- 6. Reachability probe of each KB's MCP endpoint ---------------

probe_mcp_endpoint() {
  # probe_mcp_endpoint <label> <kb-name> <seeder-target>
  local label="$1" kb_name="$2" seeder_target="$3"
  local url="${SEARCH_EP}/knowledgebases/${kb_name}/mcp?api-version=2025-11-01-preview"
  echo
  echo "── ${label} (${kb_name}) ──"
  echo "GET ${url}"
  local code
  code="$(curl -s -o /tmp/mcp_probe.txt -w '%{http_code}' "${url}" || echo 000)"
  echo "HTTP ${code}"
  case "${code}" in
    401)
      echo "OK: endpoint exists + AAD auth is enabled (WWW-Authenticate: Bearer challenge is the proof)."
      ;;
    403)
      echo "DIAGNOSTIC: HTTP 403 from unauth = AAD auth DISABLED on the Search service."
      echo "All bearer-token calls (incl. project MI's MCP enumerate) are rejected before RBAC runs."
      echo "Fix once for both KBs (they share the service):"
      echo "  terraform apply -target=azurerm_search_service.detection_rules"
      echo "(the resource block needs: authentication_failure_mode = \"http403\")"
      ;;
    404)
      echo "FAIL: KB '${kb_name}' is not registered on the Search service. Re-run the seeder:"
      echo "  terraform apply -target=${seeder_target}"
      ;;
    000)
      echo "FAIL: endpoint unreachable. DNS / network issue."
      ;;
    *)
      echo "Unexpected. Body:"
      cat /tmp/mcp_probe.txt
      ;;
  esac
}

print_section "6. MCP endpoint reachability probes (unauth, expect 401)"
probe_mcp_endpoint "detection-rules" "${KB_NAME}" "null_resource.drk_search_seed"
if [ -n "${CCK_KB_NAME}" ]; then
  probe_mcp_endpoint "company-context" "${CCK_KB_NAME}" "null_resource.cck_search_seed_context"
else
  echo
  echo "── company-context: skipped (terraform output empty — KB disabled?) ──"
fi

# ---- 7. Authenticated probe with the user's token ------------------
#
# The unauth probe tells us if AAD auth is even ENABLED on the
# service. This authenticated probe tells us whether the user (with
# their granted role) can actually list KBs. If this succeeds, the
# Foundry portal's KB tab will work. If this 403s while the user
# has the role assignment AND AAD auth is enabled, the service is
# still propagating RBAC (wait 5-15 min) or the role isn't right.

print_section "7. Authenticated probe (user token) — list KBs"
KB_LIST_URL="${SEARCH_EP}/knowledgebases?api-version=2025-11-01-preview"
echo "GET ${KB_LIST_URL}"
echo "Authorization: Bearer <user token for https://search.azure.com/>"
echo

USER_TOKEN="$(az account get-access-token --resource https://search.azure.com/ --query accessToken -o tsv 2>/dev/null || echo "")"
if [ -z "${USER_TOKEN}" ]; then
  echo "WARN: could not get a user token for https://search.azure.com/. Skipping auth probe."
else
  AUTH_HTTP="$(curl -s -o /tmp/auth_probe.txt -w '%{http_code}' \
    -H "Authorization: Bearer ${USER_TOKEN}" "${KB_LIST_URL}" || echo 000)"
  echo "HTTP ${AUTH_HTTP}"
  case "${AUTH_HTTP}" in
    200)
      echo "OK: authenticated KB list succeeded. AAD auth is on and the user has the right role."
      echo "    Sample (first 200 chars):"
      head -c 200 /tmp/auth_probe.txt
      echo
      ;;
    401|403)
      echo "FAIL: token rejected. Possibilities:"
      echo "  - AAD auth is disabled at the service level (see section 6)"
      echo "  - User role hasn't propagated yet (wait, retry)"
      echo "  - User has the wrong role (need Search Service Contributor or Search Index"
      echo "    Data Reader/Contributor)"
      echo "Body:"
      cat /tmp/auth_probe.txt
      echo
      ;;
    *)
      echo "Unexpected ${AUTH_HTTP}. Body:"
      cat /tmp/auth_probe.txt
      echo
      ;;
  esac
fi

# ---- Summary -------------------------------------------------------

print_section "Summary"
cat <<EOF
If the Detection Engineer agent is still getting HTTP 403 against
the MCP endpoint, walk this checklist in order:

1. Section 6: HTTP 403 from the unauth probe means AAD auth is
   DISABLED on the Search service. This is the most common cause
   of "agent gets 403 even though all RBAC is correct" and the
   one that doesn't show up in 'az role assignment list'.
   Fix: enable AAD auth on the Search service:
     terraform apply -target=azurerm_search_service.detection_rules
   (the resource block must include
    authentication_failure_mode = "http403")

2. Section 7: HTTP 401/403 from the authenticated probe with the
   user's token means either AAD auth is disabled (covered above)
   or RBAC hasn't propagated. Wait 5-15 min and re-run.

3. Section 4: project MI is missing from the role-assignment list.
   Fix:
     ./scripts/deploy_prompt_agents_with_runner_tools.sh
   (idempotent — re-runs the role grant + project-connection PUT).

4. Section 5: the connection record's authType is something other
   than 'ProjectManagedIdentity', or target / audience are wrong.
   Fix: same script as #3.

5. Section 6: HTTP 404 on the MCP probe means the KB doesn't exist
   on the Search service. The seeder didn't run successfully.
   Fix:
     terraform apply -target=null_resource.drk_search_seed

6. Foundry portal + agents cache failed responses for ~60s. Hard-
   reload any portal pages after fixing, and start a new agent
   chat (don't reuse a stuck one).
EOF
