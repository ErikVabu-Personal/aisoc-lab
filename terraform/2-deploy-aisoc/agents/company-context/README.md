# Company Context KB — corpus + SharePoint swap

This folder holds the seed markdown corpus that gets uploaded to the
`company-context` blob container and indexed into the Foundry IQ
knowledge base of the same name. Five SOC agents query it at runtime
(triage / investigator / reporter / soc-manager / threat-intel) when
they need organisational context — fleet, subsystems, naming
conventions, runbooks, glossary.

## Seeded pages

| File                                 | What's in it |
|--------------------------------------|--------------|
| `01-company-overview.md`             | NVISO Cruiseways, fleet, SOC team structure |
| `02-monitored-systems.md`            | Ship Control Panel subsystems + what "normal" looks like |
| `03-account-naming.md`               | Account prefixes (`bo_`, `crew_`, `svc_`, …), VIP list |
| `04-runbook-credential-stuffing.md`  | IR runbook for repeated-failure alerts |
| `05-runbook-cameras-disabled.md`     | IR runbook for the security-cameras-off alert |
| `06-runbook-uplink-disabled.md`      | IR runbook for connectivity-disabled |
| `07-glossary.md`                     | Maritime + Ship Control Panel + AISOC terminology |
| `08-escalation.md`                   | Escalation matrix, oncall, approved tooling |
| `09-endpoint-telemetry.md`           | Lab VM + Sysmon — schema, base filter, common Sysmon EIDs, KQL pivot patterns |

## Uploading to the blob container

After Phase 2 has applied (the storage account + container exist),
run:

```bash
./upload_company_context.sh
```

…from this folder. The script discovers the storage account name
from `terraform output` and uploads every `.md` and `.txt` file in
this directory. The Search service indexer picks up new blobs
automatically on its next scheduled run (every 30 minutes). To
force an immediate re-index without waiting:

```bash
az search indexer run \
  --service-name "$(terraform -chdir=../.. output -raw \
     detection_rules_search_endpoint | \
     awk -F'/' '{print $3}' | awk -F'.' '{print $1}')" \
  --name company-context-indexer \
  --resource-group "$(terraform -chdir=../.. output -raw resource_group)"
```

## Editing in production

The corpus is **not** Terraform-managed — that's deliberate. The
SOC manager edits these pages over time (new runbooks, updated
escalation rota, changed VIP list). Workflow:

1. Edit the file locally OR upload via Storage Explorer / portal.
2. Either wait 30 minutes for the indexer's scheduled run, or
   force-run as above.
3. The next agent that calls the KB sees the new content.

No agent redeploy needed. That's the whole point: organisational
context is curated separately from the agent prompts.

## Swapping to SharePoint

For real customer deployments where the company already has its
documentation in SharePoint, you can swap the blob-backed knowledge
source for a SharePoint-backed one without changing any agent code.
The agent still sees `company-context` as an MCP tool; only the
underlying source changes.

Procedure:

1. **In the Foundry portal** (`portal.azure.com` → AI Foundry →
   project → Knowledge bases → Manage connections):
   - Add a new connection of type **SharePoint**.
   - Authenticate (Microsoft Entra ID; needs `Sites.Read.All`
     application permission OR delegated-user permission with
     access to the site).
   - Point at the SOC's SharePoint site (or specific document
     library).

2. **Add a knowledge source** to the existing `company-context`
   knowledge base, of kind `sharePointOnlineList`. The portal will
   pick the connection from the dropdown.

3. **Optional**: remove the blob-backed knowledge source from the
   same KB (or keep both — KBs can have multiple sources, and
   Foundry IQ federates retrieval across them).

That's it — the project connection (`company-context-kb`) remains
unchanged, the MCP endpoint URL the agent sees is unchanged, the
agent's instructions are unchanged. Foundry IQ handles auth +
retrieval against SharePoint transparently.

The reason this works without code changes is that **Foundry IQ
abstracts away the source**: the agent only ever sees a knowledge
*base*, not its sources. Mixing source types (blob + SharePoint +
OneLake) in a single KB is supported and often the right answer
for enterprise customers — keep the org-wide policy docs in
SharePoint where the legal team already curates them, and keep
the SOC-specific runbooks in blob where the SOC team can git-commit
them.

## Federated with the company-policies corpus

A second corpus lives at `../company-policies/` (HR / IT-curated:
acceptable-use policy, asset inventory). Both feed the SAME
`company-context` knowledge base — Foundry IQ federates retrieval
across them, and the agents see one MCP endpoint regardless of
which container a given chunk came from. See
`../company-policies/README.md` for the rationale and the upload
flow for the second corpus.

## Demo angle

For the cruise event, the talking points are:

- "These agents don't have NVISO Cruiseways context baked into
  their prompts. They retrieve it on demand from a knowledge base
  the SOC manager curates."
- "Today, the KB is backed by an Azure Storage container so the
  whole demo runs offline. In a real deployment, you'd point this
  at SharePoint — your existing IR runbook library, your
  escalation matrix, your asset inventory — and the agents pick up
  changes the moment your content editors save them."
- "And because Foundry IQ federates retrieval across sources, you
  can mix backends: SharePoint for the policy docs, OneLake for
  the asset inventory, our blob for the agent-specific
  conventions. Same KB. Same MCP endpoint. Same agent."
