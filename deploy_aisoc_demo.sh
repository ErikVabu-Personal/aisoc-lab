#!/usr/bin/env bash
#
# deploy_aisoc_demo.sh — end-to-end deploy for the AISOC demo
#
# Walks the three Terraform phases in order, triggers the function-app
# code-deploy workflows on GitHub, runs the Foundry bootstrap scripts,
# and prints the resulting URLs.
#
# Idempotent: every step is safe to re-run. If a step fails (e.g. the
# Sentinel rule's 10-minute table-readiness poll times out on a totally
# cold deploy), fix the cause and re-run the script — completed steps
# converge to a no-op.
#
# Prereqs (one-time per machine):
#   - az login
#   - az account set -s <SUBSCRIPTION_ID>
#   - terraform >= 1.6
#   - gh CLI authenticated to github.com (`gh auth login`)
#
# Prereqs (one-time per GitHub repo):
#   - AZURE_CREDENTIALS secret holding service-principal JSON
#     az ad sp create-for-rbac --name "aisoc-lab-gha" --role Contributor \
#       --scopes /subscriptions/<SUBSCRIPTION_ID> --sdk-auth | \
#       gh secret set AZURE_CREDENTIALS --repo ErikVabu-Personal/aisoc-lab
#
# Usage:
#   ./deploy_aisoc_demo.sh
#
# To re-deploy a single phase, run terraform apply directly inside that
# phase's directory — null_resources will re-run the configure scripts.

set -euo pipefail

