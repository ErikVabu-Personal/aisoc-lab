#!/usr/bin/env python3
"""Find an Azure region with CAPACITY for the GOAD + RedAmon VMs.

When both West US and West US 2 come back capacity-starved for a subscription's
2-vCPU families (`SkuNotAvailable` / `NotAvailableForSubscription`), trying regions
by hand is slow. This probes a spread of regions — one `az vm list-skus` call each
(bulk) — and reports which have capacity for BOTH:

  * a GOAD DC size   (2 vCPU — 5 DCs + a jumpbox), and
  * a RedAmon size   (4 vCPU).

Capacity is the HARD gate (no script conjures it); quota in the winning region is
then auto-grantable (goad_azure_prep.py --request-quota / AISOC_REQUEST_QUOTA=1), so
this only checks capacity. Prints a ranked table to stderr and the recommended
region on the LAST stdout line:

    REGION=$(python3 scripts/azure_find_region.py)
    python3 scripts/goad_azure_prep.py --region "$REGION" --request-quota

Then deploy with --goad-location=$REGION.
"""
from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib_azure_capacity as az  # noqa: E402

# 2-vCPU GOAD DC / jumpbox candidates (broad — first that a region has wins in prep).
DC_SIZES = [
    "Standard_D2s_v3", "Standard_D2as_v4", "Standard_D2s_v5", "Standard_D2as_v5",
    "Standard_D2s_v4", "Standard_DS2_v2", "Standard_F2s_v2", "Standard_D2_v5",
    "Standard_D2a_v4", "Standard_B2s", "Standard_B2ms",
]
# 4-vCPU RedAmon candidates (--gvm wants 4 vCPU / 16 GB).
RED_SIZES = [
    "Standard_D4as_v4", "Standard_D4s_v5", "Standard_D4as_v5", "Standard_D4s_v4",
    "Standard_D4s_v3", "Standard_DS3_v2", "Standard_F4s_v2", "Standard_D4_v5",
    "Standard_D4a_v4",
]
# US regions first (cheaper/lower-latency cross-region DCR into the West US Sentinel
# workspace), then Europe. Ranking is by capacity breadth; this order only breaks ties.
DEFAULT_REGIONS = [
    "eastus2", "eastus", "centralus", "southcentralus", "westus3", "northcentralus",
    "westcentralus", "canadacentral", "westus", "westus2",
    "westeurope", "northeurope", "uksouth", "swedencentral", "francecentral",
    "germanywestcentral", "switzerlandnorth",
]

# GOAD needs 6 same-size boxes (5 DCs + jumpbox); RedAmon needs 1.
DC_COUNT = 6
RED_COUNT = 1


def _avail(skus: dict, names: list[str]) -> list[str]:
    return [n for n in names if skus.get(n, {}).get("available")]


def main() -> int:
    ap = argparse.ArgumentParser(description="Find a region with capacity for GOAD + RedAmon.")
    ap.add_argument("--regions", nargs="*", default=DEFAULT_REGIONS,
                    help="Regions to probe (default: a US+EU spread).")
    ap.add_argument("--dc-sizes", nargs="*", default=DC_SIZES)
    ap.add_argument("--redamon-sizes", nargs="*", default=RED_SIZES)
    ap.add_argument("--default-region", default="eastus2",
                    help="Printed on stdout if nothing has capacity (deploy still validates it).")
    args = ap.parse_args()

    if not az.current_subscription():
        az.log("az not logged in — can't survey; emitting default region")
        print(args.default_region)
        return 0

    az.log(f"probing {len(args.regions)} regions for a 2-vCPU DC size + a 4-vCPU RedAmon size…")
    rows = []  # (region, dc_ok, red_ok)
    for region in args.regions:
        skus = az.region_vm_skus(region)
        if not skus:
            az.log(f"  {region:20s} — no SKU data (skipped)")
            continue
        dc_ok = _avail(skus, args.dc_sizes)
        red_ok = _avail(skus, args.redamon_sizes)
        both = bool(dc_ok) and bool(red_ok)
        flag = "OK " if both else "-- "
        az.log(f"  {flag}{region:20s} DC:[{', '.join(dc_ok) or 'none'}]  "
               f"RedAmon:[{', '.join(red_ok) or 'none'}]")
        if both:
            rows.append((region, dc_ok, red_ok))

    if not rows:
        az.log("No probed region has capacity for BOTH a DC size and a RedAmon size. "
               "This looks subscription-wide — options: request access/capacity via an Azure "
               "support ticket, try --regions with more regions, or use a different subscription. "
               f"Emitting default {args.default_region}.")
        print(args.default_region)
        return 0

    # Rank: most candidate sizes available first; ties broken by --regions order (preference).
    order = {r: i for i, r in enumerate(args.regions)}
    rows.sort(key=lambda r: (-(len(r[1]) + len(r[2])), order.get(r[0], 999)))
    best, dc_ok, red_ok = rows[0]

    az.log("")
    az.log(f"→ recommended region: {best}")
    az.log(f"    GOAD DC size will be {dc_ok[0]} (x{DC_COUNT}); RedAmon {red_ok[0]} (x{RED_COUNT})")
    az.log(f"    {len(rows)} region(s) have capacity: {', '.join(r[0] for r in rows)}")
    az.log("  Next:")
    az.log(f"    python3 scripts/goad_azure_prep.py --region {best} --request-quota")
    az.log(f"    AISOC_REQUEST_QUOTA=1 ./aisoc_demo.sh deploy --deploy-goad --with-redamon --goad-location={best}")
    print(best)  # <-- contract: last stdout line = the recommended region
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
