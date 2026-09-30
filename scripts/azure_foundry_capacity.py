#!/usr/bin/env python3
"""Cap a Foundry model deployment's capacity to the model's available TPM quota.

Foundry model TPM quotas are PER-MODEL: Anthropic Opus models default to ~509 (thousands
TPM) in eastus2, Sonnet/Haiku to 1000, GPT models higher — so a fixed deployment capacity
(the demo used 1500, tuned for gpt-4.1-mini) exceeds the Opus quota and fails the model
deployment with `400 InsufficientQuota`. This prints the capacity to actually request —
`min(want, available)` — on the LAST stdout line, so the driver can capture it:

    CAP=$(python3 scripts/azure_foundry_capacity.py --region eastus2 --model claude-opus-5-5 --want 1500)
    export TF_VAR_foundry_model_sku_capacity="$CAP"

Best-effort: if the quota can't be read (az not logged in, model not found), it prints
`want` unchanged and the deploy validates it (no worse than before). Diagnostics go to
stderr, keeping the stdout contract a single integer.
"""
from __future__ import annotations

import argparse
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import lib_azure_capacity as az  # noqa: E402


def main() -> int:
    ap = argparse.ArgumentParser(description="Cap Foundry model capacity to available TPM quota.")
    ap.add_argument("--region", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--sku", default="GlobalStandard")
    ap.add_argument("--want", type=int, required=True)
    args = ap.parse_args()

    limit = az.model_tpm_quota(args.region, args.model, args.sku)
    if limit is None:
        az.log(f"quota for {args.model} ({args.sku}) not found in {args.region} — using requested {args.want}")
        print(args.want)
        return 0

    limiti = int(limit)
    if limiti < 1:
        # Shouldn't happen (a deployable model has a >=1 limit), but never emit a
        # capacity < 1 (400 InvalidCapacity). Fall back to the requested value.
        az.log(f"{args.model}: quota limit read as {limiti} (<1) — using requested {args.want}")
        print(args.want)
        return 0

    if args.want > limiti:
        az.log(f"{args.model}: requested capacity {args.want} > quota limit {limiti} "
               f"(thousands TPM) in {args.region} — capping to {limiti}. Raise the "
               f"'Tokens Per Minute (thousands) - {args.model}' quota in the portal for more.")
        print(limiti)
    else:
        az.log(f"{args.model}: requested capacity {args.want} fits quota limit {limiti} (thousands TPM)")
        print(args.want)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
