#!/usr/bin/env python3
"""Remove AISOC prompt agents from an Azure AI Foundry project.

This deletes the agent definitions by agent_name (slug), which removes all versions.

Env vars required:
- AZURE_AI_FOUNDRY_PROJECT_ENDPOINT

Optional:
- AISOC_AGENT_NAMES  (comma-separated slugs; defaults to triage,investigator,reporter,detection-engineer)

Usage:
  python3 scripts/remove_prompt_agents.py [--dry-run]
"""

from __future__ import annotations

import argparse
import os
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    endpoint = os.environ.get("AZURE_AI_FOUNDRY_PROJECT_ENDPOINT", "").strip()
    if not endpoint:
        print("ERROR: missing AZURE_AI_FOUNDRY_PROJECT_ENDPOINT", file=sys.stderr)
        return 2

    names_raw = os.environ.get("AISOC_AGENT_NAMES", "triage,investigator,reporter,detection-engineer")
    names = [x.strip() for x in names_raw.split(",") if x.strip()]

    try:
        from azure.identity import DefaultAzureCredential
        from azure.ai.projects import AIProjectClient
    except Exception as e:
        print("ERROR: missing azure-ai-projects / azure-identity. Run via the .sh wrapper to auto-install.", file=sys.stderr)
        print(str(e), file=sys.stderr)
        return 3

    client = AIProjectClient(endpoint=endpoint, credential=DefaultAzureCredential())

    for name in names:
        if args.dry_run:
            print(f"DRY RUN: would delete agent: {name}")
            continue
        try:
            # SDK method name can vary; this is the current surface used by our deploy script.
            client.agents.delete(agent_name=name)  # type: ignore[attr-defined]
            print(f"OK: deleted agent: {name}")
        except Exception as e:
            # If it doesn't exist, treat as success.
            msg = str(e)
            if "404" in msg or "NotFound" in msg or "not found" in msg.lower():
                print(f"OK: agent not found (already gone): {name}")
                continue
            print(f"ERROR: failed to delete agent {name}: {e}", file=sys.stderr)
            return 4

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
