"""Shared Azure capacity + quota helpers for the aisoc-lab preflights.

Two problems bite a fresh subscription when it deploys VMs to a region:

  1. Quota LIMITS are too low (a new sub often has "Total Regional vCPUs" = 10).
     These are usually AUTO-GRANTABLE — the Microsoft.Quota API can request the
     increase and standard bumps clear in seconds.
  2. A whole VM FAMILY has no CAPACITY in the region (e.g. West US refuses any
     more DSv3). Azure will NOT raise that — no script can conjure capacity, so
     the only fix is to pick a family that HAS capacity.

This module reads capacity (`az vm list-skus`) + quota (`az vm list-usage`), picks
an available size from a candidate list, and best-effort-requests quota bumps
(`az rest` → Microsoft.Quota). Everything degrades to a warning: a failure here
never makes the deploy worse than hardcoding the size did — it just informs.

`az` must be logged in on the target subscription. No third-party deps.
"""
from __future__ import annotations

import json
import subprocess
import sys
from typing import Optional

QUOTA_API_VERSION = "2023-02-01"
_AZ_TIMEOUT = 120


def log(msg: str) -> None:
    print(f"[azure-preflight] {msg}", file=sys.stderr, flush=True)


def _az(args: list[str]) -> Optional[object]:
    """Run `az <args> -o json`; return parsed JSON, or None on any failure."""
    try:
        r = subprocess.run(
            ["az", *args, "-o", "json"],
            capture_output=True, text=True, timeout=_AZ_TIMEOUT,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        log(f"az call failed ({' '.join(args[:3])}…): {e!r}")
        return None
    if r.returncode != 0:
        log(f"az {' '.join(args[:3])}… returned {r.returncode}: {r.stderr.strip()[:200]}")
        return None
    try:
        return json.loads(r.stdout or "null")
    except json.JSONDecodeError:
        return None


def current_subscription() -> Optional[str]:
    acct = _az(["account", "show"])
    return acct.get("id") if isinstance(acct, dict) else None


# --- Capacity (list-skus) ---------------------------------------------------

def region_vm_skus(region: str) -> dict:
    """All VM SKUs in a region in ONE az call: {size: {available, vcpus, family, reason}}.

    Much cheaper than size_info() per size when surveying many sizes across many
    regions (1 call/region instead of 1 call/size/region). `available` is True when
    the SKU has NO restriction; `reason` carries the restriction reasonCode(s)
    (e.g. NotAvailableForSubscription) for the unavailable ones.
    """
    skus = _az(["vm", "list-skus", "-l", region, "--resource-type", "virtualMachines"])
    out: dict[str, dict] = {}
    if not isinstance(skus, list):
        return out
    for s in skus:
        name = s.get("name")
        if not name:
            continue
        restrictions = s.get("restrictions") or []
        caps = {c["name"]: c["value"] for c in (s.get("capabilities") or [])}
        out[name] = {
            "available": len(restrictions) == 0,
            "vcpus": int(caps.get("vCPUs", caps.get("vCPUsAvailable", 0)) or 0),
            "family": s.get("family"),
            "reason": ",".join(r.get("reasonCode", "?") for r in restrictions) or None,
        }
    return out


def size_info(region: str, size: str) -> dict:
    """Return {available, vcpus, family} for a VM size in a region.

    `available` is True when the SKU exists in the region with NO restriction
    (a Location/Zone restriction ⇒ no capacity for this sub in this region).
    `family` is the quota-family token used by list-usage / the Quota API
    (e.g. "standardDASv4Family").
    """
    skus = _az(["vm", "list-skus", "-l", region, "--size", size])
    if not isinstance(skus, list) or not skus:
        return {"available": False, "vcpus": 0, "family": None, "reason": "not-found"}
    s = skus[0]
    restrictions = s.get("restrictions") or []
    caps = {c["name"]: c["value"] for c in (s.get("capabilities") or [])}
    return {
        "available": len(restrictions) == 0,
        "vcpus": int(caps.get("vCPUs", caps.get("vCPUsAvailable", 0)) or 0),
        "family": s.get("family"),  # e.g. standardDASv4Family
        "reason": ",".join(r.get("reasonCode", "?") for r in restrictions) or None,
    }


# --- Quota (list-usage) -----------------------------------------------------

def region_usage(region: str) -> dict:
    """Map quota resourceName -> {current, limit, label} for a region's vCPU quotas."""
    usage = _az(["vm", "list-usage", "-l", region])
    out: dict[str, dict] = {}
    if isinstance(usage, list):
        for u in usage:
            name = (u.get("name") or {})
            key = name.get("value")  # e.g. "cores", "standardDASv4Family"
            if not key:
                continue
            out[key] = {
                "current": int(u.get("currentValue", 0)),
                "limit": int(u.get("limit", 0)),
                "label": name.get("localizedValue", key),
            }
    return out


def family_headroom(usage: dict, family_token: Optional[str]) -> Optional[int]:
    """Free vCPUs in a family (limit-current). family_token is the list-skus
    `family` (standardDASv4Family); list-usage keys match it case-insensitively."""
    if not family_token:
        return None
    for key, v in usage.items():
        if key.lower() == family_token.lower():
            return v["limit"] - v["current"]
    return None


# --- Size selection ---------------------------------------------------------

def pick_size(region: str, candidates: list[str], vcpus_needed: int,
              usage: Optional[dict] = None) -> Optional[dict]:
    """First candidate that has CAPACITY and enough FAMILY quota headroom.

    Falls back to the first capacity-available candidate (regardless of quota)
    with a flag, so the caller can request a quota bump for it. Returns
    {size, family, vcpus, headroom, quota_ok} or None if nothing has capacity.
    """
    if usage is None:
        usage = region_usage(region)
    first_available: Optional[dict] = None
    for size in candidates:
        info = size_info(region, size)
        if not info["available"]:
            log(f"  {size}: no capacity ({info.get('reason') or 'restricted'})")
            continue
        head = family_headroom(usage, info["family"])
        rec = {
            "size": size, "family": info["family"], "vcpus": info["vcpus"] or vcpus_needed,
            "headroom": head, "quota_ok": (head is not None and head >= vcpus_needed),
        }
        if first_available is None:
            first_available = rec
        if rec["quota_ok"]:
            log(f"  {size}: capacity OK, family headroom {head} ≥ {vcpus_needed} — chosen")
            return rec
        log(f"  {size}: capacity OK but family headroom {head} < {vcpus_needed} (needs quota)")
    if first_available:
        log(f"  → no candidate has both capacity AND quota; picking {first_available['size']} "
            f"(capacity OK) and will try a quota bump for family {first_available['family']}")
    return first_available


# --- Quota requests (best-effort) -------------------------------------------

def request_quota(subscription: str, region: str, resource_name: str,
                  new_limit: int) -> str:
    """Best-effort request to raise a Compute quota via Microsoft.Quota.

    resource_name is the list-usage `name.value` ("cores" for Total Regional,
    "standardDASv4Family" for a family). Returns "fulfilled" | "pending" |
    "failed". Standard bumps auto-approve immediately; capacity-constrained
    families come back failed/denied — which is fine, the caller then relies on
    capacity-aware selection instead.
    """
    scope = f"/subscriptions/{subscription}/providers/Microsoft.Compute/locations/{region}"
    url = (f"https://management.azure.com{scope}"
           f"/providers/Microsoft.Quota/quotas/{resource_name}"
           f"?api-version={QUOTA_API_VERSION}")
    body = json.dumps({
        "properties": {
            "limit": {"limitObjectType": "LimitValue", "value": new_limit},
            "name": {"value": resource_name},
        }
    })
    try:
        r = subprocess.run(
            ["az", "rest", "--method", "put", "--url", url, "--body", body,
             "--headers", "Content-Type=application/json"],
            capture_output=True, text=True, timeout=_AZ_TIMEOUT,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired) as e:
        log(f"quota PUT for {resource_name}->{new_limit} errored: {e!r}")
        return "failed"
    if r.returncode != 0:
        log(f"quota request {resource_name}->{new_limit} rejected: {r.stderr.strip()[:200]}")
        return "failed"
    try:
        state = ((json.loads(r.stdout or "{}").get("properties") or {})
                 .get("provisioningState", "")).lower()
    except json.JSONDecodeError:
        state = ""
    if state in ("succeeded", "accepted"):
        log(f"quota {resource_name} -> {new_limit}: {state}")
        return "fulfilled"
    log(f"quota {resource_name} -> {new_limit}: submitted (state={state or 'unknown'}); "
        f"may need manual approval — check the portal")
    return "pending"


def ensure_quota(subscription: str, region: str, resource_name: str,
                 needed: int, usage: Optional[dict] = None,
                 do_request: bool = False) -> dict:
    """Report (and, if do_request, best-effort raise) a single quota to >= needed."""
    if usage is None:
        usage = region_usage(region)
    cur = usage.get(resource_name)
    if cur is None:
        # Try a case-insensitive match (family tokens vary in case).
        cur = next((v for k, v in usage.items() if k.lower() == resource_name.lower()), None)
    if cur is None:
        log(f"quota {resource_name}: not found in region usage")
        return {"resource": resource_name, "limit": None, "ok": False, "action": "unknown"}
    if cur["limit"] >= needed:
        return {"resource": resource_name, "limit": cur["limit"], "ok": True, "action": "already-ok"}
    log(f"quota {resource_name}: limit {cur['limit']} < needed {needed}")
    if do_request:
        res = request_quota(subscription, region, resource_name, needed)
        return {"resource": resource_name, "limit": cur["limit"], "ok": res == "fulfilled",
                "action": res, "requested": needed}
    return {"resource": resource_name, "limit": cur["limit"], "ok": False,
            "action": "needs-raise", "requested": needed}
