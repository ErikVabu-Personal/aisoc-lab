#!/usr/bin/env python3
"""Deploy Azure AI Foundry agents for AISOC.

This is intentionally a *scripted* control-plane step because Foundry agent/model
APIs evolve faster than Terraform providers.

Current behavior (stub):
- Reads Terraform outputs from a Phase-2 state file (local backend)
- Prints the resolved config that will be used to create/update agents

Next iterations:
- Create/update 3 agents (Triage, Investigator, Reporter)
- Attach tool definitions that call the SOC Gateway Function endpoints
- Enforce read/write separation via AISOC_READ_KEY vs AISOC_WRITE_KEY

Usage:
  python3 scripts/deploy_agents.py \
    --tfstate terraform/2-deploy-aisoc/terraform.tfstate

Notes:
- Do NOT hardcode secrets in tfvars or this script.
- Use Key Vault / Function App settings for keys.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def load_tf_outputs(tfstate_path: Path) -> dict:
    data = json.loads(tfstate_path.read_text(encoding="utf-8"))
    outputs = data.get("outputs", {})
    # outputs are {name: {value: ...}}
    return {k: v.get("value") for k, v in outputs.items()}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--tfstate",
        type=Path,
        default=Path("terraform/2-deploy-aisoc/terraform.tfstate"),
        help="Path to the Phase 2 Terraform state file (local backend).",
    )
    args = ap.parse_args()

    if not args.tfstate.exists():
        raise SystemExit(
            f"tfstate not found at {args.tfstate}. Run terraform apply in terraform/2-deploy-aisoc first."
        )

    o = load_tf_outputs(args.tfstate)

    config = {
        "soc_gateway_function_name": o.get("soc_gateway_function_name"),
        "key_vault_uri": o.get("key_vault_uri"),
        "foundry": {
            "hub_name": o.get("foundry_hub_name"),
            "project_name": o.get("foundry_project_name"),
            "location": o.get("foundry_location"),
            "model_choice": o.get("foundry_model_choice"),
            "model_deployment_name": o.get("foundry_model_deployment_name"),
        },
    }

    print("Resolved deployment config (stub):")
    print(json.dumps(config, indent=2))

    missing = []
    if not config["foundry"]["hub_name"]:
        missing.append("foundry_hub_name")
    if not config["foundry"]["project_name"]:
        missing.append("foundry_project_name")
    if not config["foundry"]["model_deployment_name"]:
        missing.append("foundry_model_deployment_name")

    if missing:
        print("\nMissing required Foundry settings (set in terraform.tfvars):")
        for m in missing:
            print(f"- {m}")
        print("\nNo changes were made (stub mode).")
        return 2

    print("\nNext: implement Foundry agent create/update calls here.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
