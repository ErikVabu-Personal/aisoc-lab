# Vendored GOAD (do not hand-edit)

This `GOAD/` directory is a **verbatim vendored copy** of Orange Cyberdefense's
**GOAD** (Game Of Active Directory), committed into aisoc-lab so the red-vs-blue
range is self-contained: one `git clone` of aisoc-lab gets the AD lab too, and
`./aisoc_demo.sh deploy --deploy-goad` runs it from here — no separate `~/GOAD`
checkout required.

- **Upstream:** https://github.com/Orange-Cyberdefense/GOAD
- **Pinned commit:** `992307adf944b934a3b76a2f56a637104c54b805` (`main`, vendored 2026-09-29)
- **License:** GPL-3.0 — see `LICENSE`. GOAD is invoked as a separate program
  (`goad.sh`); this is mere aggregation and does **not** relicense aisoc-lab's own
  Terraform/Python.

## How aisoc-lab drives it

`scripts/goad_azure_prep.py` patches GOAD's Azure provider **in place** at deploy
time (Standard public-IP SKU + capacity-safe VM sizes for the chosen region), then
`aisoc_demo.sh --deploy-goad` runs `goad.sh -t install -l GOAD -p azure -m remote`
here and auto-discovers the resulting resource group for Phase 4/5.

**Expected side effect:** running a deploy leaves local modifications under
`GOAD/ad/GOAD/providers/azure/` and `GOAD/template/provider/azure/` (the region/size
patches). That's normal — reset to pristine upstream with `git checkout -- GOAD/`
(or `git stash`) whenever you want. Runtime state (`workspace/`, `.terraform/`,
`*.tfstate`, `.venv/`, ssh keys) is ignored by GOAD's own `.gitignore` + the repo
root `.gitignore`; the prep's `*.bak-*` backups are ignored too.

## Re-vendoring / updating

```bash
git clone --depth 1 https://github.com/Orange-Cyberdefense/GOAD /tmp/GOAD-new
rm -rf GOAD && mkdir GOAD && git -C /tmp/GOAD-new archive HEAD | tar -x -C GOAD
# then: bump the pinned commit above, re-add, and re-apply exec bits on *.sh
```
