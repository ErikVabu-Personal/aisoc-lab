# NVISO Cruiseways — Agentic SOC Demo

An end-to-end demo of an **AI-powered Security Operations Center**, built
on top of Microsoft Sentinel and Azure AI Foundry. The fictional NVISO
Cruiseways fleet runs a "Ship Control Panel" web app (a small auth
surface that emits structured login + admin events to Sentinel); a
roster of Foundry agents triages, investigates, reports on, and
proposes improvements to the analytic rules that catch attacks
against it.

The whole stack — Sentinel workspace, lab VM, the gateway Functions,
the agent runner, and the operator-facing PixelAgents web — comes up
from a single command. One operator, one Azure subscription, one
laptop's worth of CLI tools. Everything is Terraform; no portal
clicks required.

## What you get

When the deploy finishes you have:

- **A Microsoft Sentinel workspace** with three pre-loaded analytic
  rules covering the Ship Control Panel's login surface (failed-
  login bursts, password spray, user-agent anomalies).
- **A lab Windows 11 VM** wired into the workspace so you can
  generate "real" telemetry by RDPing in.
- **The Ship Control Panel** running as a public Container App —
  not just a login gate, a full bridge-and-operations surface
  (Navigation / Anchor / Stabilizers / Connectivity / Climate /
  Entertainment / **Security CCTV grid**) emitting structured JSON
  events for every state change. Hitting `/login` is the obvious
  trigger; flipping the security toggle to "cameras off" is a
  more interesting one.
- **A six-agent Foundry roster** (Triage, Investigator, Reporter,
  Detection Engineer, SOC Manager, Threat Intel) with shared and
  role-specific prompts, all wired through an authenticated runner
  to Sentinel + ARM. Triage / Investigator / Reporter each post a
  shared-spine comment on the Sentinel incident as they hand off,
  so the case timeline reads as one continuous file.
- **Two Foundry IQ knowledge bases** on a shared Azure AI Search
  service:
  - **`detection-rules`** — Sigma / KQL / writeups. Attached only
    to the Detection Engineer agent for grounding new-rule
    proposals.
  - **`company-context`** — organisational context (fleet,
    subsystems, naming conventions, IR runbooks, glossary,
    escalation, HR / IT policies). Federates two corpora
    (`company-context` + `company-policies` blob containers) and
    is attached to Triage / Investigator / Reporter / SOC Manager
    / Threat Intel. SharePoint-swap-ready: the same agents work
    unchanged when you replace the underlying source via the
    Foundry portal.
- **Bing Grounding** auto-provisioned (`Microsoft.Bing/accounts`,
  kind `Bing.Grounding`) and wired to the Threat Intel agent for
  live web research.
- **PixelAgents Web** — the operator UI, structured into three
  groups in the top nav:
  - **Live** — a Live Agent View (the pixel office + the right-
    hand sidebar with chats, HITL questions, your incident queue).
  - **Trends** — `/dashboard` (Sentinel incidents),
    `/threat-horizon` (auto-refreshing TI dashboard), `/rules`
    (per-rule TP/FP performance).
  - **Configuration** — `/improvements` (Continuous Improvement
    queue, role-filtered), `/audit` (Logging & Auditing timeline,
    soc-manager-only), `/config` (per-agent model + temperature,
    user management, periodic-review interval, soc-manager-curated
    output templates).

The roles model (`soc-manager` / `detection-engineer` /
`soc-analyst` / `threat-intel-analyst`) gates every page —
analysts see incidents, detection engineers see rule proposals,
threat-intel-analysts see Threat Horizon + the TI agent's HITL
queue, SOC managers see everything plus user management, audit,
and the config page.

---

## Quick start

```bash
# 1. Clone this repo + copy the config template
cp aisoc.config.example aisoc.config
$EDITOR aisoc.config            # set RG name, region, demo roster

# 2. Make sure you're logged in to Azure + GitHub
az login
gh auth login

# 3. Deploy
./aisoc_demo.sh deploy --resource-group=rg-aisoc-demo --azure-location=westus

# … 15-20 minutes later, the script prints the URL of the operator UI
# plus the lab-VM admin credentials.

# 4. When you're done
./aisoc_demo.sh destroy
```

`aisoc_demo.sh` is the only entry point you need. It walks the three
Terraform phases in order, drives the post-apply Foundry / Function-
App / Container-App configuration scripts, and at the end prints the
admin URLs + credentials.

### `./aisoc_demo.sh --help`

