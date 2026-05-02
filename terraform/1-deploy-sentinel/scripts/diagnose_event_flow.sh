#!/usr/bin/env bash
# diagnose_event_flow.sh — answer "are Windows events arriving in
# Sentinel?" without RDP'ing into the lab VM.
#
# Pipeline being checked, end to end:
#
#   Windows event source ──┐
#   (4624, 4625, Sysmon)   │
#                          ▼
#                       AMA agent ── DCR association ──> DCR ──> Log Analytics
#
# When events don't arrive, any one of those links may be the
# problem. This script walks each one and reports state, so you
# don't have to figure out which side of the pipe is broken.
#
# Read-only. Run from terraform/1-deploy-sentinel/.

set -euo pipefail
cd "$(dirname "$0")/.."

RG="$(terraform output -raw resource_group 2>/dev/null || echo "")"
VM="$(terraform output -raw vm_name        2>/dev/null || echo "")"
WS="$(terraform output -raw log_analytics_workspace_name 2>/dev/null || echo "")"
# `az monitor log-analytics query --workspace` wants the customer
# GUID (workspace id), NOT the ARM resource id. The two outputs in
# Phase 1 are similarly-named — pick the right one or every KQL
# call returns "BadRequest: not a valid GUID".
WSID="$(terraform output -raw log_analytics_workspace_workspace_id 2>/dev/null || echo "")"

if [[ -z "$RG" || -z "$VM" || -z "$WS" ]]; then
  echo "ERROR: terraform outputs missing — run from terraform/1-deploy-sentinel/." >&2
  echo "       Required: resource_group, vm_name, log_analytics_workspace_name." >&2
  exit 2
fi

echo "================================================================"
echo "  Windows event-flow diagnostic"
echo "================================================================"
echo "  Resource group:  ${RG}"
echo "  VM:              ${VM}"
echo "  Workspace:       ${WS}"
echo

# ── 1. VM running? ──────────────────────────────────────────────
echo "── [1] VM power state ─────────────────────────────────────────"
power_state="$(az vm get-instance-view -g "$RG" -n "$VM" \
  --query 'instanceView.statuses[?starts_with(code,`PowerState/`)].displayStatus | [0]' \
  -o tsv 2>/dev/null || echo "?")"
echo "  ${power_state}"
if [[ "$power_state" != "VM running" ]]; then
  echo "  ⚠ VM is not running — start it before continuing:"
  echo "      az vm start -g $RG -n $VM"
fi
echo

# ── 2. AMA + Sysmon extensions deployed and provisioned? ────────
echo "── [2] VM extensions ──────────────────────────────────────────"
az vm extension list -g "$RG" --vm-name "$VM" \
  --query "[?contains(['AzureMonitorWindowsAgent','InstallSysmon'], name)].{name:name, state:provisioningState, type:typePropertiesType}" \
  -o table 2>/dev/null || echo "  (unable to enumerate)"
echo
echo "  An AzureMonitorWindowsAgent extension in 'Succeeded' is required."
echo "  An InstallSysmon extension in 'Succeeded' is required for Sysmon."
echo "  Anything other than 'Succeeded' = follow-up needed (see step 7)."
echo

# ── 3. DCR + DCR association exist? ─────────────────────────────
echo "── [3] DCR + DCR association ──────────────────────────────────"
dcr_id="$(az monitor data-collection rule list -g "$RG" \
  --query "[?name=='dcr-${VM}'].id | [0]" -o tsv 2>/dev/null || echo "")"
if [[ -n "$dcr_id" ]]; then
  echo "  DCR exists: dcr-${VM}"
  # Show the active xpath queries — you can spot the Level=1..4
  # gotcha here without reading Terraform.
  echo "  Active xpath queries:"
  az monitor data-collection rule show --ids "$dcr_id" \
    --query 'dataSources.windowsEventLogs[0].xPathQueries' -o tsv 2>/dev/null \
    | sed 's/^/    /'
else
  echo "  ⚠ DCR 'dcr-${VM}' not found in $RG — terraform apply may have failed."
fi

