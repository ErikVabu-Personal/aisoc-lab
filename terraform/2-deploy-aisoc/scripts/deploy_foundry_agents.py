#!/usr/bin/env python3

"""Deploy Azure AI Foundry Agents + wire Runner tool (demo).

This is intentionally pragmatic:
- Uses Azure CLI auth (az login)
- Reads Terraform outputs
- Calls the Foundry Project "AI Foundry API" endpoint returned by the project resource

What it does:
- Creates/updates a simple agent
- Registers a tool pointing to the AISOC Runner (OpenAPI-ish tool concept)

NOTE: Foundry agent/tool APIs evolve. This script is meant to be edited quickly.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from typing import Any, Dict, Optional

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


def az_token() -> str:
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


def az_rest(method: str, url: str, body: Optional[dict] = None) -> dict:
    cmd = ["az", "rest", "--method", method, "--url", url]
    if body is not None:
        cmd += ["--body", json.dumps(body)]
    out = run(cmd)
    return json.loads(out) if out else {}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--agent-name", default="SOC Analyst")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    try:
        _ = az_token()
    except Exception:
        print("ERROR: Azure CLI auth not available. Run `az login` first.", file=sys.stderr)
        return 2

    tf = tf_outputs()

    project_id = get_val(tf, "foundry_project_id")
    if not project_id:
        print("ERROR: Terraform output foundry_project_id is null. Ensure foundry_manage_project_in_terraform=true and apply succeeded.")
        return 3

    # Read project to get the Foundry API endpoint.
    api_version = get_val(tf, "foundry_api_version") or "2025-06-01"
    proj = az_rest("GET", f"https://management.azure.com{project_id}?api-version={api_version}")
    foundry_api = (proj.get("properties", {}).get("endpoints", {}) or {}).get("AI Foundry API")
    if not foundry_api:
        print("ERROR: Project does not expose properties.endpoints['AI Foundry API']")
        print(json.dumps(proj, indent=2)[:4000])
        return 4

    runner_url = get_val(tf, "runner_url")
    runner_secret_name = get_val(tf, "runner_bearer_token_secret_name")

    print(f"Foundry API: {foundry_api}")
    print(f"Runner URL: {runner_url}")
    print(f"Runner bearer secret name (KV): {runner_secret_name}")

    # Retrieve runner bearer token from Key Vault (CLI). KV name is output as key_vault_name.
    # Prefer dedicated output if present; fall back to existing/older output name.
    kv_name = tf.get("key_vault_name", {}).get("value") or get_val(tf, "key_vault_id").split("/")[-1]
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

    # Minimal agent payload (placeholder schema; adjust as Foundry GA stabilizes)
    agent_payload = {
        "name": args.agent_name,
        "instructions": "You are a SOC analyst. Use the runner tool to query logs and triage alerts.",
        "tools": [
            {
                "type": "openapi",
                "name": "aisoc-runner",
                "description": "Tool gateway for KQL/Sentinel actions.",
                "endpoint": runner_url,
                "auth": {
                    "type": "header",
                    "header": "x-aisoc-runner-key",
                    "value": runner_bearer,
                },
            }
        ],
    }

    if args.dry_run:
        print("--- DRY RUN agent payload ---")
        print(json.dumps(agent_payload, indent=2)[:4000])
        return 0

    # Try a best-effort create call. The exact endpoint may vary; we keep this script small and hackable.
    # Typical pattern is something like POST {foundry_api}/agents
    url = f"{foundry_api}/agents"
    print(f"POST {url}")

    # Use ARM token as bearer (many Foundry APIs accept AAD token).
    token = az_token()
    r = requests.post(url, json=agent_payload, headers={"Authorization": f"Bearer {token}"}, timeout=60)
    if r.status_code >= 300:
        print("ERROR: agent create failed")
        print(r.status_code)
        print(r.text[:4000])
        return 5

    print("Agent created:")
    print(r.text[:4000])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