```
Usage: ./aisoc_demo.sh <command> [options]

Commands:
  deploy    Walk Phases 1 → 2 → 3 — Terraform applies, function-app
            code workflows, Foundry bootstrap, smoke-test print.
            Idempotent; safe to re-run.
  destroy   Tear down all phases (Phase 3 → 2 → 1) via terraform
            destroy. Leaves the OIDC trust and AZURE_* repo
            variables in place so the next `deploy` is one command.
            5-second countdown before applying.

Common Terraform variables:
  --resource-group=...    Resource group to create / use in Azure
                          (default: rg-sentinel-test). Phase 1 creates
                          the RG with this name; Phases 2 & 3 deploy
                          into it.
  --azure-location=...    Azure region for Sentinel + lab VM
                          (default: westus). Phase 2 deploys to
                          westcentralus by default — those two
                          together are the empirically-validated
                          combo for new subs whose other regions
                          have zero App Service / EP-series quota.
  --location-override=... Region for Phase 2 (App Service / Function
                          Apps). Default: westcentralus.
  --foundry-location=...  Region for Foundry hub/project/model
                          (default: eastus2 — Model Router is
                          region-gated to East US 2 / Sweden Central).
  --vm-size=...           Lab VM size (default: Standard_D2s_v3)

  (Lab VM admin password is auto-generated by Terraform — printed
   at the end of the run. It's stored in Terraform state and stays
   stable across re-applies. To force your own value, pre-set
   TF_VAR_admin_password in the env.

   RDP is open from any source — this is a throwaway test box.)

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
  -h, --help                  show this help

Config file:
  ./aisoc.config (gitignored, optional). Sourced before CLI parsing so
  it acts as your baseline; --flag values override for the current run.
  Copy ./aisoc.config.example to get started — everything documented
  there: RG, regions, VM password, Foundry model, demo user roster, etc.

Generic pass-through:
  Any unrecognized --key=value is forwarded as TF_VAR_<key>=<value>.
  Dashes in <key> are converted to underscores (--foo-bar -> TF_VAR_foo_bar).

Sensitive values:
  For passwords / API keys, prefer pre-setting TF_VAR_<name> in the
  environment so the value never lands in shell history or process
  listings. Pre-set env vars take precedence over --flag values.

Examples:
  # Minimal first-time deploy (admin password auto-generated):
  ./aisoc_demo.sh deploy \
      --resource-group=rg-aisoc-demo --azure-location=westus

  # Override Foundry region:
  ./aisoc_demo.sh deploy \
      --resource-group=rg-aisoc-demo \
      --azure-location=westus --foundry-location=swedencentral

  # Tear it all down:
  ./aisoc_demo.sh destroy
```

Configuration precedence: **shell-preset env vars > CLI flags >
`aisoc.config` > Terraform variable defaults**. Anything sensitive
(passwords, API keys) should be pre-exported in your shell so it
never lands in CLI history or `aisoc.config`.

### Prerequisites

- `az` CLI, logged in (`az login`) on the target subscription.
- `gh` CLI, authenticated (`gh auth login`). Used to bootstrap an
  OIDC federated credential so the CI workflows that ship the
  Container Apps and Function Apps can authenticate to Azure
  without long-lived secrets.
- `terraform` ≥ 1.6.
- `jq`. Used by Phase 1 to deploy Sentinel analytic rules.
- `python3` ≥ 3.10. Used for the Foundry agent deploy script.

---

## Architecture

The demo is split into **three Terraform phases** plus a stack of
runtime components. The three phases are independent state files
that depend on each other through `terraform_remote_state`.

```
┌───────────────────────────────────────────────────────────────────┐
│ Phase 1 — Sentinel + Ship Control Panel + lab VM                  │
│   Microsoft Sentinel workspace │ analytic rules │ Win11 lab VM    │
│   Ship Control Panel (Container App, public)                      │
│   Shared Key Vault │ App Insights                                 │
└───────────────────────────────────────────────────────────────────┘
                              ▲ remote-state outputs
                              │
┌───────────────────────────────────────────────────────────────────┐
│ Phase 2 — Agentic SOC core                                        │
│   Foundry hub + project (primary model + extra deployments)       │
│   SOC Gateway Function (ARM writes to Sentinel)                   │
│   AISOC Orchestrator Function (triage→investigator→reporter)      │
│   AISOC Runner Container App (broker between Foundry + Gateway)   │
│   Azure AI Search service (semantic ranker enabled)               │
│     ├─ Detection Rules KB (Storage + Foundry IQ)                  │
│     └─ Company Context KB (2 Storage containers, federated)       │
│   Bing Grounding account (Microsoft.Bing/accounts, kind=          │
│     Bing.Grounding) wired to the Threat Intel agent               │
└───────────────────────────────────────────────────────────────────┘
                              ▲ remote-state outputs
                              │
┌───────────────────────────────────────────────────────────────────┐
│ Phase 3 — Operator UI                                             │
│   PixelAgents Web (FastAPI Container App)                         │
│   Auto-pickup loop, HITL routing, Foundry agent invocation,       │
│   /dashboard, /improvements, /audit, /config, /                   │
└───────────────────────────────────────────────────────────────────┘
```

