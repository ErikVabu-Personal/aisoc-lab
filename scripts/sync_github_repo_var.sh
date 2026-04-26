#!/usr/bin/env bash
set -euo pipefail

# Sync deploy targets into GitHub repository variables so the per-app
# workflows in .github/workflows/ know which Azure resources to deploy
# to. Called from Terraform null_resource at the end of each phase's
# apply.
#
# Why: the Azure resources have random suffixes, so static repo vars
# would drift. Reading them straight from `terraform output` and
# pushing into GitHub keeps the two in sync without manual setup.
#
# Inputs:
# - REPO env var: GitHub repo in 'owner/name' form (e.g. erikvabu-personal/aisoc-lab)
# - Any AISOC_* env vars: become repo variables of the same name
#
# Behaviour:
# - Skips silently with a warning if `gh` is missing or unauthenticated.
#   (We don't want to break terraform apply if the developer hasn't
#   logged into gh yet — they can `gh auth login` and re-apply.)
# - Empty values are skipped.
# - Otherwise: `gh variable set NAME --repo REPO --body VALUE`.

REPO="${REPO:-}"

if [[ -z "$REPO" ]]; then
  echo "ERROR: REPO env var must be set (e.g. erikvabu-personal/aisoc-lab)" >&2
  exit 2
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "WARN: gh CLI not found on PATH — skipping GitHub repo variable sync." >&2
  echo "      Install via https://cli.github.com/ then re-apply Terraform to sync." >&2
  exit 0
fi

if ! gh auth status -h github.com >/dev/null 2>&1; then
  echo "WARN: gh CLI is not authenticated to github.com — skipping repo variable sync." >&2
  echo "      Run \`gh auth login\` then re-apply Terraform to sync." >&2
  exit 0
fi

# Iterate AISOC_* env vars and push each as a repo variable.
synced=0
skipped=0
while IFS='=' read -r name _; do
  if [[ "$name" != AISOC_* ]]; then
    continue
  fi
  value="${!name}"
  if [[ -z "$value" ]]; then
    echo "  skip $name (empty)" >&2
    skipped=$((skipped+1))
    continue
  fi
  echo "  set  $name = $value" >&2
  if ! gh variable set "$name" --repo "$REPO" --body "$value" >/dev/null 2>&1; then
    echo "WARN: failed to set $name on $REPO (continuing)" >&2
    skipped=$((skipped+1))
    continue
  fi
  synced=$((synced+1))
done < <(env)

echo "OK: synced $synced GitHub repo variables on $REPO ($skipped skipped)." >&2