REPO="ErikVabu-Personal/aisoc-lab"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# ── Output helpers ───────────────────────────────────────────────────
NC=$'\033[0m'; CYAN=$'\033[36m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; BOLD=$'\033[1m'
say()  { printf '\n%s%s==> %s%s\n' "$BOLD" "$CYAN" "$*" "$NC"; }
ok()   { printf '%sOK: %s%s\n' "$GREEN" "$*" "$NC"; }
warn() { printf '%sWARN: %s%s\n' "$YELLOW" "$*" "$NC" >&2; }
die()  { printf '%sERROR: %s%s\n' "$RED" "$*" "$NC" >&2; exit 1; }

# ── 0) Prereq checks ─────────────────────────────────────────────────
say "Checking prerequisites"

command -v az        >/dev/null 2>&1 || die "az CLI not found"
command -v terraform >/dev/null 2>&1 || die "terraform not found (need >= 1.6)"
command -v gh        >/dev/null 2>&1 || die "gh CLI not found"
command -v jq        >/dev/null 2>&1 || die "jq not found (used by Phase 1 Sentinel-rule deploy)"

az account show >/dev/null 2>&1 || die "az not logged in. Run: az login"
gh auth status -h github.com >/dev/null 2>&1 || die "gh not authenticated. Run: gh auth login"

if ! gh secret list --repo "$REPO" 2>/dev/null | grep -q '^AZURE_CREDENTIALS'; then
  warn "AZURE_CREDENTIALS secret not detected on $REPO."
  warn "If you haven't set it up yet, run:"
  warn "  az ad sp create-for-rbac --name aisoc-lab-gha --role Contributor \\"
  warn "    --scopes /subscriptions/<SUBSCRIPTION_ID> --sdk-auth | \\"
  warn "    gh secret set AZURE_CREDENTIALS --repo $REPO"
  warn "Continuing — Function App workflows will fail later if it's actually missing."
fi
ok "prereqs satisfied"

# ── Helper: bring up a tfvars file from the example, if one is missing ──
ensure_tfvars() {
  local dir="$1"
  if [[ -f "$dir/terraform.tfvars" ]]; then
    return 0
  fi
  if [[ ! -f "$dir/terraform.tfvars.example" ]]; then
    # No example to copy; assume defaults are fine.
    return 0
  fi
  cp "$dir/terraform.tfvars.example" "$dir/terraform.tfvars"
  die "$dir/terraform.tfvars created from template — edit it (set passwords, region, etc.) then re-run."
}

apply_phase() {
  local dir="$1"
  ensure_tfvars "$dir"
  ( cd "$dir" && terraform init -upgrade -input=false && terraform apply -auto-approve -input=false )
}

# Trigger a GHA workflow and wait for the resulting run to finish.
# Captures the latest run id before triggering, then waits for a NEW run
# id to appear so we don't accidentally watch a stale completed run.
trigger_and_wait_workflow() {
  local workflow="$1"
  say "Triggering workflow: $workflow"

  local before_id
  before_id="$(gh run list --workflow="$workflow" --repo "$REPO" --limit 1 \
               --json databaseId -q '.[0].databaseId // empty' 2>/dev/null || echo '')"

  gh workflow run "$workflow" --repo "$REPO"

  # Poll for ~90 s for a new run id to appear at the top of the list.
  local run_id="" deadline=$((SECONDS + 90))
  while [[ -z "$run_id" && $SECONDS -lt $deadline ]]; do
    sleep 3
    local latest
    latest="$(gh run list --workflow="$workflow" --repo "$REPO" --limit 1 \
              --json databaseId -q '.[0].databaseId // empty' 2>/dev/null || echo '')"
    if [[ -n "$latest" && "$latest" != "$before_id" ]]; then
      run_id="$latest"
    fi
  done

  [[ -z "$run_id" ]] && die "no new run appeared for $workflow after 90 s"
  echo "  watching run id: $run_id"
  gh run watch "$run_id" --repo "$REPO" --exit-status
  ok "$workflow completed"
}

# ── 1) Phase 1 — Sentinel + RG + Ship Control Panel + analytic rule ──
say "Phase 1: Sentinel + Ship Control Panel"
apply_phase terraform/1-deploy-sentinel
ok "Phase 1 applied (repo vars synced; auth-failures rule deployed)"

# ── 2) Phase 2 — Foundry, Runner, Orchestrator, SOC Gateway ──────────
say "Phase 2: Foundry + Runner + Function Apps"
apply_phase terraform/2-deploy-aisoc
ok "Phase 2 applied (Function Apps exist; runner is up; gateway key wired)"

# ── 3) Function App code deploys via GHA ─────────────────────────────
say "Deploying Function App code via GitHub Actions"
trigger_and_wait_workflow deploy-aisoc-orchestrator.yml
trigger_and_wait_workflow deploy-soc-gateway.yml
ok "Function App code deployed"

# ── 4) Foundry bootstrap (project + agents + workflow) ───────────────
say "Foundry bootstrap"
( cd terraform/2-deploy-aisoc && ./scripts/deploy_foundry_project.sh )
( cd terraform/2-deploy-aisoc && ./scripts/deploy_prompt_agents_with_runner_tools.sh )
( cd terraform/2-deploy-aisoc && ./scripts/deploy_foundry_workflow.sh )
ok "Foundry project + agents + workflow seeded"

# ── 5) Phase 3 — PixelAgents Web ─────────────────────────────────────
say "Phase 3: PixelAgents Web"
apply_phase terraform/3-deploy-pixelagents-web
ok "Phase 3 applied (runner + orchestrator wired with PIXELAGENTS_URL/TOKEN)"

# ── 6) Smoke-test info ───────────────────────────────────────────────
PIXEL_URL="$(cd terraform/3-deploy-pixelagents-web && terraform output -raw pixelagents_url)"
SHIPCP_URL="$(cd terraform/1-deploy-sentinel && terraform output -raw ship_control_panel_url)"
VM_IP="$(cd terraform/1-deploy-sentinel && terraform output -raw vm_public_ip 2>/dev/null || true)"

printf '\n%s%s═════════════════════════ Demo is live ═════════════════════════%s\n' "$BOLD" "$GREEN" "$NC"
printf '  PixelAgents UI:      %s\n' "$PIXEL_URL"
printf '  Ship Control Panel:  %s\n' "$SHIPCP_URL"
[[ -n "$VM_IP" ]] && printf '  Lab VM (RDP):        %s\n' "$VM_IP"
printf '\n'
printf 'To seed an incident:\n'
printf '  - Generate a few failed RDP attempts on the lab VM, OR\n'
printf '  - POST auth.login.failure events to the Ship Control Panel.\n'
printf '\nThe Sentinel rule fires every 15 minutes; once it raises an incident,\n'
printf 'open the PixelAgents UI and right-click the incident to orchestrate.\n\n'
