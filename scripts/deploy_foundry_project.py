#!/usr/bin/env python3
"""Create/update an Azure AI Foundry Project under a Cognitive Services AIServices account.

Why this exists:
- In some tenants, creating `Microsoft.CognitiveServices/accounts/projects` via Terraform/AzAPI
  with minimal properties yields misleading generic errors.
- The Azure Portal creates projects using API version 2026-01-15-preview and includes extra
  required fields (identity + displayName/description + location). This script replicates that.

This script is intentionally idempotent:
- If the project exists, it updates it.
- If it doesn't, it creates it.

Inputs:
- Terraform outputs from terraform/2-deploy-aisoc/terraform.tfstate (local backend)
- Azure CLI auth context (uses `az account get-access-token`)

Usage:
  python3 scripts/deploy_foundry_project.py \
    --tfstate terraform/2-deploy-aisoc/terraform.tfstate \
    --resource-group rg-sentinel-test

Notes:
- Project name is taken from Terraform output `foundry_project_name` (auto-generated if unset).
- API version is pinned to 2026-01-15-preview to match Portal behavior.
"""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

API_VERSION = "2026-01-15-preview"


def sh(cmd: list[str]) -> str:
    p = subprocess.run(cmd, check=True, capture_output=True, text=True)
    return p.stdout


def load_tf_outputs(tfstate_path: Path) -> dict:
    data = json.loads(tfstate_path.read_text(encoding="utf-8"))
    outputs = data.get("outputs", {})
    return {k: v.get("value") for k, v in outputs.items()}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--tfstate",
        type=Path,
        default=Path("terraform/2-deploy-aisoc/terraform.tfstate"),
        help="Path to Phase 2 tfstate (local backend).",
    )
    ap.add_argument(
        "--resource-group",
        required=True,
        help="Resource group containing the Foundry account (hub).",
    )
    ap.add_argument(
        "--subscription-id",
        default=None,
        help="Optional override. If omitted, uses `az account show`.",
    )
    args = ap.parse_args()

    if not args.tfstate.exists():
        raise SystemExit(f"tfstate not found: {args.tfstate}")

    o = load_tf_outputs(args.tfstate)

    hub = o.get("foundry_hub_name")
    proj = o.get("foundry_project_name")
    location = o.get("foundry_location")

    if not hub or not proj or not location:
        raise SystemExit(
            f"Missing outputs. Need foundry_hub_name, foundry_project_name, foundry_location. Got: hub={hub} proj={proj} location={location}"
        )

    sub = args.subscription_id
    if not sub:
        sub = json.loads(sh(["az", "account", "show", "-o", "json"]))["id"]

    url = (
        f"https://management.azure.com/subscriptions/{sub}/resourceGroups/{args.resource_group}"
        f"/providers/Microsoft.CognitiveServices/accounts/{hub}/projects/{proj}?api-version={API_VERSION}"
    )

    body = {
        "location": location,
        "identity": {"type": "SystemAssigned"},
        "properties": {
            "displayName": proj,
            "description": proj,
        },
    }

    print("PUT", url)
    print(json.dumps(body, indent=2))

    out = sh(
        [
            "az",
            "rest",
            "--method",
            "put",
            "--url",
            url,
            "--headers",
            "Content-Type=application/json",
            "--body",
            json.dumps(body),
            "-o",
            "json",
        ]
    )

    data = json.loads(out)
    state = data.get("properties", {}).get("provisioningState")
    print("Result provisioningState:", state)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
