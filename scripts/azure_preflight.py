#!/usr/bin/env python3
"""Azure preflight for aisoc-lab's own VM (RedAmon / Phase 5).

Picks a RedAmon VM size that actually has CAPACITY + quota headroom in the
target region, and (optionally) best-effort-requests the auto-grantable
"Total Regional vCPUs" bump. Prints the chosen size on the LAST stdout line so
the driver can capture it:

    SIZE=$(python3 scripts/azure_preflight.py --region westus)
    export TF_VAR_redamon_size="$SIZE"

Everything else (diagnostics, warnings) goes to stderr, so the stdout contract
stays a single size string. If nothing can be resolved it prints the default
size and exits 0 — the deploy then fails with Azure's own clear error, no worse
than before.

Why: West US (and other regions on fresh subs) cap whole VM families (DSv3),
and Azure won't raise a capped family — so hardcoding D4s_v3 breaks on a new
subscription. This selects a family that has room instead.
"""
from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib_azure_capacity as az  # noqa: E402

# 4 vCPU / 16 GB candidates, most-preferred first. D4as_v4 (AMD) leads because
# it's widely available when the Intel DSv3/DSv5 families are capacity-capped.
REDAMON_CANDIDATES = [
    "Standard_D4as_v4", "Standard_D4s_v5", "Standard_D4as_v5",
    "Standard_D4s_v4", "Standard_D4_v5", "Standard_F4s_v2", "Standard_D4s_v3",
]


def main() -> int:
    ap = argparse.ArgumentParser(description="Pick a capacity-available RedAmon VM size.")
    ap.add_argument("--region", required=True)
    ap.add_argument("--subscription", default=None)
    ap.add_argument("--default-size", default="Standard_D4as_v4")
    ap.add_argument("--vcpus", type=int, default=4)
    ap.add_argument("--candidates", nargs="*", default=REDAMON_CANDIDATES)
    ap.add_argument("--regional-headroom", type=int, default=6,
                    help="Total Regional vCPUs to ensure free for RedAmon + slack.")
    ap.add_argument("--request-quota", action="store_true",
                    help="Best-effort raise Total Regional (+ the chosen family) via Microsoft.Quota.")
    args = ap.parse_args()

    sub = args.subscription or az.current_subscription()
    if not sub:
        az.log("no subscription (az not logged in?) — emitting default size, letting the deploy validate it")
        print(args.default_size)
        return 0

    az.log(f"region={args.region} sub={sub}")
    usage = az.region_usage(args.region)

    # 1) Total Regional vCPUs — the auto-grantable one.
    total = usage.get("cores")
    if total:
        needed = total["current"] + args.regional_headroom
        r = az.ensure_quota(sub, args.region, "cores", needed, usage, do_request=args.request_quota)
        if not r["ok"] and r["action"] in ("needs-raise",):
            az.log(f"NOTE: Total Regional vCPUs limit {r['limit']} is tight; "
                   f"raise it to ~{needed} (portal → Usage+quotas) or pass --request-quota.")

    # 2) Capacity-aware size pick.
    pick = az.pick_size(args.region, args.candidates, args.vcpus, usage)
    if not pick:
        az.log(f"WARNING: none of {args.candidates} has capacity in {args.region}; "
               f"emitting default {args.default_size} (deploy may fail — check portal 'Get recommendations').")
        print(args.default_size)
        return 0

    # 3) If the chosen family is short on quota, best-effort raise it.
    if not pick["quota_ok"] and pick["family"]:
        if args.request_quota:
            az.ensure_quota(sub, args.region, pick["family"], (pick["headroom"] or 0) + args.vcpus,
                            usage, do_request=True)
        else:
            az.log(f"NOTE: family {pick['family']} headroom {pick['headroom']} < {args.vcpus}; "
                   f"raise it or pass --request-quota (auto-approves for standard families).")

    az.log(f"selected RedAmon size: {pick['size']} (family {pick['family']}, "
           f"headroom {pick['headroom']})")
    print(pick["size"])  # <-- the contract: last stdout line = the size
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
