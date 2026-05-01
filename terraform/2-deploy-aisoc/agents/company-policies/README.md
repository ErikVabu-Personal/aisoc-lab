# Company Policies — second corpus federated into the company-context KB

This folder holds the **HR / IT-curated** half of the corpus that
backs the `company-context` Foundry IQ knowledge base. The other
half (SOC-curated runbooks, naming, glossary, escalation) is in
`../company-context/`.

## Why the split

Different curators, different change cadences, different review
chains. SOC runbooks change when an incident teaches us something;
HR policies change when legal / IT review them. Splitting the
corpus into two blob containers lets each team edit independently
without stepping on each other.

Both feed the SAME `company-context` knowledge base — Foundry IQ
federates retrieval across them. The agents see one MCP endpoint
("company-context"), don't know or care which container a given
chunk came from, and the answer can blend content from both
sources in a single response.

This is the **federation pitch** for Foundry IQ: more sources,
same KB, no agent changes. In a real customer deployment you'd
typically point one source at SharePoint (where HR already curates
the AUP) and keep the other in Blob (where the SOC team
git-commits its runbooks alongside its code).

## Seeded pages

| File                       | What's in it |
|----------------------------|--------------|
| `01-acceptable-use.md`     | IT acceptable-use policy with permitted / prohibited / reporting / consequences sections |
| `02-asset-inventory.md`    | Operations-network asset list (apps, segments, identity providers) with tiers |

## Uploading

After phase-2 has applied (the storage + container + Search
sub-resources for both sources are in place), run:

```bash
./upload_company_policies.sh
```

…from this folder. Same pattern as the company-context upload
script, but pushes into the `company-policies` container.

## Editing in production

Same as `../company-context/README.md` — edit, upload, indexer
picks up new content within 30 minutes. Curated by HR / IT. The
SOC manager can also propose edits via the
`propose_change_to_company_context` tool — though for HR-curated
pages, those proposals should go through HR rather than the SOC
change queue. (When in doubt, the SOC manager raises it as a chat
with the HR team out of band, not as a queued change.)

## SharePoint swap

Same procedure as documented in `../company-context/README.md`:
add a SharePoint connection in the Foundry portal, add a knowledge
source of kind `sharePointOnlineList` to the existing
`company-context` knowledge base, optionally drop the blob source
for the policies side. The agent code doesn't change.

The natural production setup is **mixed**: SharePoint backing the
HR / IT policies (where editors already live) + blob backing the
SOC runbooks (where the SOC team already git-commits everything).
