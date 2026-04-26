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
#   - az account set -s <SUBSCRIPTION_ID>      (the sub you want everything in)
#   - terraform >= 1.6
#   - gh CLI authenticated to github.com (`gh auth login`)
#
# GitHub Actions auth: this script uses **OIDC federated credentials**,
# not a long-lived secret — see the "OIDC bootstrap" step below. No
# `AZURE_CREDENTIALS` secret needed; the deploy works fine when the
# repo is public.
#
# Usage:
#   ./deploy_aisoc_demo.sh [--key=value]...
#   ./deploy_aisoc_demo.sh --help
#
# Any --key=value is forwarded as TF_VAR_<key> across all phases.
# Terraform silently ignores TF_VAR_<x> if x isn't declared in that
# phase's module, so you can pass a Phase-1-only var like
# --admin-password=... without it bleeding into Phase 2/3.
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

# ── Argument parsing ─────────────────────────────────────────────────
usage() {
  cat <<'EOF'
Usage: ./deploy_aisoc_demo.sh [options]

Walks the three Terraform phases, triggers function-app code workflows,
runs Foundry bootstrap, deploys PixelAgents Web. Idempotent.

Common Terraform variables (Phase 1):
  --admin-password=...        Lab VM admin password (REQUIRED, sensitive)
  --allowed-rdp-cidr=...      /32 CIDR allowed for RDP, e.g. 203.0.113.10/32
  --location=...              Azure region for Sentinel + lab VM (default: westus)
  --vm-size=...               Lab VM size (default: Standard_D2s_v3)
  --resource-group-name=...   Override the auto-generated RG name

Common Terraform variables (Phase 2):
  --location-override=...     Region for Function Apps (default: westcentralus)
  --foundry-location=...      Region for Foundry hub/project (default: eastus2)
  --foundry-model-choice=...  Model name (default: gpt-4.1-mini)
  --runner-image=...          Override runner image tag (default: :latest)

Other:
  --subscription=...          Azure subscription to deploy into
                              (defaults to current `az account show` selection)
  --skip-oidc-bootstrap       Skip the GitHub→Azure federated-credential setup
                              (use if you've already bootstrapped or are
                              re-running from a fresh shell)
  -h, --help                  show this help

Generic pass-through:
  Any unrecognized --key=value is forwarded as TF_VAR_<key>=<value>.
  Dashes in <key> are converted to underscores (--foo-bar -> TF_VAR_foo_bar).

Sensitive values:
  For passwords / API keys, prefer pre-setting TF_VAR_<name> in the
  environment so the value never lands in shell history or process
  listings. Pre-set env vars take precedence over --flag values.

Examples:
  # Minimal first-time deploy (auto-detect RDP CIDR, generate strong pw):
  TF_VAR_admin_password='S0meStr0ng!pw' ./deploy_aisoc_demo.sh \
      --allowed-rdp-cidr='203.0.113.10/32' --location=westus

  # Override Foundry region:
  ./deploy_aisoc_demo.sh \
      --admin-password='...' --allowed-rdp-cidr='...' \
      --foundry-location=swedencentral
EOF
}

declare -A USER_VARS=()
SUBSCRIPTION_OVERRIDE=""
SKIP_OIDC=0

