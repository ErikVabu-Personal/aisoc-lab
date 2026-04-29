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


def _ensure_project_connection_remote_tool(
    *,
    sub_id: str,
    rg: str,
    hub: str,
    project: str,
    connection_name: str,
    target_url: str,
    audience: str,
) -> None:
    """Idempotently create or update a Foundry project connection of
    category=RemoteTool with ProjectManagedIdentity auth, pointing at
    `target_url`. Used to expose the detection-rules KB's MCP endpoint
    to the Detection Engineer agent.

    The Azure AI Projects SDK doesn't have a first-class API for
    RemoteTool connections yet, so we hit ARM directly with the
    project's MI as the authenticated identity.
    """

    try:
        from azure.identity import DefaultAzureCredential
        import requests as _requests
    except Exception as e:
        raise RuntimeError(
            f"missing azure-identity / requests for project connection: {e!r}"
        ) from e

    cred = DefaultAzureCredential()
    token = cred.get_token("https://management.azure.com/.default").token

    api_version = "2025-10-01-preview"
    url = (
        f"https://management.azure.com/subscriptions/{sub_id}"
        f"/resourceGroups/{rg}"
        f"/providers/Microsoft.CognitiveServices/accounts/{hub}"
        f"/projects/{project}"
        f"/connections/{connection_name}"
        f"?api-version={api_version}"
    )

    body = {
        "name": connection_name,
        "type": "Microsoft.MachineLearningServices/workspaces/connections",
        "properties": {
            "authType": "ProjectManagedIdentity",
            "category": "RemoteTool",
            "target": target_url,
            "isSharedToAll": True,
            "audience": audience,
            "metadata": {"ApiType": "Azure"},
        },
    }

    r = _requests.put(
        url,
        headers={
            "Authorization": f"Bearer {token}",
            "Content-Type": "application/json",
        },
        json=body,
        timeout=30,
    )
    if r.status_code >= 400:
        raise RuntimeError(
            f"project connection PUT returned {r.status_code}: {r.text[:1000]}"
        )

import jsonref

AGENTS = [
    "Triage",
    "Investigator",
    "Reporter",
    "Detection Engineer",
    "SOC Manager",
]


def write_slug_roster(out_path: str) -> None:
    """Write a stable, slug-form roster for downstream components (e.g. PixelAgents Web)."""
    roster = [slug(a) for a in AGENTS]
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        f.write(",".join(roster) + "\n")


def slug(s: str) -> str:
    import re

    s = s.strip().lower()
    s = re.sub(r"[^a-z0-9]+", "-", s)
    s = re.sub(r"^-+", "", s)
    s = re.sub(r"-+$", "", s)
    return s[:63]

ROLE_INSTRUCTIONS: Dict[str, str] = {
    "Triage": "Triage analyst.",
    "Investigator": "Incident investigator.",
    "Reporter": "Incident reporter.",
    "Detection Engineer": "Detection engineer.",
    "SOC Manager": "SOC Manager.",
}


def _read_text(path: str) -> str:
    try:
        with open(path, "r", encoding="utf-8") as f:
            return f.read().strip()
    except FileNotFoundError:
        return ""


