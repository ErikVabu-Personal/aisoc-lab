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
        prompt_plan = """
You are a SOC triage agent.

POLICY (always follow):
{policy}

SOP REFERENCE:
{sop}

INCIDENT JSON:
{incident}

Task:
Propose up to 3 KQL queries (Log Analytics / Sentinel workspace) that reduce uncertainty.

Guidance:
- Anchor around the incident time. If the incident JSON includes timestamps, pick a slightly wider `timespan` (e.g. PT3H) to cover it.
- First query should sanity-check that relevant telemetry exists around the time window (avoid overfitting).

Return ONLY JSON with the shape:
{{
  "queries": [{{"name":"example", "query":"Heartbeat | take 5", "timespan":"PT3H"}}]
}}
""".strip().format(
            policy=self.policy,
            sop=self.sop,
            incident=incident,
        )

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
        prompt_yaml = """
You are a SOC triage agent.

POLICY (always follow):
{policy}

INCIDENT JSON:
{incident}

KQL RESULTS (max 3):
{results}

Task:
Return VALID YAML ONLY matching the Output Format in the SOP.

Hard requirements:
- Top-level key MUST be `triage_summary`.
- Include all required fields from the SOP schema (even if empty lists).
- If telemetry is limited or queries returned empty, do NOT label as "False Positive" unless you have explicit evidence the alert is broken/noisy.
  Prefer "Suspicious" and list gaps.
""".strip().format(
            policy=self.policy,
            incident=incident,
            results=results,
        )

        final = self.llm.chat(prompt_yaml)
        yaml_text = (
            final.get("choices", [{}])[0]
            .get("message", {})
            .get("content", "")
        )

        return TriageResult(incident_id=incident_id, yaml=yaml_text)
