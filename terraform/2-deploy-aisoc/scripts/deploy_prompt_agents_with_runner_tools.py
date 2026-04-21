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

    if not endpoint or not model or not runner_url or not runner_bearer:
        print(
            "ERROR: missing env vars. Need AZURE_AI_FOUNDRY_PROJECT_ENDPOINT, AZURE_AI_MODEL_DEPLOYMENT, AISOC_RUNNER_URL, AISOC_RUNNER_BEARER",
            file=sys.stderr,
        )
        return 2

    try:
        from azure.identity import DefaultAzureCredential
        from azure.ai.projects import AIProjectClient
        from azure.ai.projects.models import (
            PromptAgentDefinition,
            OpenApiTool,
            OpenApiFunctionDefinition,
            OpenApiProjectConnectionAuthDetails,
            OpenApiProjectConnectionSecurityScheme,
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
            # Best-effort create "Custom keys" connection.
            # SDK surface differs; if this fails, we'll ask you to create it once in UI.
            conn = client.connections.create(  # type: ignore[attr-defined]
                name=conn_name,
                connection_type="custom_keys",
                keys={"x-aisoc-runner-key": runner_bearer},
            )

        tool = OpenApiTool(
            openapi=OpenApiFunctionDefinition(
                name="aisoc_runner",
                spec=spec,
                description="AISOC Runner gateway",
                auth=OpenApiProjectConnectionAuthDetails(
                    security_scheme=OpenApiProjectConnectionSecurityScheme(
                        project_connection_id=getattr(conn, "id", conn.get("id", None)),
                    )
                ),
            )
        )

        agent = client.agents.create_version(
            agent_name=name,
            definition=PromptAgentDefinition(
                model=model,
                instructions=ROLE_INSTRUCTIONS.get(name, "You are a SOC analyst."),
                tools=[tool],
            ),
            description=f"AISOC demo agent: {name}",
        )

        print(f"OK: {name} published version={getattr(agent, 'version', None)}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
