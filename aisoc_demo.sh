#!/usr/bin/env bash
#
# aisoc_demo.sh — end-to-end deploy for the AISOC demo
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
#   ./aisoc_demo.sh deploy   [--key=value]...
#   ./aisoc_demo.sh destroy  [--key=value]...
#   ./aisoc_demo.sh --help
#
# The first argument is a subcommand:
#   deploy   — walk Phases 1 → 2 → 3 (build, configure, smoke-test)
#   destroy  — terraform destroy in reverse order (3 → 2 → 1)
#
# Configuration precedence (low → high):
#   1. variables.tf defaults inside each phase
#   2. ./aisoc.config (gitignored) — copy from aisoc.config.example
#   3. --flag=value on the CLI
#   4. Pre-set TF_VAR_* in the current shell (always wins)
#
# Any --key=value is forwarded as TF_VAR_<key> across all phases.
# Terraform silently ignores TF_VAR_<x> if x isn't declared in that
# phase's module, so a Phase-1-only var (e.g. --vm-size=...) won't
# bleed into Phase 2/3.
#
# To re-deploy a single phase, run terraform apply directly inside that
# phase's directory — null_resources will re-run the configure scripts.

set -euo pipefail

REPO="ErikVabu-Personal/aisoc-lab"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

# ── Output helpers ───────────────────────────────────────────────────
NC=$'\033[0m'; CYAN=$'\033[36m'; GREEN=$'\033[32m'; YELLOW=$'\033[33m'; RED=$'\033[31m'; BOLD=$'\033[1m'; BLUE=$'\033[34m'
say()  { printf '\n%s%s==> %s%s\n' "$BOLD" "$CYAN" "$*" "$NC"; }
ok()   { printf '%sOK: %s%s\n' "$GREEN" "$*" "$NC"; }
warn() { printf '%sWARN: %s%s\n' "$YELLOW" "$*" "$NC" >&2; }
die()  { printf '%sERROR: %s%s\n' "$RED" "$*" "$NC" >&2; exit 1; }

# ── Banner ──────────────────────────────────────────────────────────
# Two robot heads facing off — the offensive (red) agent vs the defensive
# (blue) agent, with a "VS" clash between them.
print_banner() {
  printf '\n'
  printf '     %s.------.%s               %s.------.%s\n'      "$RED" "$NC" "$BLUE" "$NC"
  printf '     %s|o    o|%s               %s|o    o|%s\n'      "$RED" "$NC" "$BLUE" "$NC"
  printf '   %s==| >  < |%s   %s>< VS ><%s   %s| >  < |==%s\n' "$RED" "$NC" "$BOLD" "$NC" "$BLUE" "$NC"
  printf '     %s| ____ |%s               %s| ____ |%s\n'      "$RED" "$NC" "$BLUE" "$NC"
  printf '     %s`------`%s               %s`------`%s\n'      "$RED" "$NC" "$BLUE" "$NC"
  printf '    %sRED offense%s           %sBLUE defense%s\n'    "$RED" "$NC" "$BLUE" "$NC"
  printf '\n'
  printf '%s%s       N V I S O   Agentic SOC  -  Red vs Blue%s\n' "$BOLD" "$CYAN" "$NC"
  printf '%s       autonomous offense clashes with defense%s\n\n' "$CYAN" "$NC"
}
print_banner

# ── Argument parsing ─────────────────────────────────────────────────
usage() {
  cat <<'EOF'
Usage: ./aisoc_demo.sh <command> [options]

Commands:
  deploy    Walk Phases 1 → 2 → 3 — Terraform applies, function-app
            code workflows, Foundry bootstrap, smoke-test print.
            Idempotent; safe to re-run. Add --onboard-goad to also run
            Phase 4 (attach an existing GOAD AD lab to Sentinel).
  destroy   Tear down all phases (Phase 3 → 2 → 1) via terraform
            destroy. Leaves the OIDC trust and AZURE_* repo
            variables in place so the next `deploy` is one command.
            5-second countdown before applying.

Common Terraform variables:
  --resource-group=...    Resource group to create / use in Azure
                          (default: aisoc-demo). Phase 1 creates
                          the RG with this name; Phases 2 & 3 deploy
                          into it.
  --azure-location=...    Azure region for the Sentinel workspace
                          (Phase 1, default: westus). Phase 2 deploys
                          to westcentralus by default — those two
                          together are the empirically-validated
                          combo for new subs whose other regions
                          have zero App Service / EP-series quota.
  --location-override=... Region for Phase 2 (App Service / Function
                          Apps). Default: westcentralus.
  --foundry-location=...  Region for Foundry hub/project/model
                          (default: eastus2 — Model Router is
                          region-gated to East US 2 / Sweden Central).

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
                              re-running from a fresh shell). Only meaningful
                              for the `deploy` command.
  --auto-region               Auto-pick ONE Azure region with capacity and deploy the
                              movable infra there (Sentinel + web apps + Function Apps +
                              GOAD/RedAmon), so you don't choose a region. Prefers West
                              Central US (the validated App Service region) when it has VM
                              capacity, else surveys for one that does (scripts/
                              azure_find_region.py). Foundry stays in its model-gated region
                              (Sweden Central / East US 2). If the resource group already
                              exists its region is kept (no move). Any region you set
                              explicitly still wins. The chosen region is printed in the
                              final summary. (Or AISOC_AUTO_REGION=1 in aisoc.config.)
  --onboard-goad              Also run Phase 4: onboard an EXISTING GOAD Active
                              Directory lab (already deployed with `goad.sh -p azure`)
                              into Sentinel — AMA + a GOAD-region DCR + Sysmon on its
                              VMs, AD analytic rules, and the AD KB runbooks. GOAD may
                              live in a different region than Phase 1 (see
                              --goad-location). Off by default.
                              (Or AISOC_ONBOARD_GOAD=1 in aisoc.config.)
  --deploy-goad               BUILD GOAD first, then onboard it (implies --onboard-goad).
                              Runs scripts/goad_azure_prep.py (region + Standard public
                              IP + capacity-safe VM sizes) → goad.sh install → auto-
                              discovers the hashed RG it created and feeds it to Phase 4.
                              Use on a fresh subscription so no manual goad.sh dance is
                              needed. GOAD is vendored in this repo (GOAD/), so no separate
                              checkout is required; takes a while. (Or AISOC_DEPLOY_GOAD=1
                              in aisoc.config.)
  --goad-clone=PATH           Override the GOAD checkout used by --deploy-goad
                              (default: the vendored ./GOAD, or AISOC_GOAD_CLONE).
  --goad-resource-group=...   GOAD's Azure resource group (its lab_identifier, e.g.
                              GOAD-aa6e32-goad-azure; default: GOAD). Used with
                              --onboard-goad / --with-redamon. Auto-discovered when
                              --deploy-goad builds GOAD, so you don't pass it then.
  --goad-location=...         Azure region GOAD is deployed in (must match goad.ini's
                              az_location, e.g. westus2). With --deploy-goad this is the
                              region GOAD is BUILT in. Phase 4 creates its DCR there and
                              Phase 5 picks a RedAmon VM size with capacity there.
                              Omit to reuse Phase 1's region (same-region onboarding).
  --with-redamon              Also run Phase 5: deploy RedAmon (AI red-team) into
                              GOAD's VNet (needs GOAD on Azure). The on-box install
                              runs in tmux; reach the UI via an SSH tunnel. SSH/UI
                              (22/3000) are auto-locked to your resolved public IP
                              unless you set admin_cidrs (--admin-cidrs='["a.b.c.d/32"]'
                              / TF_VAR_admin_cidrs / aisoc.config).
                              (Or AISOC_DEPLOY_REDAMON=1 in aisoc.config.)
  -h, --help                  show this help

