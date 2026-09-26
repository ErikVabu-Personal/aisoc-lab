# Maison Miró — logging schema + attack runbook (the web victim)

Maison Miró is the public-facing web store (the web victim, replacing the old Ship
Control Panel). This page is the canonical reference the SOC agents retrieve when an
incident's rule reads `ContainerAppConsoleLogs_CL` for Maison. It covers the log shape,
the base filter, the event catalogue, and the investigation runbook.

## Log shape — the `[EVENT]` line

Maison runs as a Container App; its stdout is shipped to `ContainerAppConsoleLogs_CL`
(`ContainerName_s == "maison-miro"`). Each security event is one line:

```
[EVENT] {"ts":"2026-09-26T14:03:11","type":"auth.login_bypass","severity":"high","message":"...","source_ip":"10.0.0.5","session":"eyJ1aWQi...","by":null}
```

Note the literal **`[EVENT] ` prefix** (8 chars) before the JSON — strip it before
parsing. **Base filter (use this everywhere):**

```kusto
ContainerAppConsoleLogs_CL
| where ContainerName_s == "maison-miro"
| where Log_s startswith "[EVENT] "
| extend j = parse_json(substring(Log_s, 8))
| extend etype = tostring(j.type), severity = tostring(j.severity),
         source_ip = tostring(j.source_ip), message = tostring(j.message),
         session = tostring(j.session), actor = tostring(j.by)
```

Fields (every event): `ts` (ISO-8601, naive UTC-ish), `type` (dotted, see catalogue),
`severity` (`info`/`low`/`medium`/`high`/`critical`), `message`, `source_ip` (the real
client IP — the app honours `X-Forwarded-For`), `session` (first 16 chars of the session
cookie), `by` (actor for SOC actions, else null), plus optional extras. **`source_ip` is
the incident correlation key** — one attacker walks the whole kill chain from one IP.

## Event catalogue (what each attack emits)

| `type` | severity | Attack |
|--------|----------|--------|
| `recon.disallowed_path` | low | Scanning `/api*`, `/admin`, `/invoice*` (precursor) |
| `auth.sqli_attempt` | high | SQL metacharacters in the login form |
| `auth.login_bypass` | high | Successful SQL-injection auth bypass |
| `auth.session_forged` | high | Forged/unsigned session cookie (privilege forgery) |
| `xss.stored_attempt` | high | Stored-XSS payload in a product review |
| `data.exfil_attempt` | critical | Bulk PII pull from `/api/customers` |
| `data.honeytoken_touched` | critical | **Zero-false-positive** — the decoy record on `/api/customers` page 1 was read; no legitimate flow touches it |
| `data.idor_access` | critical | IDOR on someone else's order/invoice |
| `fraud.price_mismatch` | critical | Checkout price/quantity tampering |
| `containment.engaged` | info | Auto-SOAR contained a source (see below) |
| `containment.blocked` | info | A contained source was blocked from crown-jewels |
| `soc.armed` / `soc.disarmed` / `soc.released` | info | SOC control-plane changes |

The **critical** four (`data.*`, `fraud.price_mismatch`) are the crown-jewel-theft
signal; the **high** four (`auth.*`, `xss.stored_attempt`) are the break-in signal.
`data.honeytoken_touched` is the cleanest "theft in progress" indicator.

## Built-in SOC / auto-response

Maison has its own `/soc/*` API (key `X-SOC-Key`). When armed (`SOC_ARMED=1`), any
`critical` event auto-triggers containment (`containment.engaged`, `by:"auto-soar"`) and
subsequent crown-jewel access from that source is blocked (`containment.blocked`). So on a
true positive you'll typically see: the critical event → a follow-on `containment.engaged`
→ `containment.blocked`. Those last two are the **"response worked"** evidence.

## Investigation runbook

The kill chain (all one `source_ip`):
`recon.disallowed_path` → `auth.sqli_attempt`/`auth.login_bypass` (break-in) →
`auth.session_forged` (privilege forge) → `data.exfil_attempt`/`data.honeytoken_touched`
/`data.idor_access` and/or `fraud.price_mismatch` (impact).

1. **Scope by source IP** — pull the attacker's full timeline:
   ```kusto
   ContainerAppConsoleLogs_CL
   | where ContainerName_s == "maison-miro" and Log_s startswith "[EVENT] "
   | extend j = parse_json(substring(Log_s, 8))
   | where tostring(j.source_ip) == "<ip>"
   | project TimeGenerated, etype=tostring(j.type), severity=tostring(j.severity), message=tostring(j.message)
   | order by TimeGenerated asc
   ```
2. **Confirm impact** — any `severity == "critical"` for that IP = data theft / fraud
   succeeded (or was attempted). `data.honeytoken_touched` = definitive.
3. **Check the response** — look for `containment.engaged` / `containment.blocked` for the
   same IP: if present, auto-SOAR already contained it (crown-jewels protected).
4. **Verdict:** any critical without prior legitimate context → true positive, escalate.
   Recon-only / a single blocked attempt with containment → contained, lower urgency.

## Verdict mapping

| Pattern | Verdict |
|---------|---------|
| `data.honeytoken_touched` or `data.exfil_attempt` (critical) from an IP | Active — true positive, data theft; confirm containment, escalate |
| `data.idor_access` / `fraud.price_mismatch` (critical) | Active — true positive; escalate |
| `auth.login_bypass` / `auth.session_forged` (high) then a critical | Active — full break-in → theft chain; escalate L3 |
| `auth.sqli_attempt` / recon only, no success, no critical | Closed (attempt blocked / scanner) |
| Critical event **followed by** `containment.engaged` + `containment.blocked` | Contained — note the SOC auto-response worked in the case |

## Containment (recommendation only — humans/auto-SOAR execute)

Maison's own SOC contains automatically when armed. A responder can also call
`POST <maison-url>/soc/contain` with `X-SOC-Key` (`{ip, reason, by}`) to block a source,
or `POST /soc/release?reset_scores=1` to reset between demo runs.