### Agents

Six Foundry prompt-agents, each with a role-specific instruction file
and the right runner tools attached:

| Agent | Role | Pipeline? | KB |
|-------|------|-----------|----|
| **Triage** | L1 first pass — frames the question, escalates. Never asks humans, never closes. Posts a 🔎 spine-shaped comment to Sentinel. | Yes | `company-context` |
| **Investigator** | KQL-driven analysis, builds the timeline, can ask the human or Threat Intel agent mid-flow. Posts a 🧪 comment with `Findings:` + `Timeline:`. | Yes | `company-context` |
| **Reporter** | Drafts the case note, decides to close / get sign-off / re-investigate. Free-text human reply. Posts the 📝 case-note comment. | Yes | `company-context` |
| **Detection Engineer** | On-demand. Drafts new analytic rules, grounded in the rule library KB. | No (chat-only) | `detection-rules` |
| **SOC Manager** | On-demand + periodic. Reviews recent runs, proposes preamble / agent-prompt / **company-context page** / detection-rule edits. | No (chat-only) | `company-context` |
| **Threat Intel** | On-demand + investigator hook. Web research via Bing Grounding. Powers the `/threat-horizon` dashboard. | No | `company-context` |

Behaviour is controlled per-agent on `/config`: the LLM deployment,
the `CONFIDENCE_THRESHOLD` slider (how readily it asks humans), and
the role-specific instruction text are all editable live. Common
preamble (`common.md`) is trimmed to the technical contract only —
KQL filter, tool rules, output format, the `{ok: false}` envelope.
Organisational context (fleet, subsystems, naming, runbooks)
lives in the `company-context` KB and is retrieved on demand, so
the SOC manager can edit it without redeploying agents.

---

## Repo layout

```
.
├─ aisoc_demo.sh              # one-shot deploy / destroy driver
├─ aisoc.config.example       # baseline config (copy → aisoc.config)
├─ terraform/                 # 3 Terraform phases + scripts
├─ pixelagents_web/           # operator-facing FastAPI app + UI
├─ runner/                    # AISOC Runner Container App
├─ ship-control-panel/        # the lab "victim" web auth surface
└─ scripts/                   # cross-phase Python helpers
```

### `terraform/`

Three independent stacks. Always apply in order; destroy in reverse.

| Folder | What it builds |
|--------|----------------|
| `1-deploy-sentinel/` | Microsoft Sentinel workspace, three analytic rules (`sentinel_rules.tf`), the Ship Control Panel Container App (`ship_control_panel.tf`), the lab VM (`main.tf`), shared Key Vault (`aisoc_kv.tf`), App Insights (`appinsights_shipcp.tf`), Defender for Endpoint onboarding (`mde_kv.tf`). README + PHASES + MDE + SECURITY docs sit alongside. |
| `2-deploy-aisoc/` | Foundry hub + project (`foundry.tf`) + a primary model deployment + zero-or-more extras (`foundry_deployments.tf`). The SOC Gateway Function (`main.tf`), the AISOC Orchestrator Function (`orchestrator.tf` + `orchestrator/`), the Runner Container App (`runner.tf`). The Azure AI Search service shared by both knowledge bases — Detection Rules KB (`detection_rules_kb.tf`) + Company Context KB with two federated corpora (`company_context_kb.tf`). Bing Grounding account + auto-wired project connection (`bing_grounding.tf`). The Foundry agents themselves (`agents/agents.json` + `agents/instructions/*.md`) are deployed by `scripts/deploy_prompt_agents_with_runner_tools.py`. The KB corpora live alongside in `agents/company-context/*.md` (SOC-curated runbooks / glossary / escalation) and `agents/company-policies/*.md` (HR-IT-curated AUP + asset inventory) — uploaded to blob via the per-folder `upload_*.sh` scripts after apply. |
| `3-deploy-pixelagents-web/` | Just the PixelAgents Web Container App + its env-var wiring. |