Config file:
  ./aisoc.config (gitignored, optional). Sourced before CLI parsing so
  it acts as your baseline; --flag values override for the current run.
  Copy ./aisoc.config.example to get started — everything documented
  there: RG, regions, Foundry model, demo user roster, etc.

Generic pass-through:
  Any unrecognized --key=value is forwarded as TF_VAR_<key>=<value>.
  Dashes in <key> are converted to underscores (--foo-bar -> TF_VAR_foo_bar).

Sensitive values:
  For passwords / API keys, prefer pre-setting TF_VAR_<name> in the
  environment so the value never lands in shell history or process
  listings. Pre-set env vars take precedence over --flag values.

Examples:
  # Minimal first-time deploy:
  ./aisoc_demo.sh deploy \
      --resource-group=aisoc-demo --azure-location=westus

  # Override Foundry region:
  ./aisoc_demo.sh deploy \
      --resource-group=aisoc-demo \
      --azure-location=westus --foundry-location=swedencentral

  # Tear it all down:
  ./aisoc_demo.sh destroy
EOF
}

declare -A USER_VARS=()
SUBSCRIPTION_OVERRIDE=""
SKIP_OIDC=0
ONBOARD_GOAD=0
DEPLOY_GOAD=0
DEPLOY_REDAMON=0
AUTO_REGION=0
AUTO_REGION_CHOSEN=""
GOAD_CLONE=""
ACTION=""

# Snapshot which TF_VAR_* the operator had set in their shell BEFORE
# this script ran, AND what value each one held. These are the
# highest-precedence values: nothing CLI or aisoc.config can override
# them. The classic pattern is:
#
#   TF_VAR_soc_key=xxx ./aisoc_demo.sh deploy --resource-group=rg
#
# where the secret is set in the shell (kept out of CLI history /
# aisoc.config) and the CLI sets the rest.
#
# Why we capture VALUES not just names: aisoc.config below uses
# `source`, which lets a `TF_VAR_x=...` line in the file silently
# overwrite the shell-preset value. After sourcing we restore the
# snapshotted values, so the shell wins regardless of what
# aisoc.config tries to do.
declare -A PRE_SHELL_TF_VARS=()
while IFS='=' read -r _name _value; do
  if [[ "$_name" == TF_VAR_* ]]; then
    PRE_SHELL_TF_VARS["$_name"]="$_value"
  fi
done < <(env)
unset _name _value

# Source aisoc.config (gitignored) if present, so the user can keep
# their TF_VAR_* + AISOC_* defaults in one place at the repo root
# instead of scattered tfvars files. CLI flags parsed below override
# these values for the current run; pre-shell env vars (snapshot
# above) still win over both.
if [[ -f "$ROOT/aisoc.config" ]]; then
  # shellcheck disable=SC1091
  source "$ROOT/aisoc.config"
  echo "Loaded $ROOT/aisoc.config" >&2
fi

# Restore shell-preset TF_VAR_* values that aisoc.config might have
# clobbered during `source`. After this, anything left in the env is
# either shell-preset (= the snapshotted value) or aisoc.config-set
# (= up for grabs by the CLI loop below).
for _name in "${!PRE_SHELL_TF_VARS[@]}"; do
  export "$_name=${PRE_SHELL_TF_VARS[$_name]}"
done
unset _name
# aisoc.config can set its own deploy-script-level knobs:
#   AISOC_SKIP_OIDC=1                 -> skip OIDC bootstrap
#   AISOC_GITHUB_REPO=<owner>/<repo>  -> override the GitHub repo
#   AZURE_SUBSCRIPTION_OVERRIDE=<id>  -> switch subscription
[[ "${AISOC_SKIP_OIDC:-0}" == "1" ]] && SKIP_OIDC=1
[[ "${AISOC_ONBOARD_GOAD:-0}" == "1" ]] && ONBOARD_GOAD=1
[[ "${AISOC_DEPLOY_GOAD:-0}" == "1" ]] && { DEPLOY_GOAD=1; ONBOARD_GOAD=1; }
[[ "${AISOC_DEPLOY_REDAMON:-0}" == "1" ]] && DEPLOY_REDAMON=1
[[ "${AISOC_AUTO_REGION:-0}" == "1" ]] && AUTO_REGION=1
[[ -n "${AISOC_GOAD_CLONE:-}" ]] && GOAD_CLONE="$AISOC_GOAD_CLONE"
[[ -n "${AISOC_GITHUB_REPO:-}" ]] && REPO="$AISOC_GITHUB_REPO"
[[ -n "${AZURE_SUBSCRIPTION_OVERRIDE:-}" ]] && SUBSCRIPTION_OVERRIDE="$AZURE_SUBSCRIPTION_OVERRIDE"

