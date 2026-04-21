#!/usr/bin/env python3
"""Deploy a Foundry Prompt (Native) Agent from AgentSchema YAML.

Based on the approach in:
https://github.com/munozrickzim/prompt-agent-deploy-examples

Auth:
- Uses DefaultAzureCredential (works with az login)

Env vars expected (we will set them from Terraform in a wrapper script):
- AZURE_AI_FOUNDRY_PROJECT_ENDPOINT
- AZURE_AI_MODEL_DEPLOYMENT
- AISOC_RUNNER_OPENAPI_URL
- AISOC_RUNNER_BEARER

Usage:
  python3 scripts/deploy_prompt_agent.py --agent-yaml agents/soc_analyst/agent.yaml
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path
from typing import Optional

import yaml


def _resolve_env_placeholders(obj):
    if isinstance(obj, str):
        import re

        def replacer(match):
            var = match.group(1)
            return os.environ.get(var, "")

        return re.sub(r"\$\{([^}]+)\}", replacer, obj)
    if isinstance(obj, dict):
        return {k: _resolve_env_placeholders(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_resolve_env_placeholders(v) for v in obj]
    return obj


def load_agent_definition(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as f:
        d = yaml.safe_load(f)
    return _resolve_env_placeholders(d)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--agent-yaml", required=True)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    endpoint = os.environ.get("AZURE_AI_FOUNDRY_PROJECT_ENDPOINT")
    if not endpoint:
        print("ERROR: AZURE_AI_FOUNDRY_PROJECT_ENDPOINT is required", file=sys.stderr)
        return 2

    agent_path = Path(args.agent_yaml).resolve()
    if not agent_path.exists():
        print(f"ERROR: agent yaml not found: {agent_path}", file=sys.stderr)
        return 3

    agent_def = load_agent_definition(agent_path)

    name = agent_def.get("name")
    instructions = agent_def.get("instructions")
    model_id = (agent_def.get("model") or {}).get("id")

    if not name or not instructions or not model_id:
        print("ERROR: agent.yaml must include name, instructions, model.id", file=sys.stderr)
        return 4

    if args.dry_run:
        print("--- DRY RUN ---")
        print(f"endpoint={endpoint}")
        print(f"name={name}")
        print(f"model={model_id}")
        print(f"tools={agent_def.get('tools', [])}")
        return 0

    try:
        from azure.ai.projects import AIProjectClient
        from azure.ai.projects.models import PromptAgentDefinition
        from azure.identity import DefaultAzureCredential
    except Exception as e:
        print("ERROR: missing SDK deps. Install azure-ai-projects>=2.0.0 azure-identity pyyaml", file=sys.stderr)
        print(str(e), file=sys.stderr)
        return 5

    client = AIProjectClient(endpoint=endpoint, credential=DefaultAzureCredential())

    # NOTE: We keep tools empty here because tool schema compatibility can vary.
    # We'll iterate once we confirm the SDK supports OpenAPI tools for prompt agents.
    existing = None
    try:
        for a in client.agents.list_agents():
            if a.name == name:
                existing = a
                break
    except Exception as e:
        print(f"WARN: list_agents failed: {e}")

    desc = agent_def.get("description", "")

    agent = client.agents.create_version(
        agent_name=name,
        definition=PromptAgentDefinition(
            model=model_id,
            instructions=instructions,
            tools=[],
        ),
        description=desc,
    )

    print(f"OK: published agent version name={agent.name} version={getattr(agent, 'version', None)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