Each phase has its own `scripts/` folder for post-apply work that
Terraform itself can't model cleanly (function host keys, Container
App secrets that depend on runtime state).

### `pixelagents_web/`

The operator UI. Single FastAPI app, server-rendered HTML + small
inline JS modules, no React build step.

```
pixelagents_web/
├─ Dockerfile
├─ pyproject.toml
├─ app/
│   ├─ server.py             # the whole backend (~6k lines, intentional monolith)
│   └─ static/               # one .js per page
│       ├─ agent_comm.js     # Live Agent View sidebar (chats + DM panels)
│       ├─ chat_drawer.js    # streaming chat drawer (used inside agent_comm + popups)
│       ├─ chat_popup.js     # iframe-embedded standalone chat surface
│       ├─ dashboard.js      # /dashboard table + draggable incident-detail panels
│       ├─ incidents_panel.js  # the per-incident timeline panel (used by /dashboard)
│       ├─ threat_horizon.js # /threat-horizon TI dashboard (auto-refresh)
│       ├─ rules.js          # /rules per-rule TP/FP performance
│       ├─ improvements.js   # /improvements Continuous Improvement dashboard
│       ├─ audit.js          # /audit timeline
│       ├─ config.js         # /config — per-agent dials, users, interval, templates
│       └─ auto_pickup_badge.js  # Live View status pill
└─ ui/                       # vendored Pixel Agents office bundle (the "live view")
```

Pages and their role gates. The top nav groups them into three
sections (Live / Trends / Configuration) with notification badges
per group:

| Path | Visible to | Purpose |
|------|------------|---------|
| `/` | everyone | **Live** — the pixel office + the right-hand sidebar with HITL, chats, queue. |
| `/dashboard` | everyone | **Trends** — Sentinel incidents table, click-through to a draggable per-incident timeline panel. |
| `/threat-horizon` | threat-intel-analyst + soc-manager | **Trends** — auto-refreshing TI dashboard (4 sections + posture banner) populated by the Threat Intel agent. Refresh cadence configurable on `/config`. |
| `/rules` | detection-engineer + soc-manager | **Trends** — per-rule TP/FP performance with stacked bars, sortable. |
| `/improvements` | detection-engineer + soc-manager | **Configuration** — Continuous Improvement dashboard. Detection-engineers see only detection-rule items. SOC managers see preamble / agent-instruction / **company-context-page** / detection-rule changes. |
| `/audit` | soc-manager | **Configuration** — Logging & Auditing timeline (incidents, runs, tool calls, change decisions, SOC-Manager reviews). |
| `/config` | soc-manager | **Configuration** — Per-agent model + temperature + confidence-threshold dials, user management, periodic-review interval, output-template editor (incident-comment, improvement-report, detection-rule-proposal). |
| `/login`, `/logout`, `/chat-popup` | session-bound | Auth + the iframe payload for in-page chat panels. |

### `runner/`

A small FastAPI app that brokers tool calls between Foundry agents
and Sentinel/ARM. Foundry can't directly call ARM with a customer
identity; the runner uses a managed identity to do so on the
agent's behalf.

```
runner/
├─ Dockerfile
├─ pyproject.toml
├─ aisoc_runner/
│   └─ server.py             # tool dispatcher
└─ openapi*.yaml             # tool schemas published to Foundry
```

Tools the runner exposes:

- **Sentinel** — `kql_query`, `list_incidents`, `get_incident`,
  `update_incident`, `add_incident_comment`.
- **HITL** — `ask_human` (blocks the agent run until a human
  replies via the Live Agent View sidebar).
- **Detection authoring** — `create_analytic_rule` (Detection
  Engineer only).
