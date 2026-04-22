# Skill: Incident triage (Sentinel)

## When to use

Use when you need to quickly understand an incident, assess severity, and propose next actions.

## Inputs

- Incident reference (prefer `incidentNumber`; otherwise incident id/GUID)
- If user provides a time window, use it; otherwise default to the incident’s timestamps.

## Steps

1) Retrieve incident details
- Tool: `get_incident` with `{ "incidentNumber": <n> }` or `{ "id": "<guid>" }`

2) Extract key context
- Title, severity, status, createdTime, lastUpdatedTime
- Entities: accounts, hosts, IPs, URLs, file hashes (if present)

3) Validate scope with 2–4 targeted KQL queries
Default queries (adjust table names to what exists in the workspace):

- Recent Security events / logon anomalies (timeboxed):
  - `SecurityEvent | where TimeGenerated > ago(4h) | summarize count() by EventID`
- Sign-in anomalies (if available):
  - `SigninLogs | where TimeGenerated > ago(24h) | summarize count() by ResultType`
- Sentinel alerts around timeframe:
  - `SecurityAlert | where TimeGenerated > ago(24h) | summarize count() by AlertName`

Use entity-specific filters when you have them (e.g., account, host, IP).

4) Classify severity + next steps
- If clear malicious behavior: recommend containment + deeper investigation
- If unclear: list what evidence to collect next

## Output template

- Summary (bullets)
- What I checked (incident + queries)
- Findings (evidence)
- Next steps (prioritized)
