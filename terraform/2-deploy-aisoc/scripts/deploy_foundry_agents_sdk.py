#!/usr/bin/env python3

"""Deploy Foundry agents using the official Azure AI Projects SDK.

This follows MSFT guidance from:
- https://learn.microsoft.com/en-us/azure/foundry/quickstarts/get-started-code

Prereqs:
- az login
- pip install azure-ai-projects>=2.0.0 azure-identity

Usage:
  cd terraform/2-deploy-aisoc
  python3 scripts/deploy_foundry_agents_sdk.py --endpoint <PROJECT_ENDPOINT>

You can also omit --endpoint if TF output provides it (optional future enhancement).

Note: Tool wiring support depends on SDK surface. This script creates the agent first.
"""

from __future__ import annotations

import argparse
import json
import os
import sys


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--endpoint",
        default=os.environ.get("PROJECT_ENDPOINT"),
        help="Foundry Project endpoint, e.g. https://<resource>.services.ai.azure.com/api/projects/<project>",
    )
    ap.add_argument("--name", default="SOC Analyst")
    ap.add_argument(
        "--instructions",
        default="You are a SOC analyst. Use your available tools to query logs and triage alerts.",
    )
    args = ap.parse_args()

    if not args.endpoint:
        print("ERROR: missing --endpoint (or env PROJECT_ENDPOINT)")
        return 2

    try:
        from azure.identity import DefaultAzureCredential
        from azure.ai.projects import AIProjectClient
    except Exception as e:
        print("ERROR: missing dependencies. Install:")
        print("  pip install azure-ai-projects>=2.0.0 azure-identity")
        print(str(e))
        return 3

    # CLI auth works with DefaultAzureCredential when logged in via `az login`.
    credential = DefaultAzureCredential()

    project = AIProjectClient(endpoint=args.endpoint, credential=credential)

    # Agents API surface changes quickly; keep this best-effort and print helpful errors.
    try:
        # New SDKs typically expose an Agents client.
        agents = project.agents  # type: ignore[attr-defined]
    except Exception:
        agents = None

    if agents is None:
        print("ERROR: This azure-ai-projects version does not expose project.agents. Please upgrade the package.")
        return 4

    try:
        agent = agents.create_agent(
            name=args.name,
            instructions=args.instructions,
        )
    except Exception as e:
        print("ERROR: create_agent failed")
        print(str(e))
        return 5

    print("Agent created:")
    print(json.dumps(getattr(agent, "__dict__", {}), indent=2, default=str)[:4000])

    print("\nNext step: tool wiring")
    print("- We need to add the runner tool to this agent. SDK surface differs by version.")
    print("- If you want, paste your installed azure-ai-projects version and I will wire tools accordingly.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
