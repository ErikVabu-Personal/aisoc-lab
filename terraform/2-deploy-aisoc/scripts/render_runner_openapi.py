#!/usr/bin/env python3

"""Render agent-specific OpenAPI specs for AISOC Runner.

Generates one OpenAPI JSON per agent, setting:
- servers[0].url to runner URL
- x-aisoc-agent header default to the agent name (PixelAgents attribution)

Input:
- --runner-url
- --agents (comma-separated)
- --out-dir

No secrets are embedded.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runner-url", required=True)
    ap.add_argument("--agents", required=True, help="Comma-separated agent names")
    ap.add_argument("--out-dir", required=True)
    args = ap.parse_args()

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    base = {
        "openapi": "3.0.3",
        "info": {
            "title": "AISOC Runner",
            "version": "0.1.0",
            "description": "AISOC Runner executes tool calls against SOCGateway.",
        },
        "servers": [{"url": args.runner_url}],
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
                    "responses": {
                        "200": {
                            "description": "OK",
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "type": "object",
                                        "properties": {"ok": {"type": "string"}},
                                    }
                                }
                            },
                        }
                    },
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
                            "schema": {"type": "string"},
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
                                        "arguments": {
                                            "type": "object",
                                            "description": "Tool arguments.",
                                        },
                                    },
                                }
                            }
                        },
                    },
                    "responses": {
                        "200": {
                            "description": "Tool result",
                            "content": {
                                "application/json": {
                                    "schema": {
                                        "type": "object",
                                        "properties": {"result": {"type": "object"}},
                                    }
                                }
                            },
                        },
                        "400": {"description": "Bad request"},
                        "401": {"description": "Missing token"},
                        "403": {"description": "Forbidden"},
                    },
                }
            },
        },
    }

    agents = [a.strip() for a in args.agents.split(",") if a.strip()]
    for a in agents:
        spec = json.loads(json.dumps(base))
        spec["paths"]["/tools/execute"]["post"]["parameters"][0]["schema"]["default"] = a
        fn = out_dir / f"aisoc-runner.{a.lower().replace(' ', '-')}.openapi.json"
        fn.write_text(json.dumps(spec, indent=2), encoding="utf-8")
        print(f"Wrote {fn}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
