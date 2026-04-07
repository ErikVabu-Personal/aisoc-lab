from __future__ import annotations

from dataclasses import dataclass

from aisoc_maf.tools.soc_gateway import SOCGateway


@dataclass
class TriageResult:
    incident_id: str
    summary: str
    recommended_next_steps: list[str]


class TriageAgent:
    """Placeholder triage agent.

    Next iteration: implement with Microsoft Agent Framework + OpenRouter LLM via gateway.
    For now, we show the tool flow shape and return a deterministic summary.
    """

    def __init__(self, tools: SOCGateway):
        self.tools = tools

    def triage_incident(self, incident_id: str) -> TriageResult:
        inc = self.tools.get_incident(incident_id)
        title = inc.get("title") or inc.get("properties", {}).get("title") or "(no title)"

        # Minimal deterministic output so the plumbing can be tested before LLM wiring.
        summary = f"Incident {incident_id}: {title}"
        steps = [
            "Run quick KQL to identify affected hosts/users",
            "Check recent sign-in anomalies and process executions",
            "Decide if containment is needed",
        ]
        return TriageResult(incident_id=incident_id, summary=summary, recommended_next_steps=steps)
