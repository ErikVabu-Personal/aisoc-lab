#!/usr/bin/env python3
"""Deploy multiple prompt agents and attach per-agent OpenAPI runner tool.

Uses Azure AI Projects SDK as per MSFT OpenAPI tool docs.

Env vars required:
- AZURE_AI_FOUNDRY_PROJECT_ENDPOINT
- AZURE_AI_MODEL_DEPLOYMENT
- AISOC_RUNNER_URL
- AISOC_RUNNER_BEARER

This script will:
1) Render OpenAPI specs per agent (x-aisoc-agent default set)
2) Create/update agents by publishing a new version with tools=[OpenApiTool]

NOTE: SDK surface may vary by version. If OpenApiTool types are missing, we'll pin/upgrade.
"""

from __future__ import annotations

import json
import os
import sys
from typing import Any, Dict, List

import jsonref

AGENTS = [
    "Triage",
    "Investigator",
    "Reporter",
    "Detection Engineer",
]


def slug(s: str) -> str:
    import re

    s = s.strip().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = re.sub(r"^-+", "", s)
    s = re.sub(r"-+$", "", s)
    return s[:63]

ROLE_INSTRUCTIONS: Dict[str, str] = {
    "Triage": "You are the triage analyst. Quickly assess alerts and decide severity and next steps.",
    "Investigator": "You are the incident investigator. Deep dive using KQL and produce findings.",
    "Reporter": "You are the incident reporter. Produce clear executive summaries and timelines.",
    "Detection Engineer": "You are the detection engineer. Recommend detection rules and improvements.",
}


def render_openapi(runner_url: str, agent_name: str) -> Dict[str, Any]:
    spec = {
        "openapi": "3.0.3",
        "info": {
            "title": "AISOC Runner",
            "version": "0.1.0",
            "description": "AISOC Runner executes tool calls against SOCGateway.",
        },
        "servers": [{"url": runner_url}],
        "components": {
            "securitySchemes": {
                "runnerKey": {
                    "type": "apiKey",
                    "in": "header",
                    "name": "x-aisoc-runner-key",
                }
            }
        },
        "security": [{"runnerKey": []}],
        "paths": {
            "/healthz": {
                "get": {
                    "operationId": "healthz",
                    "summary": "Health check",
                    "responses": {"200": {"description": "OK"}},
                }
            },
            "/tools/execute": {
                "post": {
                    "operationId": "toolsExecute",
                    "summary": "Execute a tool by name",
                    "parameters": [
                        {
                            "in": "header",
                            "name": "x-aisoc-agent",
                            "required": True,
                            "schema": {"type": "string", "default": agent_name},
                        }
                    ],
                    "requestBody": {
                        "required": True,
                        "content": {
                            "application/json": {
                                "schema": {
                                    "type": "object",
                                    "required": ["tool_name", "arguments"],
                                    "properties": {
                                        "tool_name": {
                                            "type": "string",
                                            "enum": [
                                                "kql_query",
                                                "list_incidents",
                                                "get_incident",
                                                "update_incident",
                                            ],
                                        },
                                        "arguments": {"type": "object"},
                                    },
                                }
                            }
                        },
                    },
                    "responses": {"200": {"description": "OK"}},
                }
            },
        },
    }
    return jsonref.loads(json.dumps(spec))


