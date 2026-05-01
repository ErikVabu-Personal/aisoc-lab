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
  #
  # Note on interpretation:
  # An unauth response of 401 vs 403 doesn't tell us if AAD auth is
  # enabled — it depends on the service's authentication_failure_mode:
  #   - "http401WithBearerChallenge" → unauth gets 401 + WWW-Auth
  #   - "http403" (what we use)        → unauth gets 403
  #   - AAD disabled entirely         → unauth gets 403
  # So 403 here is INCONCLUSIVE for this question. Section 7 is the
  # authoritative answer (an authenticated 200 proves AAD is on).
  # We're really only checking endpoint reachability + that the KB
  # exists at the URL.
  local label="$1" kb_name="$2" seeder_target="$3"
  local url="${SEARCH_EP}/knowledgebases/${kb_name}/mcp?api-version=2025-11-01-preview"
  echo
  echo "── ${label} (${kb_name}) ──"
  echo "GET ${url}"
  local code
  code="$(curl -s -o /tmp/mcp_probe.txt -w '%{http_code}' "${url}" || echo 000)"
  echo "HTTP ${code}"
  case "${code}" in
    401|403)
      echo "OK: endpoint exists; auth is required (expected). Whether AAD is actually enabled"
      echo "    is determined by Section 7 below — not by this code."
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
      echo "  - AAD auth is disabled at the service level"
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

# ---- 8. Authenticated POST to MCP endpoints (user token) -----------
#
# Section 7 only proves the LIST endpoint works with AAD. The
# agents talk to a different code path: POST to `/mcp` with an
# MCP JSON-RPC body. If section 7 succeeds but this section
# fails, the issue is MCP-specific (likely a missing service-level
# capability for agentic retrieval).

probe_mcp_authenticated() {
  # probe_mcp_authenticated <label> <kb-name>
  local label="$1" kb_name="$2"
  local url="${SEARCH_EP}/knowledgebases/${kb_name}/mcp?api-version=2025-11-01-preview"
  echo
  echo "── ${label} (${kb_name}) ──"
  echo "POST ${url}"
  echo "(MCP tools/list with the user's bearer token)"
  local code
  code="$(curl -s -o /tmp/mcp_auth_probe.txt -w '%{http_code}' \
    -X POST \
    -H "Authorization: Bearer ${USER_TOKEN}" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    --data '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' \
    --max-time 30 \
    "${url}" || echo 000)"
  echo "HTTP ${code}"
  case "${code}" in
    200|202)
      echo "OK: MCP endpoint accepts AAD auth + the user has the right role for the MCP code path."
      echo "    If agents still 403 here, the issue is specifically the project MI's token."
      echo "    First 300 chars of response:"
      head -c 300 /tmp/mcp_auth_probe.txt
      echo
      ;;
    401|403)
      echo "FAIL: MCP endpoint rejects the user's token even though section 7 succeeded."
      echo "    The MCP code path has additional requirements beyond /knowledgebases."
      echo "    Body:"
      cat /tmp/mcp_auth_probe.txt
      echo
      ;;
    404)
      echo "FAIL: KB '${kb_name}' missing from the service (re-run the seeder)."
      ;;
    000)
      echo "Probe timed out or unreachable."
      ;;
    *)
      echo "Unexpected ${code}. Body (first 500 chars):"
      head -c 500 /tmp/mcp_auth_probe.txt
      echo
      ;;
  esac
}

print_section "8. Authenticated MCP probe (user token, POST tools/list)"
if [ -n "${USER_TOKEN}" ]; then
  probe_mcp_authenticated "detection-rules" "${KB_NAME}"
  if [ -n "${CCK_KB_NAME}" ]; then
    probe_mcp_authenticated "company-context" "${CCK_KB_NAME}"
  fi
else
  echo "Skipped (no user token)."
fi

# ---- Summary -------------------------------------------------------

print_section "Summary — authoritative interpretation"
cat <<EOF
Read the sections in this order — each one rules out a layer:

A. Section 7 (authenticated KB list with the user's token):
   - 200 → AAD auth IS enabled, user role IS effective. ✓
   - 401/403 → AAD disabled OR user role missing/propagating.
       Fix the Search service's authentication_failure_mode AND
       check section 4 for the user's role assignment.

B. Section 8 (authenticated MCP POST with the user's token):
   - 200/202 → MCP code path works with AAD; the per-KB endpoint
       accepts authenticated requests. If agents still 403, the
       problem is specifically the project MI's token (section
       4 should show its role; if missing, run
       ./scripts/deploy_prompt_agents_with_runner_tools.sh).
   - 401/403 → MCP code path has additional requirements beyond
       Section 7. This is the rarest failure; most likely a
       service-level agentic-retrieval feature flag.

C. Section 4 (RBAC inventory):
   - Missing project MI → run
       ./scripts/deploy_prompt_agents_with_runner_tools.sh

D. Section 5 (connection records):
   - authType ≠ ProjectManagedIdentity → same script as C.

E. Section 6 (unauth reachability):
   - 404 → KB doesn't exist; re-run the seeder.
   - 401/403 alone are NOT diagnostic for AAD-enabled status —
     ignore the unauth code unless you see 404. Section 7 is
     authoritative.

F. After fixing anything, Foundry caches failed agent-chat state
   for ~60s. Start a NEW chat instead of retrying the existing one.
EOF
