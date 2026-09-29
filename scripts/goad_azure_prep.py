#!/usr/bin/env python3
"""Prep an external GOAD clone's Azure provider for a clean `goad.sh -p azure`.

GOAD (github.com/Orange-Cyberdefense/GOAD) is deployed separately, but its Azure
provider trips over the same fresh-subscription issues aisoc-lab does, and fixing
them by hand every time is exactly what this script removes:

  1. Region — set `[azure] az_location` in goad.ini to match Phase 1 (the DCR only
     associates in-region).
  2. Basic public IP — GOAD's jumpbox omits `sku`, so azurerm defaults it to Basic,
     which Azure retired (new subs get 0). Force `sku = "Standard"`.
  3. VM sizes — GOAD hardcodes `Standard_B2s`, which is capacity-restricted in some
     regions. Pick 2-vCPU sizes that HAVE capacity + quota, splitting the jumpbox
     onto a second family when one family can't hold all the DCs (5×2) — the exact
     split we worked out by hand for West US (DCs on DSv3, jumpbox on DASv4).

Idempotent; edits GOAD's source templates (`ad/GOAD/providers/azure`,
`template/provider/azure`) AND any existing rendered workspaces, keeping `.bak`
copies. `az` must be logged in. Run BEFORE `goad.sh -p azure`:

    python3 scripts/goad_azure_prep.py --region westus [--request-quota]
"""
from __future__ import annotations

import argparse
import configparser
import glob
import os
import re
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib_azure_capacity as az  # noqa: E402

DC_CANDIDATES = [  # 2 vCPU, most-preferred first
    "Standard_D2s_v3", "Standard_D2as_v4", "Standard_D2s_v5",
    "Standard_D2as_v5", "Standard_D2s_v4", "Standard_F2s_v2",
]


def _backup(path: str, tag: str) -> None:
    if not os.path.exists(path + f".bak-{tag}"):
        shutil.copy(path, path + f".bak-{tag}")


def set_region(goad_ini: str, region: str) -> None:
    cfg = configparser.ConfigParser()
    cfg.read(goad_ini)
    if not cfg.has_section("azure"):
        cfg.add_section("azure")
    if cfg.get("azure", "az_location", fallback=None) == region:
        az.log(f"goad.ini az_location already {region}")
        return
    _backup(goad_ini, "region")
    cfg.set("azure", "az_location", region)
    with open(goad_ini, "w") as f:
        cfg.write(f)
    az.log(f"goad.ini [azure] az_location -> {region}")


def _azure_tf_files(clone: str, names: list[str]) -> list[str]:
    roots = [
        f"{clone}/ad/GOAD/providers/azure",
        f"{clone}/template/provider/azure",
        *glob.glob(f"{clone}/workspace/*goad-azure*/provider"),
    ]
    found = []
    for root in roots:
        for n in names:
            found += glob.glob(f"{root}/{n}")
    return found


def patch_public_ip_sku(clone: str) -> None:
    pip_re = re.compile(
        r'(resource\s+"azurerm_public_ip"\s+"ubuntu_public_ip"\s*\{[^}]*?allocation_method\s*=\s*"Static")',
        re.DOTALL)
    for f in _azure_tf_files(clone, ["jumpbox.tf"]):
        s = open(f, encoding="utf-8").read()
        blk = s.split("ubuntu_public_ip", 1)[1].split("}", 1)[0] if "ubuntu_public_ip" in s else ""
        if "sku" in blk:
            continue
        new, n = pip_re.subn(r'\1\n  sku                 = "Standard"', s)
        if n:
            _backup(f, "pip")
            open(f, "w", encoding="utf-8").write(new)
            az.log(f"public IP -> Standard SKU: {f}")


