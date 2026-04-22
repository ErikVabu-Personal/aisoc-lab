#!/usr/bin/env python3
"""Create or update a Foundry Workflow (portal-compatible).

Uses the Foundry "nextgen" query endpoint observed from the portal:
POST https://ai.azure.com/nextgen/api/query?createOrUpdateWorkflowResolver

This script is intentionally minimal and uses the same payload shape as the portal.

Env vars:
- AZURE_SUBSCRIPTION_ID
- AZURE_RESOURCE_GROUP
- AZURE_FOUNDRY_HUB_NAME
- AZURE_FOUNDRY_PROJECT_NAME

Optional:
- AISOC_WORKFLOW_NAME (default: aisoc-incident-pipeline)
- AISOC_WORKFLOW_YAML (default: workflows/aisoc-incident-pipeline.yaml)
- AISOC_USE_FOUNDRY_V2 (default: true)

Auth:
- Requires `az login`.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import requests


def run(cmd: list[str]) -> str:
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"Command failed ({p.returncode}): {' '.join(cmd)}\n{p.stderr}")
    return p.stdout.strip()


def az_token() -> str:
    out = run(
        [
            "az",
            "account",
            "get-access-token",
            "--scope",
            "https://ai.azure.com/.default",
            "-o",
            "json",
        ]
    )
    return json.loads(out)["accessToken"]


def main() -> int:
    sub = os.environ.get("AZURE_SUBSCRIPTION_ID", "").strip()
    rg = os.environ.get("AZURE_RESOURCE_GROUP", "").strip()
    hub = os.environ.get("AZURE_FOUNDRY_HUB_NAME", "").strip()
    proj = os.environ.get("AZURE_FOUNDRY_PROJECT_NAME", "").strip()

    if not (sub and rg and hub and proj):
        print(
            "ERROR: missing env vars: AZURE_SUBSCRIPTION_ID, AZURE_RESOURCE_GROUP, AZURE_FOUNDRY_HUB_NAME, AZURE_FOUNDRY_PROJECT_NAME",
            file=sys.stderr,
        )
        return 2

    workflow_name = os.environ.get("AISOC_WORKFLOW_NAME", "aisoc-incident-pipeline").strip()
    yaml_path = Path(os.environ.get("AISOC_WORKFLOW_YAML", "workflows/aisoc-incident-pipeline.yaml"))
    use_v2 = os.environ.get("AISOC_USE_FOUNDRY_V2", "true").lower() in ("1", "true", "yes")

    if not yaml_path.exists():
        print(f"ERROR: workflow YAML not found: {yaml_path}", file=sys.stderr)
        return 3

    workflow_yaml = yaml_path.read_text(encoding="utf-8")

    resource_id = (
        f"/subscriptions/{sub}"
        f"/resourceGroups/{rg}"
        f"/providers/Microsoft.CognitiveServices/accounts/{hub}"
        f"/projects/{proj}"
    )

    token = az_token()

    url = "https://ai.azure.com/nextgen/api/query?createOrUpdateWorkflowResolver"
    body = {
        "query": "createOrUpdateWorkflowResolver",
        "params": {
            "resourceId": resource_id,
            "workflowName": workflow_name,
            "workflowData": {
                "name": workflow_name,
                "description": "",
                "definition": {
                    "kind": "workflow",
                    "id": "",
                    "name": workflow_name,
                    "description": "",
                    # Portal sends a YAML string under the key "workflow"
                    "workflow": workflow_yaml,
                },
            },
            "useFoundryV2": use_v2,
        },
    }

    r = requests.post(
        url,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json=body,
        timeout=60,
    )

    if r.status_code >= 300:
        print("ERROR: workflow upsert failed", file=sys.stderr)
        print(r.status_code, file=sys.stderr)
        print(r.text[:4000], file=sys.stderr)
        return 4

    print("OK: workflow created/updated")
    print(r.text[:4000])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