def load_instructions(agent_display_name: str) -> str:
    """Load common + role instructions from agents/instructions/*.md.

    This makes agent behavior versioned in-repo and reproducible: edit markdown,
    re-run the deploy script, and agents update.
    """

    base_dir = os.path.join(os.path.dirname(__file__), "..", "agents", "instructions")
    common = _read_text(os.path.join(base_dir, "common.md"))

    role_map = {
        "Triage": "triage.md",
        "Investigator": "investigator.md",
        "Reporter": "reporter.md",
        "Detection Engineer": "detection-engineer.md",
        "SOC Manager": "soc-manager.md",
    }
    role_file = role_map.get(agent_display_name)
    role = _read_text(os.path.join(base_dir, role_file)) if role_file else ""

    stitched = "\n\n".join([x for x in [common, role] if x])
    if stitched:
        return stitched

    # Fallback: keep prior minimal instructions if files are missing.
    return ROLE_INSTRUCTIONS.get(agent_display_name, "You are a SOC analyst.")


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
                                                "ask_human",
                                                "get_agent_role_instructions",
                                                "propose_change_to_preamble",
                                                "propose_change_to_agent_instructions",
                                                "propose_change_to_detection_rule",
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

    # Detection Rules KB wiring — optional. When all four are present
    # AND the kb is enabled, the Detection Engineer agent gets an
    # extra MCP tool exposing the knowledge base for retrieval.
    drk_enabled    = (os.environ.get("AISOC_DETECTION_RULES_KB_ENABLED", "false") or "").strip().lower() == "true"
    drk_search_ep  = (os.environ.get("AISOC_DETECTION_RULES_KB_SEARCH_ENDPOINT", "") or "").strip().rstrip("/")
    drk_kb_name    = (os.environ.get("AISOC_DETECTION_RULES_KB_NAME", "") or "").strip()
    drk_conn_name  = (os.environ.get("AISOC_DETECTION_RULES_KB_PROJECT_CONNECTION", "") or "").strip()
    drk_attach     = bool(drk_enabled and drk_search_ep and drk_kb_name and drk_conn_name)

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

        # Tool list always starts with the runner OpenAPI tool. The
        # Detection Engineer also gets an MCP tool wired to the
        # detection-rules Foundry IQ knowledge base, when the kb has
        # been provisioned by Phase 2 Terraform.
        tools_for_agent = [tool]
        if drk_attach and agent_name == "detection-engineer":
            # Ensure the project connection exists (idempotent). This
            # can't be done in Terraform because the Foundry project
            # itself is created post-apply, so we lazily make the
            # connection right before we need it for the tool wiring.
            drk_mcp_endpoint = (
                f"{drk_search_ep}/knowledgebases/{drk_kb_name}"
                f"/mcp?api-version=2025-11-01-preview"
            )
            try:
                _ensure_project_connection_remote_tool(
                    sub_id=sub_id,
                    rg=rg,
                    hub=hub,
                    project=project,
                    connection_name=drk_conn_name,
                    target_url=drk_mcp_endpoint,
                    audience="https://search.azure.com/",
                )
                print(
                    f"INFO: project connection {drk_conn_name!r} ready "
                    f"(RemoteTool / ProjectManagedIdentity)"
                )
            except Exception as e:
                print(
                    f"WARN: could not create / verify project connection "
                    f"{drk_conn_name!r}: {e!r}. Skipping MCP-tool attach for "
                    f"{name}.",
                    file=sys.stderr,
                )
                drk_attach = False  # don't try again on this run

        if drk_attach and agent_name == "detection-engineer":
            mcp_tool = {
                "type": "mcp",
                "server_label": "detection-rules",
                "server_url": (
                    f"{drk_search_ep}/knowledgebases/{drk_kb_name}"
                    f"/mcp?api-version=2025-11-01-preview"
                ),
                "require_approval": "never",
                "allowed_tools": ["knowledge_base_retrieve"],
                "project_connection_id": drk_conn_name,
            }
            tools_for_agent.append(mcp_tool)
            print(
                f"INFO: attaching detection-rules MCP tool to {name} "
                f"(kb={drk_kb_name}, conn={drk_conn_name})"
            )

        agent = client.agents.create_version(
            agent_name=agent_name,
            definition=PromptAgentDefinition(
                model=model,
                instructions=load_instructions(name),
                tools=tools_for_agent,
            ),
            description=f"AISOC demo agent: {name}",
        )

        print(f"OK: {name} (agent_name={agent_name}) published version={getattr(agent, 'version', None)}")

    # Write a slug roster that other phases/scripts can consume.
    roster_path = os.path.join(os.path.dirname(__file__), "..", "agents", "roster.slugs.txt")
    write_slug_roster(roster_path)
    print(f"Wrote agent roster: {roster_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
