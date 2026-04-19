#!/usr/bin/env python3

"""Create (or confirm) an Azure AI Foundry Project under an existing Hub.

Why this script exists:
- Foundry Project creation via ARM/AzAPI can take a long time and can exceed
  Terraform provider deadlines.
- This script uses Azure CLI auth (simple for demos) and is retry/poll friendly.

Usage:
  cd terraform/2-deploy-aisoc
  terraform output -json > /tmp/tfout.json
  python3 scripts/deploy_foundry_project.py --tfout /tmp/tfout.json

Or simply:
  python3 scripts/deploy_foundry_project.py

It will run `terraform output -json` automatically if --tfout is not provided.
"""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from typing import Any, Dict, Optional


def run(cmd: list[str], capture: bool = True) -> str:
    p = subprocess.run(cmd, capture_output=capture, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"Command failed ({p.returncode}): {' '.join(cmd)}\n{p.stderr}")
    return p.stdout.strip() if capture else ""


def az_token() -> str:
    # Validate we're logged in and can get a token.
    out = run([
        "az",
        "account",
        "get-access-token",
        "--resource",
        "https://management.azure.com/",
        "-o",
        "json",
    ])
    j = json.loads(out)
    return j["accessToken"]


def tf_outputs(tfout_path: Optional[str]) -> Dict[str, Any]:
    if tfout_path:
        with open(tfout_path, "r", encoding="utf-8") as f:
            return json.load(f)
    out = run(["terraform", "output", "-json"])
    return json.loads(out)


def get_val(tf: Dict[str, Any], key: str) -> Any:
    if key not in tf:
        raise KeyError(f"Missing terraform output: {key}")
    return tf[key].get("value")


def az_rest(method: str, url: str, body: Optional[dict] = None) -> dict:
    cmd = ["az", "rest", "--method", method, "--url", url]
    if body is not None:
        cmd += ["--body", json.dumps(body)]
    out = run(cmd)
    return json.loads(out) if out else {}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--tfout", help="Path to terraform output -json file")
    ap.add_argument("--poll-seconds", type=int, default=10)
    ap.add_argument("--timeout-seconds", type=int, default=3600)
    args = ap.parse_args()

    # Ensure CLI auth works early.
    try:
        _ = az_token()
    except Exception as e:
        print("ERROR: Azure CLI auth not available. Run `az login` first.", file=sys.stderr)
        print(str(e), file=sys.stderr)
        return 2

    tf = tf_outputs(args.tfout)

    hub_id = get_val(tf, "foundry_hub_id")
    project_name = get_val(tf, "foundry_project_name")
    api_version = get_val(tf, "foundry_api_version") or "2025-10-01-preview"

    project_url = f"https://management.azure.com{hub_id}/projects/{project_name}?api-version={api_version}"

    # Fast path: already exists
    try:
        existing = az_rest("GET", project_url)
        if existing.get("id"):
            print(f"Foundry project already exists: {existing['id']}")
            return 0
    except Exception:
        pass

    print(f"Creating Foundry project '{project_name}' under hub {hub_id}...")
    body = {
        "location": get_val(tf, "foundry_location"),
        "properties": {},
    }

    # PUT create
    az_rest("PUT", project_url, body=body)

    # Poll for readiness
    start = time.time()
    while True:
        if time.time() - start > args.timeout_seconds:
            raise RuntimeError("Timed out waiting for Foundry project creation")

        try:
            j = az_rest("GET", project_url)
            state = (j.get("properties") or {}).get("provisioningState")
            if j.get("id") and (state is None or state == "Succeeded"):
                print(f"Foundry project ready: {j['id']}")
                return 0
            if state in ("Failed", "Canceled"):
                raise RuntimeError(f"Project provisioningState={state}: {json.dumps(j)[:2000]}")
            print(f"Waiting... provisioningState={state}")
        except Exception as e:
            print(f"Waiting... (GET failed: {e})")

        time.sleep(args.poll_seconds)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit(130)