def main() -> int:
    endpoint = os.environ.get("AZURE_AI_FOUNDRY_PROJECT_ENDPOINT")
    model = os.environ.get("AZURE_AI_MODEL_DEPLOYMENT")
    runner_url = os.environ.get("AISOC_RUNNER_URL")
    runner_bearer = os.environ.get("AISOC_RUNNER_BEARER")

    # Deterministic identifiers (exported by deploy_prompt_agents_with_runner_tools.sh)
    sub_id = os.environ.get("AZURE_SUBSCRIPTION_ID")
    rg = os.environ.get("AZURE_RESOURCE_GROUP")
    hub = os.environ.get("AZURE_FOUNDRY_HUB_NAME")
    project = os.environ.get("AZURE_FOUNDRY_PROJECT_NAME")

    if (
        not endpoint
        or not model
        or not runner_url
        or not runner_bearer
        or not sub_id
        or not rg
        or not hub
        or not project
    ):
        print(
            "ERROR: missing env vars. Need AZURE_AI_FOUNDRY_PROJECT_ENDPOINT, AZURE_AI_MODEL_DEPLOYMENT, AISOC_RUNNER_URL, AISOC_RUNNER_BEARER, "
            "AZURE_SUBSCRIPTION_ID, AZURE_RESOURCE_GROUP, AZURE_FOUNDRY_HUB_NAME, AZURE_FOUNDRY_PROJECT_NAME",
            file=sys.stderr,
        )
        return 2

    try:
        from azure.identity import DefaultAzureCredential
        from azure.ai.projects import AIProjectClient
        from azure.ai.projects.models import (
            PromptAgentDefinition,
        )
    except Exception as e:
        print("ERROR: missing/old azure-ai-projects SDK for OpenAPI tools. Upgrade needed.")
        print(str(e), file=sys.stderr)
        return 3

    client = AIProjectClient(endpoint=endpoint, credential=DefaultAzureCredential())

    for name in AGENTS:
        spec = render_openapi(runner_url, name)

        # Create a project connection for the runner key and reference it.
        # Connection name is stable; shared across agents.
        conn_name = "aisoc-runner-key"
        try:
            conn = client.connections.get(conn_name)  # type: ignore[attr-defined]
        except Exception:
            # Some SDK versions do not support creating connections programmatically.
            # In that case, instruct the user to create it once in the Foundry UI.
            if not hasattr(client.connections, "create"):
                print(
                    "ERROR: Project connection 'aisoc-runner-key' not found and SDK cannot create connections.\n"
                    "Create it once in Foundry UI: Project -> Connections -> Add -> Custom keys\n"
                    "  Name: aisoc-runner-key\n"
                    "  Key:  x-aisoc-runner-key\n"
                    "  Value: <runner bearer token>\n",
                    file=sys.stderr,
                )
                return 4

            conn = client.connections.create(  # type: ignore[attr-defined]
                name=conn_name,
                connection_type="custom_keys",
                keys={"x-aisoc-runner-key": runner_bearer},
            )

        # IMPORTANT: Foundry's OpenAPI tool expects a *project connection ARM id* (portal-compatible),
        # not whatever shape the SDK returns for `conn.id`. Build it deterministically:
        # /subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.CognitiveServices/accounts/<hub>/projects/<proj>/connections/<name>
        conn_arm_id = (
            f"/subscriptions/{sub_id}"
            f"/resourceGroups/{rg}"
            f"/providers/Microsoft.CognitiveServices/accounts/{hub}"
            f"/projects/{project}"
            f"/connections/{conn_name}"
        )

        # Unfortunately, different Foundry/SDK versions disagree on the casing of the auth block.
        # The service validator can require `security_scheme`, while some portal surfaces look for
        # `securityScheme`. We send BOTH.
        auth_security = {"project_connection_id": conn_arm_id, "security_scheme_name": "runnerKey"}
        tool = {
            "type": "openapi",
            "openapi": {
                "name": "aisoc_runner",
                "description": "AISOC Runner gateway",
                "spec": spec,
                "auth": {
                    "type": "project_connection",
                    # snake_case (required by some validators)
                    "security_scheme": auth_security,
                    # camelCase (expected by some portal surfaces)
                    "securityScheme": auth_security,
                },
            },
        }

        agent_name = slug(name)

        agent = client.agents.create_version(
            agent_name=agent_name,
            definition=PromptAgentDefinition(
                model=model,
                instructions=ROLE_INSTRUCTIONS.get(name, "You are a SOC analyst."),
                tools=[tool],
            ),
            description=f"AISOC demo agent: {name}",
        )

        print(f"OK: {name} (agent_name={agent_name}) published version={getattr(agent, 'version', None)}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
