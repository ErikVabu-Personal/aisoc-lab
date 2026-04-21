#!/usr/bin/env python3

"""Deploy Azure AI Foundry Agents + wire Runner tool (demo, portal-compatible).

This script targets the same "nextgen" API surface the Foundry portal uses.

Prereqs:
- az login
- terraform apply in terraform/2-deploy-aisoc (creates Foundry hub/project + runner)

What it does:
- Ensures an agent application exists (via ai.azure.com/nextgen API)
- (Placeholder) Prints out where to wire the runner tool. The exact payload for tool
  wiring depends on the Agent Application schema, which varies.

Next step after this script runs: we can extend it to PATCH the application with tools,
once we capture the portal's request for tool wiring (network tab).
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from typing import Any, Dict

import requests


def run(cmd: list[str]) -> str:
    p = subprocess.run(cmd, capture_output=True, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"Command failed ({p.returncode}): {' '.join(cmd)}\n{p.stderr}")
    return p.stdout.strip()


def tf_outputs() -> Dict[str, Any]:
    out = run(["terraform", "output", "-json"])
    return json.loads(out)


def get_val(tf: Dict[str, Any], key: str) -> Any:
    if key not in tf:
        raise KeyError(f"Missing terraform output: {key}")
    return tf[key].get("value")


def az_token_scope(scope: str) -> str:
    out = run([
        "az",
        "account",
        "get-access-token",
        "--scope",
        scope,
        "-o",
        "json",
    ])
    j = json.loads(out)
    return j["accessToken"]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--application-name", default="soc-analyst")
    ap.add_argument("--agent-name", default="SOC Analyst")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    try:
        token = az_token_scope("https://ai.azure.com/.default")
    except Exception:
        print("ERROR: Azure CLI auth not available. Run `az login` first.", file=sys.stderr)
        return 2

    tf = tf_outputs()

    sub_id = get_val(tf, "subscription_id") if "subscription_id" in tf else run(["az", "account", "show", "--query", "id", "-o", "tsv"])
    rg = get_val(tf, "resource_group") if "resource_group" in tf else None
    if not rg:
        # Phase 2 uses Phase 1 RG; grab it from remote_state-like output if present
        rg = get_val(tf, "resource_group_name") if "resource_group_name" in tf else None
    if not rg:
        # last resort: ask user to rely on existing TF outputs (should exist in this stack)
        rg = get_val(tf, "foundry_rg") if "foundry_rg" in tf else None

    hub = get_val(tf, "foundry_hub_name")
    project = get_val(tf, "foundry_project_name")

    runner_url = get_val(tf, "runner_url")
    runner_secret_name = get_val(tf, "runner_bearer_token_secret_name")

    # KV name
    kv_name = tf.get("key_vault_name", {}).get("value")
    if not kv_name:
        kv_id = get_val(tf, "key_vault_id")
        kv_name = kv_id.split("/")[-1]

    runner_bearer = run([
        "az",
        "keyvault",
        "secret",
        "show",
        "--vault-name",
        kv_name,
        "--name",
        runner_secret_name,
        "--query",
        "value",
        "-o",
        "tsv",
    ])

    if not rg:
        print("ERROR: Could not determine resource group name from outputs. Please add an output or pass it in.")
        return 3

    base = "https://ai.azure.com/nextgen/api"

    # 1) Ensure agent application exists / can be retrieved.
    url = (
        f"{base}/getAgentApplication"
        f"?subscriptionId={sub_id}"
        f"&resourceGroup={rg}"
        f"&aiResource={hub}"
        f"&project={project}"
        f"&applicationName={args.application_name}"
    )

    print(f"GET {url}")

    headers = {
        "Authorization": f"Bearer {token}",
        "accept": "application/json",
    }

    r = requests.get(url, headers=headers, timeout=60)
    if r.status_code == 404:
        print("Agent application not found (404).")
        print("We need to call the portal's create endpoint next (capture from network tab).")
        return 4

    if r.status_code >= 300:
        print("ERROR: getAgentApplication failed")
        print(r.status_code)
        print(r.text[:4000])
        return 5

    app = r.json()
    print("Agent application retrieved.")

    if args.dry_run:
        print("--- DRY RUN: runner tool wiring plan ---")
        print(json.dumps({
            "runner_url": runner_url,
            "auth_header": "x-aisoc-runner-key",
            "runner_bearer": "<redacted>",
        }, indent=2))
        return 0

    # Until we capture the exact tool wiring request from the portal, we won't mutate the application.
    print("\nNext step needed:")
    print("- In Foundry portal, add a tool/connection to your agent that calls the runner.")
    print("- Capture that network request (URL + method + JSON body) and paste it here.")
    print("\nRunner wiring values:")
    print(f"- runner_url: {runner_url}")
    print(f"- header: x-aisoc-runner-key")
    print(f"- token (from KV secret {runner_secret_name}): {runner_bearer[:6]}... (redacted)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