def set_dc_size(clone: str, size: str) -> None:
    # Windows DCs hardcode `size = "Standard_..."` per host in windows.tf.
    size_re = re.compile(r'(size\s*=\s*)"Standard_[A-Za-z0-9_]+"')
    for f in _azure_tf_files(clone, ["windows.tf"]):
        s = open(f, encoding="utf-8").read()
        new, n = size_re.subn(rf'\1"{size}"', s)
        if n and new != s:
            _backup(f, "dcsize")
            open(f, "w", encoding="utf-8").write(new)
            az.log(f"DC size -> {size} ({n}×): {f}")


def set_jumpbox_size(clone: str, size: str) -> None:
    # Jumpbox uses var.size; its default lives in the azure template variables.tf.
    default_re = re.compile(r'(default\s*=\s*)"Standard_[A-Za-z0-9_]+"')
    for f in _azure_tf_files(clone, ["variables.tf"]):
        s = open(f, encoding="utf-8").read()
        # Only the `size` variable holds a Standard_* default (location is a region).
        new, n = default_re.subn(rf'\1"{size}"', s)
        if n and new != s:
            _backup(f, "jumpsize")
            open(f, "w", encoding="utf-8").write(new)
            az.log(f"jumpbox size -> {size}: {f}")


def main() -> int:
    ap = argparse.ArgumentParser(description="Prep GOAD's Azure provider for a fresh sub/region.")
    ap.add_argument("--region", required=True)
    ap.add_argument("--goad-config", default=os.path.expanduser("~/.goad/goad.ini"))
    ap.add_argument("--goad-clone", default=os.path.expanduser("~/GOAD"))
    ap.add_argument("--dc-count", type=int, default=5)
    ap.add_argument("--subscription", default=None)
    ap.add_argument("--request-quota", action="store_true")
    args = ap.parse_args()

    if not os.path.isdir(args.goad_clone):
        az.log(f"GOAD clone not found at {args.goad_clone} — set --goad-clone")
        return 1

    # 1) region + 2) public IP SKU (always needed, no az required)
    if os.path.exists(args.goad_config):
        set_region(args.goad_config, args.region)
    else:
        az.log(f"goad.ini not found at {args.goad_config}; goad.sh creates it on first run — "
               f"re-run this after, or set --goad-config")
    patch_public_ip_sku(args.goad_clone)

    # 3) capacity-aware sizes (needs az)
    sub = args.subscription or az.current_subscription()
    if not sub:
        az.log("az not logged in — kept region + public-IP fixes; leaving sizes as-is "
               "(re-run with az logged in to auto-select capacity-safe sizes)")
        return 0
    usage = az.region_usage(args.region)
    dc_vcpus = 2 * args.dc_count

    az.log(f"picking DC size (needs {dc_vcpus} vCPU across {args.dc_count} DCs)…")
    dc = az.pick_size(args.region, DC_CANDIDATES, dc_vcpus, usage)
    if not dc:
        az.log("no 2-vCPU family has capacity in this region — check the portal; leaving sizes unchanged")
        return 0

    # Simulate the DCs consuming their family, then pick the jumpbox (2 vCPU) —
    # pick_size will move it to a second family if the DC family is now full.
    sim = {k: dict(v) for k, v in usage.items()}
    if dc["family"]:
        for k in sim:
            if k.lower() == dc["family"].lower():
                sim[k]["current"] += dc_vcpus
    az.log("picking jumpbox size (2 vCPU, second family if the DC family is full)…")
    jb = az.pick_size(args.region, DC_CANDIDATES, 2, sim) or dc

    set_dc_size(args.goad_clone, dc["size"])
    set_jumpbox_size(args.goad_clone, jb["size"])

    if args.request_quota:
        total = usage.get("cores")
        if total:
            az.ensure_quota(sub, args.region, "cores", total["current"] + dc_vcpus + 2, usage, True)
        for fam, need in {dc["family"]: dc_vcpus, jb["family"]: 2}.items():
            if fam:
                az.ensure_quota(sub, args.region, fam, need, usage, True)

    az.log(f"DONE. DCs -> {dc['size']} ({dc['family']}); jumpbox -> {jb['size']} ({jb['family']}). "
           f"Now run: goad.sh -t install -l GOAD -p azure -m remote")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
