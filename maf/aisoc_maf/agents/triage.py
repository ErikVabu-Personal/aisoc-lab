from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from aisoc_maf.tools.soc_gateway import SOCGateway
from aisoc_maf.tools.openrouter_via_gateway import OpenRouterViaGateway


@dataclass
class TriageResult:
    incident_id: str
    yaml: str


class TriageAgent:
    """LLM-backed triage agent.

    - Loads policy + SOP from maf/playbooks
    - Uses the LLM to propose up to 3 KQL queries
    - Executes KQL via SOC gateway
    - Asks LLM to produce YAML triage output
    """

    def __init__(self, tools: SOCGateway, llm: OpenRouterViaGateway):
        self.tools = tools
        self.llm = llm

        base = Path(__file__).resolve().parents[2]
        self.policy = (base / "playbooks" / "triage_policy.md").read_text(encoding="utf-8")
        self.sop = (base / "playbooks" / "triage_sop.md").read_text(encoding="utf-8")

    def triage_incident(self, incident_id: str) -> TriageResult:
        incident = self.tools.get_incident(incident_id)

        # 1) Ask LLM for up to 3 KQL queries
        prompt_plan = f"""
You are a SOC triage agent.

POLICY (always follow):
{self.policy}

SOP REFERENCE:
{self.sop}

INCIDENT JSON:
{incident}

Task:
Propose up to 3 KQL queries (Log Analytics / Sentinel workspace) that reduce uncertainty.
Return ONLY JSON with the shape:
{{
  \"queries\": [{{\"name\":\"...\", \"query\":\"...\", \"timespan\":\"PT1H\"}}]
}}
""".strip()

        plan = self.llm.chat(prompt_plan)
        # openrouter returns OpenAI-style object; extract assistant content
        content = (
            plan.get("choices", [{}])[0]
            .get("message", {})
            .get("content", "")
        )

        import json as _json

        try:
            plan_obj = _json.loads(content)
            queries = plan_obj.get("queries", [])
        except Exception:
            queries = []

        queries = queries[:3]

        # 2) Execute queries
        results = []
        for q in queries:
            kql = q.get("query")
            ts = q.get("timespan", "PT1H")
            if not kql:
                continue
            out = self.tools.kql_query(kql, ts)
            results.append({"name": q.get("name"), "timespan": ts, "query": kql, "result": out})

        # 3) Ask LLM to produce YAML triage
        prompt_yaml = f"""
You are a SOC triage agent.

POLICY (always follow):
{self.policy}

INCIDENT JSON:
{incident}

KQL RESULTS (max 3):
{results}

Task:
Return VALID YAML ONLY matching the Output Format in the SOP.
""".strip()

        final = self.llm.chat(prompt_yaml)
        yaml_text = (
            final.get("choices", [{}])[0]
            .get("message", {})
            .get("content", "")
        )

        return TriageResult(incident_id=incident_id, yaml=yaml_text)
