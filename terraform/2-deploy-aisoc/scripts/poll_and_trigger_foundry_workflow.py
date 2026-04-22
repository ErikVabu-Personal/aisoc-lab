#!/usr/bin/env python3
"""Poll Sentinel incidents via AISOC Runner and trigger a Foundry Workflow for new incidents.

This is a demo-friendly trigger mechanism.

Inputs (env vars):
- AISOC_RUNNER_URL           (e.g. https://<runner>)
- AISOC_RUNNER_BEARER        (runner token; header x-aisoc-runner-key)
- AISOC_WORKFLOW_NAME        (default: aisoc-incident-pipeline)
- AISOC_POLL_INTERVAL_SEC    (default: 60)
- AISOC_STATE_FILE           (default: .aisoc_poll_state.json)

Notes:
- The actual Foundry workflow trigger API call is tenant/preview dependent.
  This script currently stubs the trigger call and prints what it *would* do.
  Once you paste the workflow run endpoint payload from the portal/network tab,
  we can implement the real POST.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path
from typing import Any, Dict, List

import requests


def runner_post(url: str, bearer: str, payload: dict[str, Any]) -> requests.Response:
    return requests.post(
        url,
        headers={"x-aisoc-runner-key": bearer, "Content-Type": "application/json"},
        json=payload,
        timeout=60,
    )


def load_state(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {"processed_incident_numbers": []}
    return json.loads(path.read_text(encoding="utf-8"))


def save_state(path: Path, state: dict[str, Any]) -> None:
    path.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")


def list_incidents(runner_url: str, bearer: str) -> List[dict[str, Any]]:
    r = runner_post(f"{runner_url.rstrip('/')}/tools/execute", bearer, {"tool_name": "list_incidents", "arguments": {}})
    r.raise_for_status()
    data = r.json().get("result")
    if not isinstance(data, dict):
        return []
    items = data.get("value")
    if not isinstance(items, list):
        return []
    return [x for x in items if isinstance(x, dict)]


def extract_incident_numbers(items: List[dict[str, Any]]) -> List[int]:
    out: List[int] = []
    for it in items:
        props = it.get("properties") if isinstance(it, dict) else None
        if not isinstance(props, dict):
            continue
        n = props.get("incidentNumber")
        try:
            out.append(int(n))
        except Exception:
            continue
    return sorted(set(out), reverse=True)


def trigger_workflow(workflow_name: str, incident_number: int) -> None:
    # TODO: Implement Foundry workflow run API call.
    # For now, log deterministically what we would trigger.
    print(f"[AISOC] Would trigger workflow '{workflow_name}' for incidentNumber={incident_number}")


def main() -> int:
    runner_url = os.environ.get("AISOC_RUNNER_URL", "").strip()
    bearer = os.environ.get("AISOC_RUNNER_BEARER", "").strip()
    workflow = os.environ.get("AISOC_WORKFLOW_NAME", "aisoc-incident-pipeline").strip()
    interval = int(os.environ.get("AISOC_POLL_INTERVAL_SEC", "60"))
    state_path = Path(os.environ.get("AISOC_STATE_FILE", ".aisoc_poll_state.json"))

    if not runner_url or not bearer:
        raise SystemExit("Missing AISOC_RUNNER_URL or AISOC_RUNNER_BEARER")

    while True:
        state = load_state(state_path)
        processed = set(int(x) for x in state.get("processed_incident_numbers", []) if str(x).isdigit())

        items = list_incidents(runner_url, bearer)
        nums = extract_incident_numbers(items)

        # Process newest first; only trigger for new incident numbers.
        new_nums = [n for n in nums if n not in processed]
        for n in new_nums:
            trigger_workflow(workflow, n)
            processed.add(n)

        state["processed_incident_numbers"] = sorted(processed)
        save_state(state_path, state)

        time.sleep(interval)


if __name__ == "__main__":
    raise SystemExit(main())