# First positional arg is the subcommand: deploy or destroy.
# Allow --help / -h before the subcommand for convenience.
if [[ $# -ge 1 ]]; then
  case "$1" in
    deploy|destroy)  ACTION="$1"; shift ;;
    -h|--help)       usage; exit 0 ;;
    *)               die "first argument must be 'deploy' or 'destroy' (got: '$1'). Try --help." ;;
  esac
fi
[[ -z "$ACTION" ]] && { usage >&2; exit 2; }

# Convert --foo-bar to TF_VAR_foo_bar
add_var() {
  local key="$1" value="$2"
  local tf_name
  tf_name="$(echo "$key" | tr '-' '_')"
  USER_VARS["$tf_name"]="$value"
}

# Friendly alias: --resource-group=<name> maps to Phase 1's variable
# `resource_group_name`. Phase 1 creates the RG with that name;
# Phases 2 and 3 inherit it via Phase 1's remote-state output.
set_resource_group() {
  USER_VARS["resource_group_name"]="$1"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help)              usage; exit 0 ;;
    --skip-oidc-bootstrap)  SKIP_OIDC=1; shift ;;
    --auto-region)          AUTO_REGION=1; shift ;;
    --no-auto-region)       AUTO_REGION=0; shift ;;
    --onboard-goad)         ONBOARD_GOAD=1; shift ;;
    --deploy-goad)          DEPLOY_GOAD=1; ONBOARD_GOAD=1; shift ;;
    --goad-clone=*)         GOAD_CLONE="${1#*=}"; shift ;;
    --goad-clone)           [[ $# -ge 2 ]] || die "missing value for --goad-clone"
                            GOAD_CLONE="$2"; shift 2 ;;
    --with-redamon)         DEPLOY_REDAMON=1; shift ;;
    --subscription=*)       SUBSCRIPTION_OVERRIDE="${1#*=}"; shift ;;
    --subscription)         [[ $# -ge 2 ]] || die "missing value for --subscription"
                            SUBSCRIPTION_OVERRIDE="$2"; shift 2 ;;
    --resource-group=*)     set_resource_group "${1#*=}"; shift ;;
    --resource-group)       [[ $# -ge 2 ]] || die "missing value for --resource-group"
                            set_resource_group "$2"; shift 2 ;;
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

# Export each CLI-supplied value as TF_VAR_<name>. Precedence:
#   1. (highest) Pre-shell env vars — captured in PRE_SHELL_TF_VARS
#      above. We never clobber these so sensitive values can stay
#      out of CLI history / aisoc.config.
#   2. CLI flags — override aisoc.config (this loop).
#   3. (lowest) aisoc.config — applied via `source` above.
#
# Anything in the env that's NOT in PRE_SHELL_TF_VARS came from
# sourcing aisoc.config — those should yield to the CLI value. The
# bare `${!envvar:-}` check we used to do conflated the two,
# accidentally letting aisoc.config beat the CLI.
for k in "${!USER_VARS[@]}"; do
  envvar="TF_VAR_$k"
  if [[ -n "${PRE_SHELL_TF_VARS[$envvar]:-}" ]]; then
    continue  # operator's shell wins
  fi
  export "$envvar=${USER_VARS[$k]}"
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

# ── DESTROY mode ─────────────────────────────────────────────────────
# Tear down the lab in reverse order. We don't touch the OIDC trust
# (federated cred + repo vars) — those are stateless config a re-deploy
# would just re-write, and keeping them lets the next deploy be a
# one-liner.
if [[ "$ACTION" == "destroy" ]]; then
  warn "DESTROY mode: about to run \`terraform destroy\` in Phase 3, then 2, then 1."
  warn "All Azure resources created by the demo will be removed."
  warn "Press Ctrl-C now to abort. Continuing in 5 seconds..."
  sleep 5

  destroy_phase() {
    local dir="$1"
    say "Destroying: $dir"
    if [[ ! -d "$dir/.terraform" ]]; then
      warn "$dir is not initialized (.terraform/ missing) — skipping"
      return 0
    fi
    # init -upgrade reconciles the lock file in case providers were
    # added since the last apply (e.g. we added null_resource blocks
    # which require hashicorp/null). Without this, destroy fails with
    # "Inconsistent dependency lock file".
    ( cd "$dir" && terraform init -upgrade -input=false && terraform destroy -auto-approve -input=false )
  }

  # Foundry hub (Microsoft.CognitiveServices/accounts) can't be deleted
  # while it has child projects. The project is created out-of-band by
  # deploy_foundry_project.sh, so Terraform doesn't manage it. Delete
  # it via ARM before terraform destroy reaches the hub.
  pre_destroy_phase2_cleanup() {
    local sub rg hub proj
    sub="$( cd terraform/2-deploy-aisoc && terraform output -raw subscription_id 2>/dev/null || true )"
    rg="$(  cd terraform/2-deploy-aisoc && terraform output -raw resource_group   2>/dev/null || true )"
    hub="$( cd terraform/2-deploy-aisoc && terraform output -raw foundry_hub_name 2>/dev/null || true )"
    proj="$(cd terraform/2-deploy-aisoc && terraform output -raw foundry_project_name 2>/dev/null || true )"

    if [[ -z "$sub" || -z "$rg" || -z "$hub" || -z "$proj" ]]; then
      warn "Couldn't resolve Foundry hub/project from terraform output — skipping pre-destroy project cleanup."
      warn "If the destroy fails with 'Cannot delete resource while nested resources exist',"
      warn "delete the project manually: az rest --method delete --url '...projects/<name>?api-version=2025-06-01'"
      return 0
    fi

    local url="https://management.azure.com/subscriptions/$sub/resourceGroups/$rg/providers/Microsoft.CognitiveServices/accounts/$hub/projects/$proj?api-version=2025-06-01"
    say "Pre-destroy: removing Foundry project '$proj' (nested under hub '$hub')"
    if az rest --method delete --url "$url" --only-show-errors >/dev/null 2>&1; then
      ok "Foundry project deleted"
    else
      warn "Foundry project delete returned non-zero (may already be gone) — continuing"
    fi
  }

  # Phases 4 (GOAD onboarding) and 5 (RedAmon) are optional and hang off the
  # GOAD deployment (Phase 4 attaches to Phase 1's DCR + GOAD's VMs; Phase 5's VM
  # sits in GOAD's VNet). Tear them down FIRST — before Phase 1 removes the
  # workspace/DCR, and BEFORE destroying GOAD itself (`goad.sh -p azure` destroy),
  # since both reference GOAD resources. destroy_phase self-skips if never applied.
  destroy_phase terraform/5-deploy-redamon
  destroy_phase terraform/4-onboard-goad
  destroy_phase terraform/3-deploy-pixelagents-web
  pre_destroy_phase2_cleanup
  destroy_phase terraform/2-deploy-aisoc
  destroy_phase terraform/1-deploy-sentinel

  printf '\n%s%s═════════════════════════ Demo torn down ═════════════════════════%s\n' "$BOLD" "$GREEN" "$NC"
  printf '  All three Terraform phases are destroyed.\n'
  printf '  OIDC trust + AZURE_* repo variables are preserved.\n'
  printf '  Run ./aisoc_demo.sh to redeploy when ready.\n\n'
  exit 0
fi

# ── 0a) OIDC bootstrap ───────────────────────────────────────────────
# Set up GitHub-Actions-to-Azure auth via OIDC (federated credentials),
# so the workflows never hold a long-lived secret. Idempotent: if the
# SP, federated credential, role assignment, and repo variables already
# exist this is a no-op.
OIDC_STATUS=""
if [[ "$SKIP_OIDC" == "1" ]]; then
  say "Skipping OIDC bootstrap (--skip-oidc-bootstrap)"
  SUBSCRIPTION_ID="$(az account show --query id -o tsv)"
  TENANT_ID="$(az account show --query tenantId -o tsv)"
  OIDC_STATUS="skipped (--skip-oidc-bootstrap)"
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
OIDC_STATUS="bootstrapped (subject=$OIDC_SUBJECT)"
fi  # SKIP_OIDC

# ── Plan summary ─────────────────────────────────────────────────────
# Show the user exactly what's about to happen before any terraform
# apply runs — subscription, RG, region, model choice, etc. Values are
# resolved from CLI flags / env vars (TF_VAR_*) with the variable
# defaults from each phase's variables.tf as fallbacks.
print_plan_summary() {
  local rg="${TF_VAR_resource_group_name:-aisoc-demo}"
  local region="${TF_VAR_azure_location:-westus}"
  local phase2_region="${TF_VAR_location_override:-westcentralus}"
  local foundry_region="${TF_VAR_foundry_location:-eastus2}"
  local foundry_model="${TF_VAR_foundry_model_choice:-claude-opus-5-5}"
  local sub_name
  sub_name="$(az account show --query name -o tsv 2>/dev/null || echo '?')"

  printf '\n%s%s── Deploy plan ──────────────────────────────────────────────────────%s\n' "$BOLD" "$CYAN" "$NC"
  printf '  Subscription      : %s (%s)\n' "$SUBSCRIPTION_ID" "$sub_name"
  printf '  Tenant            : %s\n' "$TENANT_ID"
  printf '  Resource group    : %s   [Phase 1 will create / use]\n' "$rg"
  printf '  Phase 1 region    : %s   [Sentinel + Maison Miró]\n' "$region"
  printf '  Phase 2 region    : %s   [App Service / Function Apps]\n' "$phase2_region"
  printf '  Foundry region    : %s   [hub + project + model]\n' "$foundry_region"
  printf '  Foundry model     : %s\n' "$foundry_model"
  printf '  GitHub repo       : %s\n' "$REPO"
  printf '  OIDC              : %s\n' "$OIDC_STATUS"
  printf '%s%s─────────────────────────────────────────────────────────────────────%s\n' "$BOLD" "$CYAN" "$NC"

  # Detect any per-phase var files Terraform auto-loads (all four
  # variants — terraform.tfvars, terraform.tfvars.json, *.auto.tfvars,
  # *.auto.tfvars.json). With the apply path now passing every
  # TF_VAR_* as an explicit -var flag, these can't silently override
  # the banner anymore — but listing them keeps the user informed
  # about what variables are still being layered in for everything
  # NOT covered by an env var.
  local tfvars_files=()
  for d in terraform/1-deploy-sentinel terraform/2-deploy-aisoc terraform/3-deploy-pixelagents-web; do
    while IFS= read -r -d '' f; do
      tfvars_files+=("$f")
    done < <(find "$d" -maxdepth 1 -type f \( \
                -name "terraform.tfvars" \
                -o -name "terraform.tfvars.json" \
                -o -name "*.auto.tfvars" \
                -o -name "*.auto.tfvars.json" \
              \) -print0 2>/dev/null)
  done
  if [[ ${#tfvars_files[@]} -gt 0 ]]; then
    warn "These per-phase var files are present and will be auto-loaded by Terraform"
    warn "(values from --flags / aisoc.config / shell env take precedence — these layer in below them):"
    for f in "${tfvars_files[@]}"; do printf '  - %s\n' "$f" >&2; done
  fi
  printf '\n'
}

apply_phase() {
  local dir="$1"

  # The variables THIS phase's root module declares. We only promote a TF_VAR_*
  # to an explicit -var when the phase declares it. Terraform ERRORS on an
  # undeclared variable passed via -var (whereas it silently IGNORES an
  # undeclared TF_VAR_* env var), so a phase-specific var set globally — e.g.
  # location_override (Phase 2 only), goad_location / goad_resource_group
  # (Phase 4/5), azure_location (Phase 1 only) — would otherwise break every
  # phase that doesn't declare it.
  local declared
  declared="$(grep -hoE '^[[:space:]]*variable[[:space:]]+"[^"]+"' "$dir"/*.tf 2>/dev/null \
                | sed -E 's/.*"([^"]+)".*/\1/' | sort -u)"

  # Build a -var arg for every DECLARED TF_VAR_* in the env. Why explicit -var
  # instead of relying on TF_VAR_*? Terraform's precedence is (lowest to highest):
  #   variable defaults < terraform.tfvars < *.auto.tfvars
  #     < TF_VAR_* env vars < -var / -var-file (CLI)
  # …so a stale terraform.tfvars in the phase dir SILENTLY OVERRIDES an env var.
  # Promoting the env vars to -var puts them at the top of the chain and matches
  # what print_plan_summary tells the user.
  local -a var_args=()
  while IFS='=' read -r _name _value; do
    if [[ "$_name" == TF_VAR_* ]]; then
      local _var="${_name#TF_VAR_}"
      if grep -qxF "$_var" <<<"$declared"; then
        var_args+=("-var" "${_var}=${_value}")
      fi
    fi
  done < <(env)

  ( cd "$dir" \
      && terraform init -upgrade -input=false \
      && terraform apply -auto-approve -input=false "${var_args[@]}" )
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

  # `gh run watch` polls the GitHub API and dies on a transient 5xx (e.g.
  # "failed to get jobs: HTTP 502"), which would abort an otherwise-healthy
  # deploy. Retry the watch on such drops, but decide success/failure from the
  # run's REAL conclusion — so a flaky API call never fails a good run, and a
  # genuinely failed run still stops us.
  local watch_tries=0 status conclusion
  while :; do
    if gh run watch "$run_id" --repo "$REPO" --exit-status; then
      break
    fi
    status="$(gh run view "$run_id" --repo "$REPO" --json status -q '.status' 2>/dev/null || echo '')"
    conclusion="$(gh run view "$run_id" --repo "$REPO" --json conclusion -q '.conclusion' 2>/dev/null || echo '')"
    if [[ "$status" == "completed" ]]; then
      if [[ "$conclusion" == "success" ]]; then
        break
      fi
      die "$workflow failed (conclusion: ${conclusion:-unknown}) — gh run view $run_id --repo $REPO --log-failed"
    fi
    watch_tries=$((watch_tries + 1))
    if (( watch_tries >= 8 )); then
      die "lost the GitHub run-watch for $workflow after $watch_tries retries (run still '${status:-unknown}') — check: gh run view $run_id --repo $REPO"
    fi
    echo "  run-watch dropped (run is '${status:-unknown}', likely a transient GitHub API error) — retrying in 15s [$watch_tries/8]"
    sleep 15
  done
  ok "$workflow completed"
}

# ── 0c) Auto-region (optional) — one capacity region for the movable infra ──
# Gated behind --auto-region / AISOC_AUTO_REGION=1. On a FRESH deploy, pick a region
# with VM capacity (preferring West Central US, which is also the validated App
# Service region) and pin Sentinel + web apps + Function Apps + GOAD/RedAmon to it —
# the operator chooses nothing. Foundry stays in its model-gated region (Sweden
# Central / East US 2); Azure requires that. If the resource group already exists we
# keep the existing phase regions (never move deployed resources). Any region set
# explicitly (--azure-location / --location-override / --goad-location) still wins.
if [[ "$AUTO_REGION" == "1" ]]; then
  _arg_rg="${TF_VAR_resource_group_name:-aisoc-demo}"
  if _ex_region="$(az group show -n "$_arg_rg" --query location -o tsv 2>/dev/null)" && [[ -n "$_ex_region" ]]; then
    say "Auto-region: ${_arg_rg} already exists in ${_ex_region} — reusing it (no move)."
    # Pin the phases to the existing RG's region so a re-run stays consistent and
    # doesn't fall back to per-phase defaults (which would fight the existing RG,
    # e.g. try to relocate/replace it back to westus).
    [[ -z "${TF_VAR_azure_location:-}" ]]    && export TF_VAR_azure_location="$_ex_region"
    [[ -z "${TF_VAR_location_override:-}" ]] && export TF_VAR_location_override="$_ex_region"
    [[ -z "${TF_VAR_goad_location:-}" ]]     && export TF_VAR_goad_location="$_ex_region"
    AUTO_REGION_CHOSEN="${_ex_region} (existing RG)"
  elif [[ -z "${TF_VAR_azure_location:-}" ]]; then
    say "Auto-region: detecting a capacity region (preferring West Central US for App Service)…"
    _pick="$(python3 scripts/azure_find_region.py --prefer westcentralus 2>/dev/null | tail -n1 || true)"
    if [[ "$_pick" =~ ^[a-z][a-z0-9]+$ ]]; then
      [[ -z "${TF_VAR_azure_location:-}" ]]    && export TF_VAR_azure_location="$_pick"
      [[ -z "${TF_VAR_location_override:-}" ]] && export TF_VAR_location_override="$_pick"
      [[ -z "${TF_VAR_goad_location:-}" ]]     && export TF_VAR_goad_location="$_pick"
      AUTO_REGION_CHOSEN="$_pick"
      ok "Auto-region: ${_pick} for Sentinel + web + Function Apps + GOAD/RedAmon (Foundry stays ${TF_VAR_foundry_location:-eastus2})"
    else
      warn "Auto-region: detection returned no region — using per-phase defaults."
    fi
  else
    say "Auto-region: azure_location set explicitly (${TF_VAR_azure_location}) — respecting it."
    AUTO_REGION_CHOSEN="${TF_VAR_azure_location} (explicit)"
  fi
fi

# Print the plan AFTER auto-region so its region lines reflect the chosen region.
print_plan_summary

# ── 1) Phase 1 — Sentinel + RG + Maison Miró + analytic rules ────────
say "Phase 1: Sentinel + Maison Miró"
apply_phase terraform/1-deploy-sentinel
ok "Phase 1 applied (repo vars synced; Maison analytic rules deployed)"

# ── 2) Phase 2 — Foundry, Runner, Orchestrator, SOC Gateway ──────────
say "Phase 2: Foundry + Runner + Function Apps"

# Cap the primary Foundry model deployment's capacity to the model's AVAILABLE TPM
# quota. Foundry quotas are per-model: Anthropic Opus defaults LOW (e.g. 509k TPM in
# eastus2) vs 1000 for Sonnet/Haiku — so the 1500 default (tuned for gpt-4.1-mini)
# 400s with InsufficientQuota on a Claude Opus deployment. Best-effort: if the quota
# can't be read (e.g. OpenAI's gpt4.1-mini naming quirk — which has ample quota
# anyway) the requested value stands.
if command -v python3 >/dev/null 2>&1; then
  _fcap="$(python3 scripts/azure_foundry_capacity.py \
    --region "${TF_VAR_foundry_location:-eastus2}" \
    --model "${TF_VAR_foundry_model_choice:-claude-opus-5-5}" \
    --sku "${TF_VAR_foundry_model_sku_name:-GlobalStandard}" \
    --want "${TF_VAR_foundry_model_sku_capacity:-1500}" | tail -n1 || true)"
  if [[ "${_fcap:-}" =~ ^[0-9]+$ ]]; then
    export TF_VAR_foundry_model_sku_capacity="$_fcap"
    ok "Foundry model capacity: ${_fcap} (thousands TPM) for ${TF_VAR_foundry_model_choice:-claude-opus-5-5}"
  fi
fi

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

# Foundry workflow upsert is OPTIONAL.
#
# The script POSTs to the Foundry portal's internal nextgen API
# (https://ai.azure.com/nextgen/api/query). That endpoint expects a
# portal-session token, not the AAD token `az` mints — so it fails
# with 401 "LoginRequired" when called from a CLI/CI context.
#
# Critically, NOTHING in the production pipeline consumes this
# workflow definition: the orchestrator Function App calls Foundry
# agents directly via the Responses API. The "workflow" is purely a
# portal-visualization convenience for triggering the pipeline from
# the Foundry Studio UI.
#
# So: try it, but don't fail the deploy if it doesn't take.
WORKFLOW_DEPLOY_OK=1
if ! ( cd terraform/2-deploy-aisoc && ./scripts/deploy_foundry_workflow.sh ); then
  WORKFLOW_DEPLOY_OK=0
  warn "Foundry workflow upsert failed (portal nextgen API rejected the CLI token)."
  warn "This step is OPTIONAL — the orchestrator runs without a registered Foundry workflow."
  warn "If you want the workflow visible in Foundry Studio, deploy"
  warn "  terraform/2-deploy-aisoc/workflows/aisoc-incident-pipeline.yaml"
  warn "manually via the portal (Workflows → Import YAML)."
fi

if [[ "$WORKFLOW_DEPLOY_OK" == "1" ]]; then
  ok "Foundry project + agents + workflow seeded"
else
  ok "Foundry project + agents seeded (workflow registration skipped — see warning above)"
fi

# ── 5) Phase 3 — PixelAgents Web ─────────────────────────────────────
say "Phase 3: PixelAgents Web"
apply_phase terraform/3-deploy-pixelagents-web
ok "Phase 3 applied (runner + orchestrator wired with PIXELAGENTS_URL/TOKEN)"

# ── 5a2) GOAD build (optional) — prep + goad.sh + auto-discover its RG ─
# Gated behind --deploy-goad / AISOC_DEPLOY_GOAD=1 (which also sets ONBOARD_GOAD).
# Builds GOAD on Azure from scratch so a fresh subscription needs no manual
# goad.sh dance before Phase 4:
#   1. scripts/goad_azure_prep.py — goad.ini region + Standard public IP +
#      capacity-safe VM sizes (+ quota bump when AISOC_REQUEST_QUOTA=1).
#   2. goad.sh -t install …       — Orange Cyberdefense's own installer
#      (-m remote: GOAD's Windows VMs are private, only the jumpbox is public).
#   3. discover the hashed RG it created (GOAD-<hash>-goad-azure) and hand it to
#      Phase 4/5 as TF_VAR_goad_resource_group + TF_VAR_goad_location.
# GOAD's installer is long and can fail mid-way (capacity/ansible); on failure
# we surface its resume command and stop — nothing already built is destroyed.
if [[ "$DEPLOY_GOAD" == "1" ]]; then
  _goad_region="${TF_VAR_goad_location:-${TF_VAR_azure_location:-westus}}"
  # Default to the GOAD tree vendored into this repo (GOAD/), so no separate
  # ~/GOAD checkout is needed. --goad-clone / AISOC_GOAD_CLONE overrides it.
  _goad_clone="${GOAD_CLONE:-$ROOT/GOAD}"
  say "GOAD build: prep (${_goad_region}) + goad.sh install in ${_goad_clone}"

  [[ -d "$_goad_clone" ]] || die "GOAD checkout not found at ${_goad_clone} — clone https://github.com/Orange-Cyberdefense/GOAD (or pass --goad-clone=/path / AISOC_GOAD_CLONE)."
  [[ -x "$_goad_clone/goad.sh" ]] || die "${_goad_clone}/goad.sh missing or not executable — is that a GOAD checkout?"

  # GOAD generates an SSH private key (jumpbox) and chmods it 600; ssh REFUSES a
  # key that isn't 0600. On WSL's /mnt/c (DrvFs) chmod is a no-op WITHOUT the mount's
  # `metadata` option, so the key stays world-readable and ansible-over-the-jumpbox
  # dies "Permission denied (publickey)" — after the VMs are already up. Fail fast
  # (before the ~30-min VM deploy) with the fix.
  case "$_goad_clone" in
    /mnt/*)
      _pt="$_goad_clone/.goad_perm_test"
      ( : > "$_pt" ) 2>/dev/null && chmod 600 "$_pt" 2>/dev/null
      _pm="$(stat -c '%a' "$_pt" 2>/dev/null || true)"; rm -f "$_pt" 2>/dev/null || true
      if [[ -n "$_pm" && "$_pm" != "600" ]]; then
        die "GOAD is on a Windows mount (${_goad_clone}) where chmod doesn't stick (test file came back ${_pm}, not 600).
     ssh will reject GOAD's jumpbox key (it'll be 0777) and the ansible provisioning will fail.
     Fix — enable WSL 'metadata' so chmod works on /mnt/c, then re-run:
       printf '[automount]\\noptions = \"metadata\"\\n' | sudo tee -a /etc/wsl.conf
       (from a Windows PowerShell/cmd) wsl --shutdown      # then reopen WSL
     Or point --goad-clone / AISOC_GOAD_CLONE at a Linux-filesystem path (e.g. ~/GOAD)."
      fi
      ;;
  esac

  # 1. Prep GOAD's Azure provider (region, Standard public IP, capacity sizes).
  if command -v python3 >/dev/null 2>&1; then
    python3 scripts/goad_azure_prep.py --region "$_goad_region" --goad-clone "$_goad_clone" \
      ${AISOC_REQUEST_QUOTA:+--request-quota} \
      || warn "goad_azure_prep.py exited non-zero — continuing; goad.sh may then hit the capacity/quota issues it fixes"
  else
    warn "python3 not found — skipping GOAD prep (region/size/public-IP fixes)"
  fi

  # 2. Run GOAD's own installer (long-running).
  say "Running goad.sh install (this takes a while — Windows VMs + ansible over the jumpbox)…"
  if ! ( cd "$_goad_clone" && GOAD_ASSUME_YES=1 ./goad.sh -t install -l GOAD -p azure -m remote ); then
    die "goad.sh install failed. Fix the cause (often capacity/quota — check the portal), then
     RESUME the same workspace instead of starting over:
       (cd ${_goad_clone} && ./goad.sh -t install -l GOAD -p azure -m remote -i <hash>-goad-azure)
     then re-run this driver (a finished GOAD is picked up idempotently)."
  fi

  # 3. Discover the hashed RG goad.sh created. Prefer the newest local workspace
  #    dir (the one this install rendered) and verify it exists as an RG; else
  #    fall back to the sole goad-azure RG in this region.
  _goad_rg=""
  _goad_ws="$(ls -1dt "$_goad_clone"/workspace/*-goad-azure 2>/dev/null | head -1 || true)"
  if [[ -n "$_goad_ws" ]]; then
    _cand="GOAD-$(basename "$_goad_ws")"
    az group show -n "$_cand" >/dev/null 2>&1 && _goad_rg="$_cand"
  fi
  if [[ -z "$_goad_rg" ]]; then
    mapfile -t _rgs < <(az group list --query "[?location=='${_goad_region}' && ends_with(name, 'goad-azure')].name" -o tsv 2>/dev/null || true)
    [[ "${#_rgs[@]}" -eq 1 ]] && _goad_rg="${_rgs[0]}"
  fi
  [[ -n "$_goad_rg" ]] || die "GOAD built but its resource group couldn't be auto-discovered. Re-run with --goad-resource-group=GOAD-<hash>-goad-azure (az group list -o table | grep goad-azure)."

  export TF_VAR_goad_resource_group="$_goad_rg"
  export TF_VAR_goad_location="$_goad_region"
  ok "GOAD built in ${_goad_region}; Phase 4 will onboard RG ${_goad_rg}"
fi

# ── 5b) Phase 4 (optional) — onboard GOAD into Sentinel ──────────────
# Gated behind --onboard-goad / AISOC_ONBOARD_GOAD=1 (also set by --deploy-goad).
# GOAD must be deployed on Azure (via --deploy-goad above, or separately with
# goad.sh -p azure); it MAY be in a different region than Phase 1 — Phase 4
# creates its own DCR in GOAD's region (--goad-location). Attaches GOAD's Windows
# VMs and deploys the AD analytic rules; see terraform/4-onboard-goad/README.md.
if [[ "$ONBOARD_GOAD" == "1" ]]; then
  say "Phase 4: onboard GOAD (AD lab) into Sentinel"
  apply_phase terraform/4-onboard-goad
  ok "Phase 4 applied (GOAD hosts wired to the workspace; AD analytic rules deployed)"

  # Push the company-context KB so the agents pick up the AD runbooks
  # (12-goad-ad-attacks.md + the GOAD entry in 02-monitored-systems.md).
  # Best-effort: the storage account exists after Phase 2; if the upload
  # hiccups the deploy still succeeds and you can re-run it by hand.
  say "Uploading company-context KB (AD runbooks)"
  if ( cd terraform/2-deploy-aisoc/agents/company-context && ./upload_company_context.sh ); then
    ok "company-context KB uploaded (indexer picks it up within ~30 min)"
  else
    warn "company-context upload failed — run it by hand:"
    warn "  cd terraform/2-deploy-aisoc/agents/company-context && ./upload_company_context.sh"
  fi
fi

# ── 5c) Phase 5 (optional) — RedAmon attacker in the GOAD VNet ───────
# Gated behind --with-redamon / AISOC_DEPLOY_REDAMON=1. Requires GOAD on Azure
# (same VNet). The on-box RedAmon install runs in tmux on first boot; see
# terraform/5-deploy-redamon/README.md.
if [[ "$DEPLOY_REDAMON" == "1" ]]; then
  say "Phase 5: RedAmon (AI red-team) in the GOAD VNet"

  # Auto-lock RedAmon's SSH/UI (22 + 3000) to the operator's own public IP,
  # UNLESS admin_cidrs was set explicitly (pre-shell TF_VAR_admin_cidrs,
  # --admin-cidrs=..., or aisoc.config). The Terraform default is 0.0.0.0/0
  # (open); resolving a /32 via a public echo service is far safer and saves
  # passing the CIDR by hand. Best-effort: if resolution fails we warn and let
  # the (open) default stand rather than blocking the deploy.
  if [[ -z "${TF_VAR_admin_cidrs:-}" ]]; then
    _myip=""
    if command -v curl >/dev/null 2>&1; then
      for _svc in https://ifconfig.me https://api.ipify.org https://ipinfo.io/ip https://icanhazip.com; do
        _myip="$(curl -4 -fsS --max-time 5 "$_svc" 2>/dev/null | tr -d '[:space:]')" || true
        [[ "$_myip" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] && break
        _myip=""
      done
    else
      warn "curl not found — can't auto-resolve your public IP for the RedAmon NSG"
    fi
    if [[ -n "$_myip" ]]; then
      export TF_VAR_admin_cidrs="[\"${_myip}/32\"]"
      ok "Locked RedAmon SSH/UI (22/3000) to your public IP ${_myip}/32 (override: --admin-cidrs='[\"a.b.c.d/32\"]')"
    else
      warn "Couldn't resolve your public IP — RedAmon's NSG falls back to the Terraform default 0.0.0.0/0 (OPEN)."
      warn "  Re-run with --admin-cidrs='[\"YOUR.IP/32\"]' to lock it down."
    fi
  else
    ok "RedAmon SSH/UI locked to your configured admin_cidrs (${TF_VAR_admin_cidrs})"
  fi

  # Capacity/quota preflight — RedAmon deploys into GOAD's region, and fresh subs
  # often lack VM capacity or quota there for the hardcoded size. Auto-pick a size
  # that has both (best-effort; on any failure we fall back to the Terraform
  # default). Set AISOC_REQUEST_QUOTA=1 to also request auto-grantable bumps.
  _redamon_region="${TF_VAR_goad_location:-${TF_VAR_azure_location:-westus}}"
  if command -v python3 >/dev/null 2>&1; then
    _sz="$(python3 scripts/azure_preflight.py --region "$_redamon_region" ${AISOC_REQUEST_QUOTA:+--request-quota} | tail -n1 || true)"
    if [[ "${_sz:-}" == Standard_* ]]; then
      export TF_VAR_redamon_size="$_sz"
      ok "RedAmon size auto-selected for ${_redamon_region}: ${_sz}"
    else
      warn "RedAmon size preflight returned no size — using the Terraform default"
    fi
  fi
  apply_phase terraform/5-deploy-redamon
  ok "Phase 5 applied (RedAmon VM up; on-box install runs in tmux — tunnel to the UI, see below)"
fi

# ── 6) Completion summary ────────────────────────────────────────────
PIXEL_URL="$(cd terraform/3-deploy-pixelagents-web && terraform output -raw pixelagents_url)"
STORE_URL="$(cd terraform/1-deploy-sentinel && terraform output -raw maison_url)"

SEP='═════════════════════════════════════════════════════════════════════'
HR='─────────────────────────────────────────────────────────────────────'

printf '\n%s%s%s%s\n'   "$BOLD" "$GREEN" "$SEP" "$NC"
printf '%s%s        AISOC demo deployment complete — everything is live%s\n' \
                       "$BOLD" "$GREEN" "$NC"
printf '%s%s%s%s\n'   "$BOLD" "$GREEN" "$SEP" "$NC"

# ── The two URLs that matter most. Bold cyan so they pop. ──────────────
printf '\n  %sMaison Miró (store — web victim)%s\n' "$BOLD" "$NC"
printf '    %s%s%s%s\n'              "$BOLD" "$CYAN" "$STORE_URL" "$NC"
printf '\n  %sPixelAgents UI%s\n'      "$BOLD" "$NC"
printf '    %s%s%s%s\n'              "$BOLD" "$CYAN" "$PIXEL_URL"  "$NC"

# ── Regions this deploy used (so you always know where it landed). ─────
_r_sentinel="$(cd terraform/1-deploy-sentinel && terraform output -raw selected_location 2>/dev/null || echo "${TF_VAR_azure_location:-westus}")"
_r_funcs="${TF_VAR_location_override:-westcentralus}"
_r_foundry="${TF_VAR_foundry_location:-eastus2}"
printf '\n%s%s%s\n'   "$BLUE" "$HR" "$NC"
printf '  %sRegions%s\n' "$BOLD" "$NC"
printf '%s%s%s\n'     "$BLUE" "$HR" "$NC"
printf '  Sentinel + web apps:             %s\n' "$_r_sentinel"
if [[ -n "$_r_funcs" && "$_r_funcs" != "$_r_sentinel" ]]; then
  printf '  Function Apps:                   %s\n' "$_r_funcs"
else
  printf '  Function Apps:                   %s (same)\n' "$_r_sentinel"
fi
printf '  Foundry (model, region-locked):  %s\n' "$_r_foundry"
if [[ "$ONBOARD_GOAD" == "1" ]]; then
  printf '  GOAD + RedAmon:                  %s\n' "${TF_VAR_goad_location:-$_r_sentinel}"
fi
[[ -n "$AUTO_REGION_CHOSEN" ]] && printf '  %sauto-region: %s%s\n' "$GREEN" "$AUTO_REGION_CHOSEN" "$NC"

# ── GOAD onboarding (when --onboard-goad was used). ────────────────────
if [[ "$ONBOARD_GOAD" == "1" ]]; then
  GOAD_VMS="$(cd terraform/4-onboard-goad && terraform output -json onboarded_vms 2>/dev/null | jq -r 'join(", ")' 2>/dev/null || true)"
  printf '\n%s%s%s\n'   "$YELLOW" "$HR" "$NC"
  printf '  %sGOAD Active Directory lab (onboarded to Sentinel)%s\n'  "$BOLD" "$NC"
  printf '%s%s%s\n'     "$YELLOW" "$HR" "$NC"
  [[ -n "$GOAD_VMS" ]] && printf '  Hosts wired:  %s\n' "$GOAD_VMS"
  printf '  Verify:       Logs → %sHeartbeat | summarize by Computer%s\n' "$BOLD" "$NC"
  printf '  Attack it:    run a Kerberoast / password spray from an attacker box →\n'
  printf '                Sentinel incident → Triage → Investigator → Reporter.\n'
fi

# ── RedAmon (when --with-redamon was used). ────────────────────────────
if [[ "$DEPLOY_REDAMON" == "1" ]]; then
  RED_TUNNEL="$(cd terraform/5-deploy-redamon && terraform output -raw redamon_ui_tunnel 2>/dev/null || true)"
  printf '\n%s%s%s\n'   "$YELLOW" "$HR" "$NC"
  printf '  %sRedAmon (AI red-team, in the GOAD VNet)%s\n'  "$BOLD" "$NC"
  printf '%s%s%s\n'     "$YELLOW" "$HR" "$NC"
  [[ -n "$RED_TUNNEL" ]] && printf '  UI tunnel:    %s\n' "$RED_TUNNEL"
  printf '                then browse http://localhost:3000 (create admin, add an LLM key)\n'
  printf '  Install:      SSH in, then: sudo tmux attach -t redamon\n'
fi

# ── How to drive the demo. ─────────────────────────────────────────────
printf '\n%sNext steps%s\n' "$BOLD" "$NC"
printf '  1. Open Maison Miró and run an attack (SQLi login bypass, then hit\n'
printf '     /api/customers to trip the honeytoken).\n'
printf '  2. The Sentinel rules fire every 15 min. Once an incident is\n'
printf '     raised, open the PixelAgents UI and click "Run workflow"\n'
printf '     on the incident row to orchestrate triage → investigation\n'
printf '     → reporting.\n'

printf '\n%s%s%s%s\n\n' "$BOLD" "$GREEN" "$SEP" "$NC"
