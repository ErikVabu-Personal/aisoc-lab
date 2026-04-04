#!/usr/bin/env python3
import json
import os
import subprocess
import sys


def run(cmd):
    p = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if p.returncode != 0:
        raise RuntimeError(f"Command failed: {' '.join(cmd)}\n{p.stderr}")
    return p.stdout


def main():
    # Terraform external data source passes a JSON object on stdin
    query = json.load(sys.stdin)
    # Terraform external data source provides only strings; lists come as JSON strings
    locations_raw = query.get("location_candidates") or "[]"
    sizes_raw = query.get("vm_size_candidates") or "[]"

    try:
        locations = json.loads(locations_raw) if isinstance(locations_raw, str) else locations_raw
        sizes = json.loads(sizes_raw) if isinstance(sizes_raw, str) else sizes_raw
    except Exception:
        locations = []
        sizes = []

    # Basic sanity
    if not locations or not sizes:
        print(json.dumps({"location": query.get("location"), "vm_size": query.get("vm_size"), "note": "no candidates"}))
        return

    # Prefer user-selected subscription if present
    # Caller should have done: az login && az account set -s <sub>

    for loc in locations:
        try:
            raw = run(["az", "vm", "list-skus", "-l", loc, "--output", "json"])
            skus = json.loads(raw)
        except Exception as e:
            continue

        # Build map by name
        by_name = {}
        for s in skus:
            name = s.get("name")
            if not name:
                continue
            # We only care about VM sizes
            if "virtualMachines" not in (s.get("resourceType") or ""):
                continue
            by_name[name] = s

        for size in sizes:
            s = by_name.get(size)
            if not s:
                continue

            # If Azure reports restrictions, skip
            restrictions = s.get("restrictions") or []
            if restrictions:
                continue

            # Best-effort: pick it
            print(json.dumps({
                "location": loc,
                "vm_size": size,
                "note": "selected from candidates via az vm list-skus (no restrictions reported)"
            }))
            return

    # Fallback
    print(json.dumps({
        "location": query.get("location"),
        "vm_size": query.get("vm_size"),
        "note": "no candidate matched; using defaults"
    }))


if __name__ == "__main__":
    main()