- **SOC Manager change-proposal family** —
  `get_agent_role_instructions`, `get_template`,
  `propose_change_to_preamble`,
  `propose_change_to_agent_instructions`,
  `propose_change_to_detection_rule`,
  `propose_change_to_company_context` (the SOC manager can recommend
  edits to any page in the company-context KB corpus, role-gated
  through PA-Web's change queue).
- **Threat intel** — `query_threat_intel` (invokes the Threat
  Intel agent for the Investigator), `fetch_url` (HTTPS fetch +
  HTML→text strip; complements Bing Grounding by reading pages
  Bing only linked).
- **Knowledge bases** — surfaced as **MCP tools** rather than
  OpenAPI: `detection-rules` (Detection Engineer only) and
  `company-context` (Triage / Investigator / Reporter / SOC
  Manager / Threat Intel). Both expose `knowledge_base_retrieve`.

### `ship-control-panel/`

The "victim" web app — a Next.js bridge-and-operations console for
the fictional NVISO Cruiseways fleet. Visually skinned as a real
maritime operations surface (light theme, navy + steel-blue,
monospace readouts) with seven subsystem tabs:

- **Navigation** — chart with destination, throttle telegraph,
  collision-detection toggle.
- **Anchor** — four states (HOME / PAYING_OUT / HOLDING / DRAGGING).
- **Stabilizers** — fin angles, OFF / STANDBY / AUTO / MANUAL modes.
- **Connectivity** — Starlink uplink + simulated speedtest.
- **Climate** — per-room AC.
- **Entertainment** — pool / wellness / media / lighting scenes.
- **Security** — 2x3 CCTV grid with a "disable cameras" toggle that
  emits a `severity:warn` event Sentinel rules can pivot off.

Every state change emits a structured JSON line to stdout
(`auth.login.failure`, `auth.login.success`, `navigation.throttle`,
`anchor`, `connectivity`, `security`, `climate`, …). Container
Apps ships stdout to Log Analytics, where Sentinel's analytic
rules pick them up.

The two demo-friendly attack triggers: hit `/login` repeatedly
with bad credentials, or sign in once and flip the Security tab's
cameras-disabled toggle. The cameras-off event is a textbook
attacker-tradecraft signal — it's the case the Investigator's
runbook in `company-context` is written around.

### `scripts/`

Cross-phase Python helpers. The big ones:

- `deploy_foundry_project.py` — creates the Foundry project (kept
  out of Terraform because the AzAPI provider's read flow is flaky
  for `Microsoft.CognitiveServices/projects`).
- `sync_github_repo_var.sh` — pushes the per-deploy resource names
  into GitHub repo variables so the per-image deploy workflows know
  where to ship the new container.

Each Terraform phase also has its own `scripts/` for post-apply
work that depends on runtime state (function host keys, Container
App env-var wiring after a Phase-2 redeploy, the Foundry agent
deploy).

---

## Configuration (`aisoc.config`)

Anything you'd normally pass on the CLI can go in `aisoc.config` at
the repo root (gitignored). Copy `aisoc.config.example` to start.
The file is `bash`-sourced, so it just exports `TF_VAR_*` and
`AISOC_*` env vars.

The example documents every supported knob. Highlights:

- **`TF_VAR_resource_group_name`**, **`TF_VAR_azure_location`**,
  **`TF_VAR_foundry_location`**, **`TF_VAR_location_override`** —
  the four region / RG knobs that matter on a fresh subscription.
- **`TF_VAR_pixelagents_users`** — JSON `{email: {password, roles}}`.
  Roles are `soc-manager`, `detection-engineer`, `soc-analyst`,
  `threat-intel-analyst`. The example file ships the full demo
  roster.
- **`TF_VAR_foundry_additional_model_deployments`** — JSON list
  of extra model deployments to surface on `/config`'s per-agent
  dropdown. Defaults to `gpt-4.1` and `gpt-4o-mini` alongside the
  primary `gpt-4.1-mini`.
- **`TF_VAR_detection_rules_kb_enabled`** — flips the Foundry IQ
  rule-library subsystem on or off. Default: `true`.
- **`TF_VAR_company_context_kb_enabled`** — flips the second
  Foundry IQ KB (org context + HR/IT policies, federated). Default:
  `true`. Requires `detection_rules_kb_enabled` because both KBs
  share the Search service.
- **`TF_VAR_bing_grounding_enabled`** — when `true` (default),
  Phase 2 provisions a `Microsoft.Bing/accounts` (kind=
  `Bing.Grounding`) and the agent deploy script auto-creates the
  matching Foundry project connection. The Threat Intel agent
  picks up the `bing_grounding` tool with no manual portal
  clicks. Backward-compat: if you've already wired a project
  connection by hand, set `AISOC_BING_GROUNDING_CONNECTION` to
  its name and the auto-provision step is skipped.

Sensitive values (admin password, API keys) should ideally be
exported in your shell rather than written to `aisoc.config` —
the precedence rules in `aisoc_demo.sh` honor pre-shell env vars
above everything else.

---

## Operating the demo

### Generating an incident

The Sentinel analytic rules fire on the Ship Control Panel's
auth telemetry. Easiest demo trigger: hit `/login` from a
browser and try a few wrong passwords. Within ~5 minutes a
Sentinel incident will pop up in the workspace.

If `Auto-pickup` is on (the toggle on `/config`, default ON), the
orchestrator runs Triage → Investigator → Reporter automatically,
the agents annotate the incident in Sentinel, and the case ends in
either an autonomous closure or a hand-off to a human (depending on
the per-agent CONFIDENCE_THRESHOLD).

### Roles you'll need

The demo's role model:

| Role | Sees |
|------|------|
| `soc-analyst` | Live Agent View (incident queue + HITL questions from triage / investigator / reporter), `/dashboard`. Can pick up cases. |
| `detection-engineer` | Live Agent View, `/dashboard`, `/rules`, `/improvements` (filtered to detection-rule changes). HITL questions from the Detection Engineer agent. |
| `threat-intel-analyst` | Live Agent View, `/dashboard`, `/threat-horizon`. HITL questions from the Threat Intel agent. |
| `soc-manager` | Everything. `/config`, `/audit`, full `/improvements` queue (preamble / agent-instructions / company-context-page / detection-rule), user management, the templates editor. |

A user can hold multiple roles. The first user in the bootstrap
fallback (`erik.vanbuggenhout@nviso.eu`) holds all four.

### Tearing down

```bash
./aisoc_demo.sh destroy
```

The script tears down Phase 3 → 2 → 1 in reverse order, with two
small safeguards baked in:

1. The Foundry hub can't be deleted while it has child projects, so
   the script makes a direct ARM `DELETE` on the project before
   `terraform destroy` reaches the hub.
2. The Phase 1 lab VM auto-shuts down on a schedule, and Azure won't
   let extensions be modified on a deallocated VM. Before destroying
   Phase 1 the script `az vm start`s the VM and polls for `running`,
   then if it didn't come up in time, falls back to
   `terraform state rm`'ing each `azurerm_virtual_machine_extension`
   — Azure cleans those up automatically when the parent VM is
   deleted further down the destroy.

OIDC trust + AZURE_* repo variables stay in place; the next
`deploy` is one command from a fresh teardown.

---

## Pointers

- **Phase 1** = `terraform/1-deploy-sentinel/README.md` for Sentinel-
  workspace specifics + the analytic rules.
- **Phase 3** = `terraform/3-deploy-pixelagents-web/README.md` for the
  Container App side.
- **MDE / Defender for Endpoint** onboarding is documented in
  `terraform/1-deploy-sentinel/MDE.md`.
- **Phase ordering + remote-state contracts** are in
  `terraform/1-deploy-sentinel/PHASES.md` and
  `terraform/2-deploy-aisoc/PHASES.md`.
- **Agent prompts** live in
  `terraform/2-deploy-aisoc/agents/instructions/*.md`. Editing them
  + re-running the deploy script (or saving via `/config`) is the
  way to change agent behaviour.
- **The single source of truth for the agent roster** is
  `terraform/2-deploy-aisoc/agents/agents.json`. Adding an agent
  means: edit that file, write an `agents/instructions/<slug>.md`,
  re-deploy.
- **Knowledge base corpora**:
  - SOC-curated: `terraform/2-deploy-aisoc/agents/company-context/`
    (8 starter pages — fleet, subsystems, naming, runbooks,
    glossary, escalation). README in that folder documents the
    upload flow + the SharePoint swap procedure.
  - HR/IT-curated: `terraform/2-deploy-aisoc/agents/company-policies/`
    (acceptable use, asset inventory). Same Foundry IQ KB; second
    blob source federated in. Edit either folder and re-run the
    matching `upload_*.sh` to push changes; the indexer picks them
    up within 30 minutes.
- **Activation order on a fresh deploy**:
  1. `./aisoc_demo.sh deploy …` (builds all infra + uploads agent
     prompts).
  2. `cd terraform/2-deploy-aisoc/agents/company-context && \
       ./upload_company_context.sh`
  3. `cd ../company-policies && ./upload_company_policies.sh`
  4. (Optional) re-run
     `terraform/2-deploy-aisoc/scripts/deploy_prompt_agents_with_runner_tools.py`
     if you've edited any agent prompt or the corpora — idempotent.
