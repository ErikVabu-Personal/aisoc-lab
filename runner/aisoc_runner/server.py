from __future__ import annotations

import json
import os
import time
from typing import Any, Literal

import requests
from fastapi import FastAPI, Header, HTTPException


def _emit_pixelagents_event(event: dict[str, Any]) -> None:
    """Best-effort event emission to PixelAgents Web.

    Configure with:
      - PIXELAGENTS_URL (e.g. https://<pixelagents-web>/events)
      - PIXELAGENTS_TOKEN

    Failures are intentionally swallowed to avoid breaking tool execution.
    """

    url = os.getenv("PIXELAGENTS_URL", "").strip()
    token = os.getenv("PIXELAGENTS_TOKEN", "").strip()
    if not url or not token:
        return

    try:
        requests.post(
            url,
            headers={"x-pixelagents-token": token, "Content-Type": "application/json"},
            json=event,
            timeout=2,
        )
    except Exception:
        return


def _extract_incident_guid(value: Any) -> str | None:
    """Extract Sentinel incident GUID from either a GUID string or an ARM resource ID.

    Accepts workspace-scoped incident IDs too (case-insensitive '/incidents/').
    """

    if not isinstance(value, str):
        return None

    s = value.strip()
    if not s:
        return None

    lower = s.lower()
    needle = "/incidents/"
    if needle in lower:
        idx = lower.index(needle) + len(needle)
        remainder = s[idx:]
        guid = remainder.split("/", 1)[0].split("?", 1)[0].strip()
        return guid or None

    return s


app = FastAPI(title="aisoc-runner")


def _require_bearer(auth: str | None, api_key: str | None) -> None:
    expected = os.getenv("RUNNER_BEARER_TOKEN", "")
    if not expected:
        raise RuntimeError("Server misconfigured: RUNNER_BEARER_TOKEN missing")

    # Support either:
    # - Authorization: Bearer <token>
    # - x-aisoc-runner-key: <token>
    token: str | None = None

    if api_key:
        token = api_key
    elif auth and auth.lower().startswith("bearer "):
        token = auth.split(" ", 1)[1]

    if not token:
        raise HTTPException(status_code=401, detail="Missing token")

    if token != expected:
        raise HTTPException(status_code=403, detail="Forbidden")


def _gw_url(path: str) -> str:
    base = os.getenv("SOCGATEWAY_BASE_URL", "").rstrip("/")
    if not base:
        raise RuntimeError("SOCGATEWAY_BASE_URL missing")
    return f"{base}/{path.lstrip('/')}"


def _gw_params() -> dict[str, str]:
    code = os.getenv("SOCGATEWAY_FUNCTION_CODE", "")
    if not code:
        raise RuntimeError("SOCGATEWAY_FUNCTION_CODE missing")
    return {"code": code}


def _gw_headers(scope: Literal["read", "write"]) -> dict[str, str]:
    if scope == "read":
        key = os.getenv("SOCGATEWAY_READ_KEY", "")
    else:
        enabled = os.getenv("ENABLE_WRITES", "0") == "1"
        if not enabled:
            raise HTTPException(status_code=403, detail="Writes disabled")
        key = os.getenv("SOCGATEWAY_WRITE_KEY", "")

    if not key:
        raise RuntimeError(f"SOCGATEWAY_{scope.upper()}_KEY missing")

    return {"x-aisoc-key": key, "Content-Type": "application/json"}


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {
        "ok": "true",
        "git_sha": os.getenv("GIT_SHA", ""),
        "image": os.getenv("CONTAINER_IMAGE", ""),
    }


@app.get("/debug/config")
def debug_config(
    authorization: str | None = Header(default=None),
    x_aisoc_runner_key: str | None = Header(default=None, alias="x-aisoc-runner-key"),
) -> dict[str, Any]:
    _require_bearer(authorization, x_aisoc_runner_key)

    def redacted_len(name: str) -> int:
        return len(os.getenv(name, ""))

    return {
        "socgateway_base_url": os.getenv("SOCGATEWAY_BASE_URL", ""),
        "socgateway_function_code_set": bool(os.getenv("SOCGATEWAY_FUNCTION_CODE", "")),
        "socgateway_read_key_len": redacted_len("SOCGATEWAY_READ_KEY"),
        "socgateway_write_key_len": redacted_len("SOCGATEWAY_WRITE_KEY"),
        "enable_writes": os.getenv("ENABLE_WRITES", "0"),
        "pixelagents_url_set": bool(os.getenv("PIXELAGENTS_URL", "")),
        "pixelagents_token_set": bool(os.getenv("PIXELAGENTS_TOKEN", "")),
    }


