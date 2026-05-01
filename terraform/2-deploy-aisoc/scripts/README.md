# Phase 2 scripts (`terraform/2-deploy-aisoc/scripts/`)

Post-apply work that Terraform itself can't model cleanly — function-
host-key wiring, project-scoped role assignments that depend on
runtime state, and the Foundry agent deploy.

Most of these run automatically from `null_resource` provisioners in
`post_apply_scripts.tf`, the various `*_kb.tf` files, and the GitHub
Actions workflows. Documented here so you can re-run them by hand if
something needs re-wiring.

## Standard post-apply sequence

After `terraform apply` in `terraform/2-deploy-aisoc`:

```bash
# 1. Ship the SOC Gateway Function code (also runs from CI on push).
./scripts/deploy_socgateway_function.sh

# 2. Configure the Runner with the SOC Gateway's host key.
#    Re-run after every Gateway redeploy — code redeploys rotate
#    the key.
./scripts/configure_runner_socgateway_key.sh

# 3. Deploy / update the Foundry prompt agents and wire their tools.
./scripts/deploy_prompt_agents_with_runner_tools.sh
```

Steps 1 + 2 are wired into the `deploy-soc-gateway.yml` workflow's
post-deploy step, so a normal `git push` updates the function code
AND re-wires the Runner. Step 3 runs from a `null_resource` in the
Terraform `post_apply_scripts.tf`, but it's also useful to re-run
manually after editing an agent prompt or a corpus.

## Inventory

| Script | What it does | Re-run when |
|--------|-------------|-------------|
| `deploy_socgateway_function.sh` | Zips + zip-deploys the SOC Gateway Function App. | Manual fallback for the GHA workflow. |
| `configure_runner_socgateway_key.sh` | Writes the Gateway host key into the Runner's Container App env vars. | After every Gateway redeploy. |
| `deploy_prompt_agents_with_runner_tools.sh` | Bootstraps a `.venv/`, installs deps, sources `terraform output` into env vars, calls the Python deploy script. | After editing any agent prompt, KB content, or roster. |
| `deploy_prompt_agents_with_runner_tools.py` | The actual agent deploy. Reads `agents/agents.json` + `agents/instructions/*.md`, creates / updates each Foundry prompt agent, attaches OpenAPI + MCP tools per role. | (called by the `.sh`) |
| `deploy_foundry_project.py` | Creates the Foundry **project** under the hub. Kept out of Terraform because the AzAPI provider's read flow is flaky for `Microsoft.CognitiveServices/projects`. Idempotent. | After Phase 2 apply, before the agent deploy. |
| `seed_search_kb.sh` | Generic Search-KB seeder. Creates a `(datasource → index → indexer → knowledgeSource)` chain for one corpus and idempotently PUTs/updates the parent `knowledgeBase`. Supports `EXTRA_KNOWLEDGE_SOURCES` for federation (used by the company-context KB to attach two blob sources to the same KB). | (called by `null_resource`s in `*_kb.tf`; auto re-runs when this script's `filemd5` changes) |
| `inspect_kb_contents.sh` | Read-only "what's in the KBs" dump — blobs vs index docs vs last indexer run, plus per-doc snippets and a sample semantic query. | After uploads, to verify the pipeline is healthy. |
| `diagnose_indexer_errors.sh` | Prints the full `errors[]` / `warnings[]` arrays from an indexer's last run — keys, error messages, status codes. Use when `inspect_kb_contents.sh` shows `itemsFailed > 0` or `transientFailure`. | When you need to know WHICH document broke the indexer, not just that one did. |
| `reset_kb_indexers.sh` | Clears the high-water-mark on all KB indexers (`POST /reset`) and re-runs them. | When `Blobs > 0` but `Index docs = 0` because the indexer ran against an empty container and its watermark stuck on the wrong side of subsequent uploads. |
| `refresh_sigma_corpus.sh` | Sparse-clones SigmaHQ rules and uploads them to the detection-rules blob container, then triggers the indexer. Runs at deploy + on a daily cron + on demand. | After SigmaHQ ships new rules upstream you want before the next cron tick. |
| `sync_github_repo_var.sh` | Pushes per-deploy resource names into GitHub repo variables so the per-image workflows know where to ship containers. | (called from null_resources during apply) |

## What the agent deploy script does

`deploy_prompt_agents_with_runner_tools.py` does several non-obvious
things on top of the obvious "publish each agent's prompt + tools":

1. **Project-MI role grant on the Search service.** The KB project
   connections use `ProjectManagedIdentity` auth, and the project's
   MI is a different principal from the Foundry account/hub MI that
   Terraform grants. The script reads the project's principalId
   post-apply and idempotently adds `Search Index Data Reader`.
   Without this the Detection Engineer agent gets HTTP 403 the
   first time Foundry tries to enumerate the KB's MCP tools.
2. **Project-connection auto-create for the KBs.** The Foundry
   project doesn't exist at `terraform apply` time (it's created
   by `deploy_foundry_project.py`), so the project connections that
   point at each KB's MCP endpoint are PUT here, idempotently. One
   per KB: `detection-rules-kb`, `company-context-kb`.
3. **Bing Grounding auto-wiring.** When `TF_VAR_bing_grounding_enabled
   = true` (default), the script reads the auto-provisioned Bing
   account name + API key from `terraform output` and creates the
   matching `ApiKey` project connection. The Threat Intel agent's
   `bing_grounding` tool spec carries this connection's id.
4. **Per-agent KB MCP attachment.** The detection-rules KB attaches
   only to `detection-engineer`. The company-context KB attaches to
   `triage`, `investigator`, `reporter`, `soc-manager`, and
   `threat-intel`. Detection-engineer is intentionally excluded
   from company-context — its job is rule-specific.
5. **Per-agent OpenAPI tool spec.** Each agent gets its own
   `openapi.<agent>.yaml` with a tool_name enum trimmed to the
   tools that role is allowed to call (e.g. only `soc-manager`
   sees `propose_change_to_*`; only `detection-engineer` sees
   `create_analytic_rule`).

## When something breaks

The README of each KB folder under `agents/` documents the upload +
edit flows for the corpora:
- `agents/company-context/README.md` — SOC-curated context corpus
  (runbooks, naming, glossary, escalation) + the SharePoint swap
  procedure for real customer demos.
- `agents/company-policies/README.md` — HR/IT-curated policy
  corpus (AUP, asset inventory) federated into the same KB.
