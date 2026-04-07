from __future__ import annotations

import argparse
import json

from aisoc_maf.config import load_config
from aisoc_maf.tools.soc_gateway import SOCGateway
from aisoc_maf.agents.triage import TriageAgent


def main() -> int:
    ap = argparse.ArgumentParser(prog="aisoc")
    sub = ap.add_subparsers(dest="cmd", required=True)

    p_triage = sub.add_parser("triage", help="Run deterministic triage flow for an incident")
    p_triage.add_argument("incident_id")

    args = ap.parse_args()

    cfg = load_config()
    tools = SOCGateway(cfg)

    if args.cmd == "triage":
        agent = TriageAgent(tools)
        res = agent.triage_incident(args.incident_id)
        print(json.dumps({"incident_id": res.incident_id, "summary": res.summary, "next": res.recommended_next_steps}, indent=2))
        return 0

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
