#!/usr/bin/env python3
"""Deploy Azure AI Foundry Agents for AISOC.

Creates/updates three agents in a Foundry Project using the Foundry project endpoint
(e.g. https://<host>.services.ai.azure.com/api/projects/<projectName>).

Agents created:
- foundry-aisoc-triage
- foundry-aisoc-investigator
- foundry-aisoc-reporter

Tools:
- Read tools call the SOC Gateway (KQL + incidents) with Function key + AISOC read key
- Write tool (incident PATCH) is only attached when --enable-writes is set

Auth:
- Uses Azure CLI to obtain an access token for https://ai.azure.com/ via `az account get-access-token`.

NOTE: Foundry APIs evolve; if the payload schema changes, run with --dry-run to inspect the request.

Usage:
  python3 scripts/deploy_foundry_agents.py \
    --project-url "https://...services.ai.azure.com/api/projects/<project>" \
    --model-deployment gpt-5.4-mini

  python3 scripts/deploy_foundry_agents.py ... --enable-writes
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from dataclasses import dataclass

import requests


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    method: str
    url: str
    headers: dict
    query: dict


def az_token(resource: str = "https://ai.azure.com/") -> str:
    out = subprocess.check_output(
        ["az", "account", "get-access-token", "--resource", resource, "-o", "json"],
        text=True,
    )
    return json.loads(out)["accessToken"]


def build_tools(gateway_base: str, function_code: str, read_key: str, write_key: str | None) -> list[ToolSpec]:
    def tool(name: str, desc: str, method: str, path: str, scope: str) -> ToolSpec:
        headers = {"Content-Type": "application/json"}
        if scope == "read":
            headers["x-aisoc-key"] = read_key
        else:
            if not write_key:
                raise RuntimeError("write_key missing but write tool requested")
            headers["x-aisoc-key"] = write_key

        return ToolSpec(
            name=name,
            description=desc,
            method=method,
            url=f"{gateway_base.rstrip('/')}/{path.lstrip('/')}" ,
            headers=headers,
            query={"code": function_code},
        )

    tools: list[ToolSpec] = [
        tool(
            "kql_query",
            "Run a KQL query against Log Analytics (POST JSON: {query, timespan}).",
            "POST",
            "kql/query",
            "read",
        ),
        tool(
            "list_incidents",
            "List Sentinel incidents.",
            "GET",
            "sentinel/incidents",
            "read",
        ),
        tool(
            "get_incident",
            "Get a Sentinel incident by id (append /{id}).",
            "GET",
            "sentinel/incidents/{id}",
            "read",
        ),
    ]

    if write_key:
        tools.append(
            tool(
                "update_incident",
                "Update a Sentinel incident by id (PATCH JSON: {properties:{...}}).",
                "PATCH",
                "sentinel/incidents/{id}",
                "write",
            )
        )

    return tools


def foundry_upsert_agent(project_url: str, token: str, agent_name: str, model_deployment: str, instructions: str, tools: list[ToolSpec], dry_run: bool) -> None:
    # NOTE: This is a best-effort payload based on current Foundry agent patterns.
    # If your tenant requires a different schema, run with --dry-run and adjust.

    # Foundry endpoint expects an api-version query parameter.
    # The Foundry REST reference uses api-version=v1 for agents.
    url = project_url.rstrip("/") + "/agents/" + agent_name + "?api-version=v1"

    payload = {
        "name": agent_name,
        "description": instructions[:512],
        "definition": {
            "kind": "prompt",
            "prompt": {
                "instructions": instructions,
                "model": {"deployment": model_deployment},
                "tools": [
                    {
                        "name": t.name,
                        "description": t.description,
                        "type": "http",
                        "http": {
                            "method": t.method,
                            "url": t.url,
                            "headers": t.headers,
                            "query": t.query,
                        },
                    }
                    for t in tools
                ],
            },
        },
    }

    if dry_run:
        print("--- DRY RUN ---")
        print("PUT", url)
        print(json.dumps(payload, indent=2))
        return

    # Foundry REST reference:
    # - Create: POST {endpoint}/agents?api-version=v1
    # - Update: POST {endpoint}/agents/{agent_name}?api-version=v1
    r = requests.post(
        url,
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        json=payload,
        timeout=60,
    )
    if r.status_code >= 400:
        raise RuntimeError(f"Foundry agent upsert failed for {agent_name}: {r.status_code} {r.text}")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--project-url", required=True, help="Foundry project URL: https://<host>.services.ai.azure.com/api/projects/<project>")
    ap.add_argument("--model-deployment", required=True, help="Foundry model deployment name (e.g. gpt-5.4-mini)")
    ap.add_argument("--gateway-base", default="", help="SOC gateway base URL (default from env AISOC_GATEWAY_BASE_URL)")
    ap.add_argument("--function-code", default="", help="Azure Functions key (default from env AISOC_FUNCTION_CODE)")
    ap.add_argument("--read-key", default="", help="AISOC read key (default from env AISOC_READ_KEY)")
    ap.add_argument("--write-key", default="", help="AISOC write key (default from env AISOC_WRITE_KEY)")
    ap.add_argument("--enable-writes", action="store_true", help="Attach write tool (update_incident)")
    ap.add_argument("--prefix", default="foundry-aisoc", help="Agent name prefix")
    ap.add_argument("--dry-run", action="store_true")

    args = ap.parse_args()

    env = dict(**{k: v for k, v in dict(**__import__("os").environ).items()})

    gateway_base = args.gateway_base or env.get("AISOC_GATEWAY_BASE_URL", "")
    function_code = args.function_code or env.get("AISOC_FUNCTION_CODE", "")
    read_key = args.read_key or env.get("AISOC_READ_KEY", "")
    write_key = args.write_key or env.get("AISOC_WRITE_KEY", "")

    if not gateway_base or not function_code or not read_key:
        raise SystemExit("Missing required gateway config. Set AISOC_GATEWAY_BASE_URL, AISOC_FUNCTION_CODE, AISOC_READ_KEY (or pass flags).")

    token = az_token("https://ai.azure.com/")

    effective_write_key = write_key if args.enable_writes else None

    tools = build_tools(gateway_base, function_code, read_key, effective_write_key)

    # Short, Foundry-friendly instruction sets
    triage_instructions = (
        "You are a SOC triage agent. Use tools to gather evidence quickly. "
        "Prefer escalation if evidence is incomplete. Output a concise triage summary and next steps. "
        "Do not perform write actions unless explicitly enabled."
    )

    investigator_instructions = (
        "You are a SOC investigation agent. Use tools to pivot (KQL/incidents) and build hypotheses. "
        "Summarize findings, gaps, and recommended next actions."
    )

    reporter_instructions = (
        "You are a SOC reporting agent. Produce an executive-ready incident summary (what happened, impact, confidence, next steps)."
    )

    agents = [
        (f"{args.prefix}-triage", triage_instructions),
        (f"{args.prefix}-investigator", investigator_instructions),
        (f"{args.prefix}-reporter", reporter_instructions),
    ]

    for name, instr in agents:
        foundry_upsert_agent(args.project_url, token, name, args.model_deployment, instr, tools, args.dry_run)
        print(f"OK: {name}")

    return 0


if __name__ == "__main__":
    sys.exit(main())