@app.post("/tools/execute")
def tools_execute(
    payload: dict[str, Any],
    authorization: str | None = Header(default=None),
    x_aisoc_runner_key: str | None = Header(default=None, alias="x-aisoc-runner-key"),
    x_aisoc_agent: str | None = Header(default=None, alias="x-aisoc-agent"),
) -> dict[str, Any]:
    _require_bearer(authorization, x_aisoc_runner_key)

    # Foundry OpenAPI tools can wrap the call using the operationId as the outer tool_name.
    # Normalize to the inner payload shape.
    if payload.get("tool_name") == "toolsExecute" and isinstance(payload.get("arguments"), dict):
        inner = payload.get("arguments")
        if isinstance(inner, dict) and ("tool_name" in inner or "arguments" in inner):
            payload = inner

    tool_name: Any = payload.get("tool_name")
    if tool_name is not None and not isinstance(tool_name, str):
        tool_name = str(tool_name)
    tool_name = (tool_name or "").strip()

    args = payload.get("arguments") or {}

    try:
        print(
            f"[tools_execute] tool_name={tool_name!r} payload_keys={sorted(list(payload.keys()))} args_type={type(args).__name__}",
            flush=True,
        )
    except Exception:
        pass

    if not tool_name:
        raise HTTPException(status_code=400, detail=f"Missing tool_name. Payload keys={sorted(list(payload.keys()))}")

    agent = x_aisoc_agent or payload.get("agent") or os.getenv("DEFAULT_AGENT_NAME", "unknown")
    started = time.time()

    # Best-effort incident binding: when the tool's args carry an
    # incidentNumber / incident_number, attach it to the event so
    # PixelAgents Web can group this call under the right case in the
    # incident-details timeline. Tools that don't operate on a specific
    # incident (kql_query, list_incidents, ask_human without binding)
    # leave it unset.
    incident_number_for_event: int | None = None
    if isinstance(args, dict):
        raw_inc = args.get("incident_number") or args.get("incidentNumber")
        if raw_inc is not None:
            try:
                incident_number_for_event = int(raw_inc)
            except (TypeError, ValueError):
                incident_number_for_event = None

    _emit_pixelagents_event(
        {
            "type": "tool.call.start",
            "agent": agent,
            "state": "typing",
            "tool_name": tool_name,
            "args_keys": sorted(list(args.keys())) if isinstance(args, dict) else [],
            "incident_number": incident_number_for_event,
            "ts": started,
        }
    )

    try:
        if tool_name == "kql_query":
            query = args.get("query")
            # Some clients/LLMs include workspaceId/workspace_id; ignore it (Runner is already configured to a workspace via SOCGateway).
            _ = args.get("workspaceId") or args.get("workspace_id")
            timespan = args.get("timespan", "PT1H")
            if not query:
                raise HTTPException(status_code=400, detail="Missing arguments.query")

            r = requests.post(
                _gw_url("kql/query"),
                params=_gw_params(),
                headers=_gw_headers("read"),
                json={"query": query, "timespan": timespan},
                timeout=60,
            )
            if r.status_code >= 400:
                # Log upstream details to container logs for debugging.
                try:
                    print(f"[kql_query] upstream_error status={r.status_code} body={r.text[:2000]!r}", flush=True)
                except Exception:
                    pass
                raise HTTPException(status_code=r.status_code, detail=r.text)
            return {"result": r.json()}

        if tool_name == "list_incidents":
            r = requests.get(
                _gw_url("sentinel/incidents"),
                params=_gw_params(),
                headers=_gw_headers("read"),
                timeout=60,
            )
            if r.status_code >= 400:
                raise HTTPException(status_code=r.status_code, detail=r.text)
            return {"result": r.json()}

        if tool_name == "get_incident":
            # Accept a few common aliases produced by LLMs / different client conventions.
            raw_id = args.get("id") or args.get("incident_id") or args.get("incidentId")
            incident_number = args.get("incidentNumber") or args.get("incident_number")

            if incident_number is not None and raw_id is None:
                try:
                    n = int(incident_number)
                except Exception:
                    raise HTTPException(status_code=400, detail="arguments.incidentNumber must be an integer")

                lr = requests.get(
                    _gw_url("sentinel/incidents"),
                    params=_gw_params(),
                    headers=_gw_headers("read"),
                    timeout=60,
                )
                if lr.status_code >= 400:
                    raise HTTPException(status_code=lr.status_code, detail=lr.text)
                data = lr.json()
                candidates = data.get("value") if isinstance(data, dict) else None
                if not isinstance(candidates, list):
                    raise HTTPException(status_code=502, detail="Unexpected list_incidents response shape")

                match = None
                for item in candidates:
                    try:
                        props = item.get("properties", {}) if isinstance(item, dict) else {}
                        if int(props.get("incidentNumber")) == n:
                            match = item
                            break
                    except Exception:
                        continue

                if not match:
                    raise HTTPException(status_code=404, detail=f"No incident found with incidentNumber={n}")

                raw_id = match.get("name") or match.get("id")

            incident_id = _extract_incident_guid(raw_id)
            if not incident_id:
                raise HTTPException(
                    status_code=400,
                    detail="Missing arguments.id (or incident_id) or arguments.incidentNumber",
                )

            r = requests.get(
                _gw_url(f"sentinel/incidents/{incident_id}"),
                params=_gw_params(),
                headers=_gw_headers("read"),
                timeout=60,
            )
            if r.status_code >= 400:
                raise HTTPException(status_code=r.status_code, detail=r.text)
            return {"result": r.json()}

        def _resolve_incident_id(raw_id: Any, incident_number: Any) -> str:
            if incident_number is not None and raw_id is None:
                try:
                    n = int(incident_number)
                except Exception:
                    raise HTTPException(status_code=400, detail="arguments.incidentNumber must be an integer")

                lr = requests.get(
                    _gw_url("sentinel/incidents"),
                    params=_gw_params(),
                    headers=_gw_headers("read"),
                    timeout=60,
                )
                if lr.status_code >= 400:
                    raise HTTPException(status_code=lr.status_code, detail=lr.text)
                data = lr.json()
                candidates = data.get("value") if isinstance(data, dict) else None
                if not isinstance(candidates, list):
                    raise HTTPException(status_code=502, detail="Unexpected list_incidents response shape")

                match = None
                for item in candidates:
                    try:
                        props = item.get("properties", {}) if isinstance(item, dict) else {}
                        if int(props.get("incidentNumber")) == n:
                            match = item
                            break
                    except Exception:
                        continue

                if not match:
                    raise HTTPException(status_code=404, detail=f"No incident found with incidentNumber={n}")

                raw_id = match.get("name") or match.get("id")

            incident_id = _extract_incident_guid(raw_id)
            if not incident_id:
                raise HTTPException(
                    status_code=400,
                    detail="Missing arguments.id (or incident_id) or arguments.incidentNumber",
                )
            return incident_id

        if tool_name == "update_incident":
            raw_id = args.get("id") or args.get("incident_id") or args.get("incidentId")
            incident_number = args.get("incidentNumber") or args.get("incident_number")
            properties = args.get("properties")

            incident_id = _resolve_incident_id(raw_id, incident_number)

            # Some clients/LLMs send a "flat" patch shape (status/classification/etc) instead of nesting under properties.
            # Accept that and wrap it into properties.
            if not isinstance(properties, dict):
                flat = {
                    k: v
                    for k, v in args.items()
                    if k
                    not in (
                        "id",
                        "incident_id",
                        "incidentId",
                        "incidentNumber",
                        "incident_number",
                        "properties",
                    )
                }
                if flat:
                    properties = flat

            # Also accept top-level comment field (common LLM behavior).
            if isinstance(properties, dict) and "comment" not in properties and isinstance(args.get("comment"), str):
                properties["comment"] = args.get("comment")

            # Also accept a singular comment field and treat it as an incident comment write.
            if isinstance(properties, dict) and "comment" in properties and "comments" not in properties:
                properties["comments"] = properties.pop("comment")

            if not isinstance(properties, dict):
                raise HTTPException(status_code=400, detail="Missing arguments.properties (object) or flat incident fields")

            # If caller included comments/work notes, Sentinel expects them via incidentComments sub-resource.
            # Translate common shapes into add-comment calls.
            comments = None
            if isinstance(properties, dict):
                comments = properties.pop("comments", None)
            if comments is not None:
                texts: list[str] = []
                if isinstance(comments, str) and comments.strip():
                    texts.append(comments.strip())
                elif isinstance(comments, list):
                    for c in comments:
                        if isinstance(c, dict):
                            t = c.get("comment") or c.get("message")
                            if isinstance(t, str) and t.strip():
                                texts.append(t.strip())
                        elif isinstance(c, str) and c.strip():
                            texts.append(c.strip())
                # Best-effort: add each comment (ignore failures? no, bubble up)
                for t in texts:
                    cr = requests.post(
                        _gw_url(f"sentinel/incidents/{incident_id}/comments"),
                        params=_gw_params(),
                        headers=_gw_headers("write"),
                        json={"message": t},
                        timeout=60,
                    )
                    if cr.status_code >= 400:
                        raise HTTPException(status_code=cr.status_code, detail=cr.text)

                # If this was comment-only, we're done. Don't PATCH empty properties.
                if not properties:
                    return {"result": {"ok": True, "wrote_comment": True}}

                # NOTE: an earlier version of this code popped properties.status
                # here ("demo hardening") because direct PATCH on the incident
                # root used to flake under certain api-versions. The Gateway
                # has since switched to a GET-then-PUT-with-etag flow (see
                # foundry/function_app/shared/sentinel.py::update_incident)
                # which is the Microsoft-documented pattern that avoids those
                # flakes — so status changes can ride along with comment
                # writebacks now. Removing the pop was the fix for "reporter
                # closes but Sentinel still says New". Don't reintroduce it.

            r = requests.patch(
                _gw_url(f"sentinel/incidents/{incident_id}"),
                params=_gw_params(),
                headers=_gw_headers("write"),
                json={"properties": properties},
                timeout=60,
            )
            if r.status_code >= 400:
                raise HTTPException(status_code=r.status_code, detail=r.text)
            return {"result": r.json()}

        if tool_name == "ask_human":
            question = args.get("question")
            if not isinstance(question, str) or not question.strip():
                raise HTTPException(
                    status_code=400,
                    detail="Missing arguments.question (string)",
                )

            # Optional targeting — agents can address a specific human
            # (typically the one who triggered the workflow) by passing
            # `target` with their email. The HITL panel filters by
            # this; unset/empty = broadcast (legacy behavior).
            target = args.get("target")
            if not isinstance(target, str):
                target = ""
            target = target.strip().lower()

            # Optional incident_number — agents pass this so the
            # PixelAgents Web sidebar can group the question under the
            # right case in the analyst's "Incident Input Needed"
            # section. Unset = the question floats free (legacy
            # behavior, only used by chat-initiated ask_human calls
            # where there's no incident in scope).
            raw_incident = args.get("incident_number")
            if raw_incident is None:
                raw_incident = args.get("incidentNumber")
            incident_number_for_hitl: int | None = None
            if raw_incident is not None:
                try:
                    incident_number_for_hitl = int(raw_incident)
                except (TypeError, ValueError):
                    incident_number_for_hitl = None

            # PIXELAGENTS_URL is the events endpoint (e.g.
            # https://<pixelagents>/events). Strip the trailing /events
            # to get the base so we can hit /api/hitl/... on the same host.
            pa_events_url = os.getenv("PIXELAGENTS_URL", "").strip()
            pa_token = os.getenv("PIXELAGENTS_TOKEN", "").strip()
            if not pa_events_url or not pa_token:
                raise HTTPException(
                    status_code=503,
                    detail=(
                        "Human-in-the-loop not wired — PIXELAGENTS_URL / "
                        "PIXELAGENTS_TOKEN are not set on the runner. Run "
                        "terraform/3-deploy-pixelagents-web/scripts/configure_runner_pixelagents_env.sh."
                    ),
                )
            pa_base = pa_events_url
            for suffix in ("/events", "/events/"):
                if pa_base.endswith(suffix):
                    pa_base = pa_base[: -len(suffix)]
                    break
            pa_base = pa_base.rstrip("/")

            # Submit the question so the UI can show it.
            submit = requests.post(
                f"{pa_base}/api/hitl/questions",
                headers={
                    "x-pixelagents-token": pa_token,
                    "Content-Type": "application/json",
                },
                json={
                    "agent": agent or "unknown",
                    "question": question.strip(),
                    "target": target,
                    "incident_number": incident_number_for_hitl,
                },
                timeout=15,
            )
            if submit.status_code >= 400:
                raise HTTPException(status_code=submit.status_code, detail=submit.text)
            qid = submit.json().get("id")
            if not qid:
                raise HTTPException(
                    status_code=502,
                    detail="HITL submit did not return an id",
                )

            # Long-poll for the answer. Each HTTP call stays short (30s)
            # so we don't blow past Foundry's tool timeout per call, but
            # the loop is allowed to retry for the full 15-minute window
            # an analyst may need to consider an agent's question.
            MAX_WAIT_TOTAL_SEC = 900   # 15 minutes
            POLL_WINDOW_SEC = 30
            waited = 0
            answer_text: str | None = None
            while waited < MAX_WAIT_TOTAL_SEC:
                poll = requests.get(
                    f"{pa_base}/api/hitl/wait/{qid}",
                    params={"timeout": POLL_WINDOW_SEC},
                    headers={"x-pixelagents-token": pa_token},
                    timeout=POLL_WINDOW_SEC + 5,
                )
                if poll.status_code >= 400:
                    # Don't loop forever on a persistent error; bail.
                    raise HTTPException(status_code=poll.status_code, detail=poll.text)
                data = poll.json() if poll.content else {}
                if data.get("status") == "answered":
                    answer_text = data.get("answer") or ""
                    break
                waited += POLL_WINDOW_SEC

            if answer_text is None:
                answer_text = (
                    "(no human response within the allowed window; "
                    "proceed with your best judgment and note that you "
                    "were unable to reach a human)"
                )

            return {"result": {"answer": answer_text, "question_id": qid}}

        # ── Threat Intel hook ─────────────────────────────────────────
        # Lets the Investigator (or any agent that wants it) ask the
        # Threat Intel agent for a grounded answer mid-incident.
        # Single shot — caller passes a focused question, we invoke
        # the threat-intel Foundry agent via the Responses API and
        # return its text. Keeps the cross-agent contract narrow:
        # the caller doesn't need to know about Foundry endpoints,
        # tokens, or agent_reference shapes.
        if tool_name == "query_threat_intel":
            question = args.get("question")
            if not isinstance(question, str) or not question.strip():
                raise HTTPException(
                    status_code=400,
                    detail="Missing arguments.question (string)",
                )

            project_endpoint = (os.getenv("AZURE_AI_FOUNDRY_PROJECT_ENDPOINT", "") or "").strip()
            if not project_endpoint:
                raise HTTPException(
                    status_code=503,
                    detail=(
                        "query_threat_intel: AZURE_AI_FOUNDRY_PROJECT_ENDPOINT "
                        "is not set on the runner. Set it via terraform/3-... "
                        "configure_runner_pixelagents_env.sh after Phase 2 apply."
                    ),
                )

            try:
                from azure.identity import DefaultAzureCredential
            except Exception as e:
                raise HTTPException(
                    status_code=500,
                    detail=f"azure-identity not available on runner: {e!r}",
                )

            try:
                ai_token = DefaultAzureCredential().get_token(
                    "https://ai.azure.com/.default"
                ).token
            except Exception as e:
                raise HTTPException(
                    status_code=500,
                    detail=f"could not acquire Foundry bearer: {e!r}",
                )

            url = project_endpoint.rstrip("/") + "/openai/v1/responses"
            payload = {
                "input": (
                    "You are being invoked by another agent for a focused "
                    "threat-intel lookup. Keep your reply tight, "
                    "evidence-grounded, and cite sources.\n\n"
                    + question.strip()
                ),
                "agent_reference": {"name": "threat-intel", "type": "agent_reference"},
            }
            try:
                r = requests.post(
                    url,
                    headers={
                        "Authorization": f"Bearer {ai_token}",
                        "Content-Type": "application/json",
                    },
                    json=payload,
                    timeout=180,
                )
            except Exception as e:
                raise HTTPException(
                    status_code=502,
                    detail=f"threat-intel invoke raised: {e!r}",
                )
            if r.status_code >= 400:
                # Surface the upstream body so the caller can see why
                # the lookup failed (e.g. agent not deployed, Bing
                # connection missing).
                raise HTTPException(
                    status_code=502,
                    detail=f"threat-intel returned {r.status_code}: {r.text[:1500]}",
                )

            try:
                data = r.json()
            except Exception:
                data = {}
            # Same _response_text logic the orchestrator uses, inlined
            # here so the runner stays a self-contained module.
            answer = ""
            if isinstance(data, dict):
                if isinstance(data.get("output_text"), str):
                    answer = data["output_text"]
                else:
                    out = data.get("output") or []
                    pieces: list[str] = []
                    for item in out:
                        if not isinstance(item, dict):
                            continue
                        content = item.get("content") or []
                        if not isinstance(content, list):
                            continue
                        for block in content:
                            if isinstance(block, dict) and isinstance(block.get("text"), str):
                                pieces.append(block["text"])
                    if pieces:
                        answer = "\n".join(pieces)
            if not answer:
                answer = "(threat-intel returned no usable text)"

            return {"result": {"answer": answer}}

        # ── SOC Manager tools (read + propose, all approve-gated) ────
        # These all forward through PixelAgents Web because that's
        # where the Foundry agents-API + the CHANGES store live. The
        # runner just brokers the call from a Foundry agent to PA-Web.
        if tool_name in (
            "get_agent_role_instructions",
            "get_template",
            "propose_change_to_preamble",
            "propose_change_to_agent_instructions",
            "propose_change_to_detection_rule",
        ):
            pa_events_url = os.getenv("PIXELAGENTS_URL", "").strip()
            pa_token = os.getenv("PIXELAGENTS_TOKEN", "").strip()
            if not pa_events_url or not pa_token:
                raise HTTPException(
                    status_code=503,
                    detail=(
                        "SOC Manager writeback not wired — PIXELAGENTS_URL / "
                        "PIXELAGENTS_TOKEN are not set on the runner. Run "
                        "terraform/3-deploy-pixelagents-web/scripts/configure_runner_pixelagents_env.sh."
                    ),
                )
            pa_base = pa_events_url
            for suffix in ("/events", "/events/"):
                if pa_base.endswith(suffix):
                    pa_base = pa_base[: -len(suffix)]
                    break
            pa_base = pa_base.rstrip("/")
            pa_headers = {
                "x-pixelagents-token": pa_token,
                "Content-Type": "application/json",
            }

            if tool_name == "get_agent_role_instructions":
                target = args.get("agent")
                if not isinstance(target, str) or not target.strip():
                    raise HTTPException(
                        status_code=400,
                        detail="Missing arguments.agent (one of: triage, investigator, reporter, detection-engineer)",
                    )
                target = target.strip().lower()
                r = requests.get(
                    f"{pa_base}/api/foundry/agents/instructions",
                    headers={"x-pixelagents-token": pa_token},
                    timeout=30,
                )
                if r.status_code >= 400:
                    raise HTTPException(status_code=r.status_code, detail=r.text)
                data = r.json()
                # Find the matching agent in the response.
                for entry in (data.get("agents") or []):
                    if entry.get("slug") == target:
                        return {
                            "result": {
                                "agent": target,
                                "role_instructions": entry.get("instructions") or "",
                            },
                        }
                raise HTTPException(
                    status_code=404,
                    detail=f"Agent {target!r} not found in roster",
                )

            if tool_name == "get_template":
                # Reporter / SOC Manager / Detection Engineer call this
                # to fetch the soc-manager-curated output shape they
                # should follow. Each kind's body is plain markdown the
                # agent uses as the structure for its next message.
                kind = args.get("kind")
                if not isinstance(kind, str) or not kind.strip():
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            "Missing arguments.kind (one of: incident-comment, "
                            "improvement-report, detection-rule-proposal)"
                        ),
                    )
                kind = kind.strip().lower()
                r = requests.get(
                    f"{pa_base}/api/templates/{kind}",
                    headers={"x-pixelagents-token": pa_token},
                    timeout=30,
                )
                if r.status_code == 404:
                    raise HTTPException(
                        status_code=404,
                        detail=f"Unknown template kind {kind!r}",
                    )
                if r.status_code >= 400:
                    raise HTTPException(status_code=r.status_code, detail=r.text)
                data = r.json()
                return {
                    "result": {
                        "kind": kind,
                        "label": data.get("label") or kind,
                        "description": data.get("description") or "",
                        "content": data.get("content") or "",
                    },
                }

            # Common validation for the propose_* tools.
            rationale = args.get("rationale")
            title = args.get("title") or ""
            if not isinstance(rationale, str) or not rationale.strip():
                raise HTTPException(
                    status_code=400,
                    detail="Missing arguments.rationale (string)",
                )

            if tool_name == "propose_change_to_preamble":
                proposed = args.get("proposed")
                if not isinstance(proposed, str) or not proposed.strip():
                    raise HTTPException(
                        status_code=400,
                        detail="Missing arguments.proposed (full new preamble, string)",
                    )
                body = {
                    "agent": agent or "soc-manager",
                    "kind": "knowledge-preamble",
                    "title": title.strip(),
                    "rationale": rationale.strip(),
                    "proposed": proposed,
                }

            elif tool_name == "propose_change_to_agent_instructions":
                target_agent = args.get("agent")
                if not isinstance(target_agent, str) or not target_agent.strip():
                    raise HTTPException(
                        status_code=400,
                        detail="Missing arguments.agent (one of: triage, investigator, reporter, detection-engineer)",
                    )
                proposed = args.get("proposed")
                if not isinstance(proposed, str) or not proposed.strip():
                    raise HTTPException(
                        status_code=400,
                        detail="Missing arguments.proposed (full new role-specific instructions, string)",
                    )
                body = {
                    "agent": agent or "soc-manager",
                    "kind": "agent-instructions",
                    "target": target_agent.strip().lower(),
                    "title": title.strip(),
                    "rationale": rationale.strip(),
                    "proposed": proposed,
                }

            else:  # propose_change_to_detection_rule
                # The agent passes the rule definition as a flat
                # set of fields (displayName, description, severity,
                # query, ...). We assemble them into a single
                # `proposed` JSON object that the server validates.
                rule_fields = ("displayName", "description", "severity",
                               "query", "queryFrequency", "queryPeriod",
                               "triggerOperator", "triggerThreshold",
                               "tactics", "techniques", "enabled",
                               "suppressionDuration", "suppressionEnabled")
                proposed = {k: args[k] for k in rule_fields if k in args}
                if not isinstance(proposed.get("displayName"), str) \
                   or not isinstance(proposed.get("query"), str):
                    raise HTTPException(
                        status_code=400,
                        detail="detection-rule needs displayName + query (KQL)",
                    )
                body = {
                    "agent": agent or "soc-manager",
                    "kind": "detection-rule",
                    "target": proposed.get("displayName") or "",
                    "title": title.strip() or proposed.get("displayName") or "",
                    "rationale": rationale.strip(),
                    "proposed": proposed,
                }

            r = requests.post(
                f"{pa_base}/api/changes",
                headers=pa_headers,
                json=body,
                timeout=30,
            )
            if r.status_code >= 400:
                raise HTTPException(status_code=r.status_code, detail=r.text)
            return {"result": r.json()}

        # ── Web search + fetch (Threat Intel / Investigator) ──────────
        # Two runner-side tools that give any agent live internet access
        # without needing Foundry's bing_grounding tool wired up. They
        # complement bing_grounding (when present) but don't require it.
        #
        #   web_search(query, max_results=5)
        #     → Tavily-backed search. Requires TAVILY_API_KEY on the
        #       runner. Returns clean JSON with title / url / snippet.
        #       Tavily's free tier covers 1000 searches/month and signup
        #       is one form. Without the key we return a 503 with a
        #       clear setup pointer so the agent's reply tells the
        #       human exactly what to fix.
        #   fetch_url(url, max_chars=5000)
        #     → Plain HTTPS fetch with a normal User-Agent. Strips
        #       scripts/styles, returns a text excerpt capped at
        #       max_chars. No third-party API needed.

        if tool_name == "web_search":
            query = args.get("query")
            if not isinstance(query, str) or not query.strip():
                raise HTTPException(
                    status_code=400,
                    detail="Missing arguments.query (string)",
                )
            max_results_raw = args.get("max_results")
            try:
                max_results = int(max_results_raw) if max_results_raw is not None else 5
            except Exception:
                max_results = 5
            max_results = max(1, min(10, max_results))

            tavily_key = os.getenv("TAVILY_API_KEY", "").strip()
            # Terraform writes the literal "<unset>" sentinel when no
            # key was supplied (the Container App secret has to exist
            # before the env can reference it). Treat it as missing.
            if tavily_key == "<unset>":
                tavily_key = ""
            if not tavily_key:
                raise HTTPException(
                    status_code=503,
                    detail=(
                        "web_search not wired — TAVILY_API_KEY is not set "
                        "on the runner. Sign up at https://tavily.com (free "
                        "tier: 1000 searches/month), then export "
                        "TAVILY_API_KEY in aisoc.config and re-run "
                        "`bash aisoc_demo.sh deploy --phase 2` so Terraform "
                        "lands the new runner secret. fetch_url still works "
                        "without this key when you already have a URL."
                    ),
                )

            try:
                r = requests.post(
                    "https://api.tavily.com/search",
                    headers={"Content-Type": "application/json"},
                    json={
                        "api_key":      tavily_key,
                        "query":        query.strip(),
                        "max_results":  max_results,
                        "search_depth": "basic",
                        "include_answer": True,
                    },
                    timeout=30,
                )
            except Exception as e:
                raise HTTPException(
                    status_code=502,
                    detail=f"web_search upstream error: {e!r}",
                )
            if r.status_code >= 400:
                raise HTTPException(
                    status_code=r.status_code,
                    detail=f"Tavily {r.status_code}: {r.text[:300]}",
                )

            try:
                data = r.json()
            except Exception:
                data = {}
            results = data.get("results") or []
            slim = []
            for item in results[:max_results]:
                if not isinstance(item, dict):
                    continue
                slim.append({
                    "title":   (item.get("title") or "")[:200],
                    "url":     item.get("url") or "",
                    "snippet": (item.get("content") or "")[:600],
                    "score":   item.get("score"),
                })
            return {
                "result": {
                    "query":   query.strip(),
                    "answer":  data.get("answer") or "",
                    "results": slim,
                    "count":   len(slim),
                },
            }

        if tool_name == "fetch_url":
            url = args.get("url")
            if not isinstance(url, str) or not url.strip():
                raise HTTPException(
                    status_code=400,
                    detail="Missing arguments.url (string)",
                )
            url = url.strip()
            if not (url.startswith("http://") or url.startswith("https://")):
                raise HTTPException(
                    status_code=400,
                    detail="url must start with http:// or https://",
                )
            max_chars_raw = args.get("max_chars")
            try:
                max_chars = int(max_chars_raw) if max_chars_raw is not None else 5000
            except Exception:
                max_chars = 5000
            max_chars = max(500, min(20000, max_chars))

            try:
                r = requests.get(
                    url,
                    headers={
                        # Some sites 403 a bare requests/python User-Agent.
                        "User-Agent": (
                            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                            "AppleWebKit/537.36 (KHTML, like Gecko) "
                            "Chrome/124.0.0.0 Safari/537.36"
                        ),
                        "Accept": "text/html,application/xhtml+xml,*/*;q=0.8",
                    },
                    timeout=20,
                    allow_redirects=True,
                )
            except Exception as e:
                raise HTTPException(
                    status_code=502,
                    detail=f"fetch_url upstream error: {e!r}",
                )

            ct = (r.headers.get("Content-Type") or "").lower()
            text = ""
            if "html" in ct or "xml" in ct:
                # Cheap HTML→text: strip script/style + tags. Avoids
                # depending on BeautifulSoup so the runner image stays
                # lean. Good enough for skimming a CVE / blog page.
                import re as _re
                raw = r.text
                raw = _re.sub(r"<script\b.*?</script>", " ", raw, flags=_re.DOTALL | _re.IGNORECASE)
                raw = _re.sub(r"<style\b.*?</style>", " ", raw, flags=_re.DOTALL | _re.IGNORECASE)
                raw = _re.sub(r"<[^>]+>", " ", raw)
                # Decode common HTML entities + collapse whitespace.
                import html as _html
                raw = _html.unescape(raw)
                text = _re.sub(r"\s+", " ", raw).strip()
            else:
                text = r.text or ""

            return {
                "result": {
                    "url":          r.url,
                    "status":       r.status_code,
                    "content_type": ct or None,
                    "text":         text[:max_chars],
                    "truncated":    len(text) > max_chars,
                },
            }

        if tool_name == "create_analytic_rule":
            # Inputs (all optional except displayName + query):
            #   displayName, description, severity (Low/Medium/High/Informational),
            #   query (KQL), queryFrequency ("PT5M"...), queryPeriod,
            #   triggerOperator ("GreaterThan"...), triggerThreshold,
            #   tactics ([]), techniques ([]), enabled (bool), suppressionDuration,
            #   suppressionEnabled
            # We default anything missing so a minimal agent call still produces
            # a functional rule, and we auto-generate the rule UUID so the
            # agent doesn't have to manage it.
            import uuid as _uuid

            display_name = args.get("displayName") or args.get("display_name")
            query_kql = args.get("query")
            if not isinstance(display_name, str) or not display_name.strip():
                raise HTTPException(
                    status_code=400,
                    detail="Missing arguments.displayName (string)",
                )
            if not isinstance(query_kql, str) or not query_kql.strip():
                raise HTTPException(
                    status_code=400,
                    detail="Missing arguments.query (string, KQL)",
                )

            severity = args.get("severity") or "Medium"
            if severity not in ("Informational", "Low", "Medium", "High"):
                severity = "Medium"

            trigger_operator = args.get("triggerOperator") or "GreaterThan"
            if trigger_operator not in ("GreaterThan", "LessThan", "Equal", "NotEqual"):
                trigger_operator = "GreaterThan"

            def _clean_list(v: Any) -> list:
                if isinstance(v, list):
                    return [str(x) for x in v if isinstance(x, (str, int))]
                if isinstance(v, str) and v.strip():
                    return [v.strip()]
                return []

            properties = {
                "displayName": display_name.strip(),
                "description": args.get("description") or f"Proposed by AISOC Detection Engineer: {display_name}",
                "severity": severity,
                "enabled": bool(args.get("enabled", True)),
                "query": query_kql,
                "queryFrequency": args.get("queryFrequency") or "PT5M",
                "queryPeriod": args.get("queryPeriod") or args.get("queryFrequency") or "PT5M",
                "triggerOperator": trigger_operator,
                "triggerThreshold": int(args.get("triggerThreshold", 0)),
                "suppressionDuration": args.get("suppressionDuration") or "PT1H",
                "suppressionEnabled": bool(args.get("suppressionEnabled", False)),
                "tactics": _clean_list(args.get("tactics")),
                "techniques": _clean_list(args.get("techniques")),
            }

            rule_id = args.get("rule_id") or str(_uuid.uuid4())

            r = requests.put(
                _gw_url(f"sentinel/analytic_rules/{rule_id}"),
                params=_gw_params(),
                headers=_gw_headers("write"),
                json={"properties": properties},
                timeout=60,
            )
            if r.status_code >= 400:
                raise HTTPException(status_code=r.status_code, detail=r.text)
            return {"result": {"rule_id": rule_id, "rule": r.json()}}

        if tool_name == "add_incident_comment":
            raw_id = args.get("id") or args.get("incident_id") or args.get("incidentId")
            incident_number = args.get("incidentNumber") or args.get("incident_number")
            message = args.get("message") or args.get("comment")

            incident_id = _resolve_incident_id(raw_id, incident_number)

            if not isinstance(message, str) or not message.strip():
                raise HTTPException(status_code=400, detail="Missing arguments.message (string)")

            r = requests.post(
                _gw_url(f"sentinel/incidents/{incident_id}/comments"),
                params=_gw_params(),
                headers=_gw_headers("write"),
                json={"message": message.strip()},
                timeout=60,
            )
            if r.status_code >= 400:
                raise HTTPException(status_code=r.status_code, detail=r.text)
            return {"result": r.json()}

        raise HTTPException(
            status_code=400,
            detail=f"Unknown tool_name: {tool_name!r}; payload_keys={sorted(list(payload.keys()))}",
        )

    except HTTPException as http_err:
        # Convert HTTPException into a *structured* 200 response so the
        # calling agent can read the error and decide how to recover
        # (retry with different args, explain the limitation to the user,
        # ask a human, etc.) rather than having Foundry terminate the
        # response with tool_user_error.
        #
        # We deliberately DON'T do this for bearer auth — that's checked
        # by _require_bearer *before* this try block and fires its own
        # HTTP 401/403. Anything that reaches here is either an agent
        # input problem (400 — missing args, unknown tool) or an upstream
        # Gateway/ARM/LAW problem (4xx/5xx); both are things the agent
        # can reason about if we let it see them.
        detail = http_err.detail
        if not isinstance(detail, str):
            try:
                detail = json.dumps(detail)
            except Exception:
                detail = str(detail)
        try:
            print(
                f"[tools_execute] tool_error tool_name={tool_name!r} status={http_err.status_code} detail={detail[:400]!r}",
                flush=True,
            )
        except Exception:
            pass
        return {
            "result": {
                "ok": False,
                "error": {
                    "type": "tool_error",
                    "status": http_err.status_code,
                    "message": detail,
                },
            }
        }
    except Exception as e:
        # Ensure we always get a deterministic traceback in Container Apps logs.
        try:
            import traceback

            print(
                f"[tools_execute] unhandled_exception tool_name={tool_name!r} agent={agent!r} err={e!r}",
                flush=True,
            )
            traceback.print_exc()
        except Exception:
            pass
        # Same principle as above: surface the exception as a structured
        # 200 so the agent stays alive and can report the failure instead
        # of Foundry nuking the whole response.
        return {
            "result": {
                "ok": False,
                "error": {
                    "type": "runner_exception",
                    "message": f"{type(e).__name__}: {e}",
                },
            }
        }

    finally:
        ended = time.time()
        _emit_pixelagents_event(
            {
                "type": "tool.call.end",
                "agent": agent,
                "state": "idle",
                "tool_name": tool_name,
                "duration_ms": int((ended - started) * 1000),
                "incident_number": incident_number_for_event,
                "ts": ended,
            }
        )


if __name__ == "__main__":
    import uvicorn

    port = int(os.getenv("PORT", "8080"))
    uvicorn.run(app, host="0.0.0.0", port=port)