assoc_count="$(az monitor data-collection rule association list \
  --resource "$(az vm show -g "$RG" -n "$VM" --query id -o tsv 2>/dev/null)" \
  --query 'length(@)' -o tsv 2>/dev/null || echo "0")"
echo "  DCR associations on this VM: ${assoc_count}"
echo

# ── 4. Workspace ingestion: any Event rows in the last hour? ────
echo "── [4] Sentinel — events in the last 1h ───────────────────────"
if [[ -z "$WSID" ]]; then
  echo "  ⚠ no workspace id output; can't query KQL."
else
  # `Event | summarize count() by Source` shows whether any Windows
  # channel is ingesting. If this returns 0 rows, AMA is not
  # forwarding ANYTHING (extension dead, RBAC, DCR not associated).
  q1='Event | where TimeGenerated > ago(1h) | summarize count() by Source | order by count_ desc'
  echo "  Query: Event | summarize count() by Source (last 1h)"
  az monitor log-analytics query --workspace "$WSID" --analytics-query "$q1" \
    -o table 2>/dev/null \
    | sed 's/^/    /' \
    || echo "    (query failed — check 'az login' + Log Analytics Reader role)"
fi
echo

# ── 5. The headline events: 4624 / 4625 in the last 1h ──────────
echo "── [5] 4624 (logon success) + 4625 (logon failure), last 1h ──"
if [[ -n "$WSID" ]]; then
  q2='Event | where TimeGenerated > ago(1h) | where Source == "Security" and EventID in (4624,4625) | summarize count() by EventID, Computer | order by EventID asc'
  az monitor log-analytics query --workspace "$WSID" --analytics-query "$q2" \
    -o table 2>/dev/null \
    | sed 's/^/    /' \
    || echo "    (query failed)"
  echo
  echo "  No rows = audit subcategory not firing (auditpol) OR DCR is"
  echo "  filtering out Level=0. After the fix:"
  echo "    1. terraform apply  (refreshes DCR + re-runs Sysmon CSE)"
  echo "    2. RDP into the VM, log out + back in (generate 4624 / 4634)"
  echo "    3. wait 5-15 min for AMA to subscribe and forward"
  echo "    4. re-run this script"
fi
echo

# ── 6. Sysmon — events in the last 1h ───────────────────────────
echo "── [6] Sysmon channel — events in the last 1h ────────────────"
if [[ -n "$WSID" ]]; then
  q3='Event | where TimeGenerated > ago(1h) | where Source == "Microsoft-Windows-Sysmon" | summarize count() by EventID | order by count_ desc'
  az monitor log-analytics query --workspace "$WSID" --analytics-query "$q3" \
    -o table 2>/dev/null \
    | sed 's/^/    /' \
    || echo "    (query failed)"
  echo
  echo "  No rows ≠ Sysmon broken. Check the InstallSysmon extension"
  echo "  state in step 2 — if 'Succeeded' but no events, the AMA"
  echo "  hasn't subscribed yet (give it 5-15 min after first apply)."
fi
echo

# ── 7. Quick-fix recipes ───────────────────────────────────────
cat <<'EOF'
── [7] Common fixes ─────────────────────────────────────────────

  Extension "InstallSysmon" provisioning state: Failed
    → Read the install log on the VM:
        type C:\ProgramData\AISOC\Sysmon\install.log
      Or via run-command without RDP:
        az vm run-command invoke -g <rg> -n <vm> --command-id RunPowerShellScript \
          --scripts 'Get-Content C:\ProgramData\AISOC\Sysmon\install.log'

  Extension "InstallSysmon" never re-runs after I patched the script
    → Fixed: settings now includes filemd5(install_sysmon.ps1) so a
      script edit forces re-deploy. Run `terraform apply` again.

  Step 4 shows rows for Application/System but not Security
    → Audit subcategory is off on the host. After step 7's
      re-deploy of InstallSysmon (which now runs auditpol), generate
      a logon event (RDP in, sign out, sign back in) and re-check.

  No Event rows in step 4 at all
    → DCR association is missing (step 3 shows 0) or AMA extension
      state ≠ Succeeded (step 2). Re-run terraform apply.
EOF