# Convert --foo-bar to TF_VAR_foo_bar
add_var() {
  local key="$1" value="$2"
  local tf_name
  tf_name="$(echo "$key" | tr '-' '_')"
  USER_VARS["$tf_name"]="$value"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)              usage; exit 0 ;;
    --skip-oidc-bootstrap)  SKIP_OIDC=1; shift ;;
    --subscription=*)       SUBSCRIPTION_OVERRIDE="${1#*=}"; shift ;;
    --subscription)         [[ $# -ge 2 ]] || die "missing value for --subscription"
                            SUBSCRIPTION_OVERRIDE="$2"; shift 2 ;;
    --*=*)
      pair="${1#--}"; key="${pair%%=*}"; value="${pair#*=}"
      add_var "$key" "$value"
      shift
      ;;
    --*)
      key="${1#--}"
      [[ $# -ge 2 ]] || die "missing value for --$key (try --help)"
      add_var "$key" "$2"
      shift 2
      ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

# Export each as TF_VAR_<name>, but never clobber a value already set in
# the env (so users can pre-set sensitive values without putting them on
# the command line).
for k in "${!USER_VARS[@]}"; do
  envvar="TF_VAR_$k"
  if [[ -z "${!envvar:-}" ]]; then
    export "$envvar=${USER_VARS[$k]}"
  fi
done

# Optional subscription switch (must happen before any az/terraform calls).
if [[ -n "$SUBSCRIPTION_OVERRIDE" ]]; then
  az account set -s "$SUBSCRIPTION_OVERRIDE"
fi

# ── 0) Prereq checks ─────────────────────────────────────────────────
say "Checking prerequisites"

command -v az        >/dev/null 2>&1 || die "az CLI not found"
command -v terraform >/dev/null 2>&1 || die "terraform not found (need >= 1.6)"
command -v gh        >/dev/null 2>&1 || die "gh CLI not found"
command -v jq        >/dev/null 2>&1 || die "jq not found (used by Phase 1 Sentinel-rule deploy)"

az account show >/dev/null 2>&1 || die "az not logged in. Run: az login"
gh auth status -h github.com >/dev/null 2>&1 || die "gh not authenticated. Run: gh auth login"

ok "prereqs satisfied"

# ── 0a) OIDC bootstrap ───────────────────────────────────────────────
# Set up GitHub-Actions-to-Azure auth via OIDC (federated credentials),
# so the workflows never hold a long-lived secret. Idempotent: if the
# SP, federated credential, role assignment, and repo variables already
# exist this is a no-op.
if [[ "$SKIP_OIDC" == "1" ]]; then
  say "Skipping OIDC bootstrap (--skip-oidc-bootstrap)"
  SUBSCRIPTION_ID="$(az account show --query id -o tsv)"
else
say "Bootstrapping OIDC trust between GitHub and Azure"

OIDC_APP_NAME="${OIDC_APP_NAME:-aisoc-lab-gha}"
OIDC_BRANCH="${OIDC_BRANCH:-main}"
OIDC_FEDCRED_NAME="aisoc-lab-${OIDC_BRANCH}"
OIDC_SUBJECT="repo:${REPO}:ref:refs/heads/${OIDC_BRANCH}"

SUBSCRIPTION_ID="$(az account show --query id -o tsv)"
TENANT_ID="$(az account show --query tenantId -o tsv)"

# 1. Service principal (no password — we'll attach a federated credential).
APP_ID="$(az ad app list --display-name "$OIDC_APP_NAME" --query '[0].appId' -o tsv 2>/dev/null || true)"
if [[ -z "$APP_ID" ]]; then
  echo "  creating Azure AD app '$OIDC_APP_NAME'"
  APP_ID="$(az ad app create --display-name "$OIDC_APP_NAME" --query appId -o tsv)"
  az ad sp create --id "$APP_ID" >/dev/null
else
  echo "  Azure AD app '$OIDC_APP_NAME' already exists ($APP_ID)"
  # Make sure the SP shadow exists too — it can be missing if the app was created elsewhere.
  az ad sp show --id "$APP_ID" >/dev/null 2>&1 || az ad sp create --id "$APP_ID" >/dev/null
fi
SP_OBJECT_ID="$(az ad sp show --id "$APP_ID" --query id -o tsv)"

# 2. Federated credential pinning the trust to this repo + branch.
existing_fc="$(az ad app federated-credential list --id "$APP_ID" \
                 --query "[?name=='$OIDC_FEDCRED_NAME'].name" -o tsv 2>/dev/null || true)"
if [[ -z "$existing_fc" ]]; then
  echo "  creating federated credential subject=$OIDC_SUBJECT"
  az ad app federated-credential create --id "$APP_ID" --parameters "$(cat <<EOF
{
  "name": "$OIDC_FEDCRED_NAME",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "$OIDC_SUBJECT",
  "audiences": ["api://AzureADTokenExchange"]
}
EOF
)" >/dev/null
else
  echo "  federated credential '$OIDC_FEDCRED_NAME' already exists"
fi

# 3. Subscription-scoped Contributor (idempotent — `az role assignment create`
#    is a no-op if the assignment already exists, returns non-zero on conflict).
SCOPE="/subscriptions/$SUBSCRIPTION_ID"
echo "  ensuring Contributor role on $SCOPE"
az role assignment create \
  --assignee-object-id "$SP_OBJECT_ID" \
  --assignee-principal-type ServicePrincipal \
  --role Contributor \
  --scope "$SCOPE" \
  >/dev/null 2>&1 || true

# 4. Push the three IDs as repo variables (publicly visible — they're identifiers, not secrets).
echo "  syncing AZURE_CLIENT_ID / AZURE_TENANT_ID / AZURE_SUBSCRIPTION_ID to $REPO"
gh variable set AZURE_CLIENT_ID       --repo "$REPO" --body "$APP_ID"          >/dev/null
gh variable set AZURE_TENANT_ID       --repo "$REPO" --body "$TENANT_ID"       >/dev/null
gh variable set AZURE_SUBSCRIPTION_ID --repo "$REPO" --body "$SUBSCRIPTION_ID" >/dev/null

ok "OIDC trust ready (workflows will authenticate to subscription $SUBSCRIPTION_ID)"
fi  # SKIP_OIDC

# ── Pre-flight: required Phase 1 vars ────────────────────────────────
# admin_password has no default in Phase 1's variables.tf, so without
# tfvars or env/CLI it would prompt — and we run with -input=false.
if [[ -z "${TF_VAR_admin_password:-}" && ! -f "terraform/1-deploy-sentinel/terraform.tfvars" ]]; then
  die "admin_password is required for Phase 1.\n  Pass it via --admin-password='...', or set TF_VAR_admin_password in the env, or create terraform/1-deploy-sentinel/terraform.tfvars."
fi

apply_phase() {
  local dir="$1"
  # Vars come from (in priority order):
  #   1. Pre-set TF_VAR_* env vars and --flag args (already exported above)
  #   2. terraform.tfvars in $dir (if present — optional)
  #   3. variable defaults in the module
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
