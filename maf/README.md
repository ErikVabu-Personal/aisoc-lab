# AISOC Agents (Microsoft Agent Framework)

This folder contains the AISOC demo agents implemented using **Microsoft Agent Framework (MAF)**.

## Goal

Provide 3 role-based SOC agents that call the SOC Gateway tool endpoints:

- **Triage** — summarize incident + decide initial next steps
- **Investigator** — run deeper KQL, correlate artifacts, propose hypotheses
- **Reporter** — produce an executive-ready narrative and recommended actions

## Configuration

Set environment variables:

- `AISOC_GATEWAY_BASE_URL` e.g. `https://<functionapp>.azurewebsites.net/api`
- `AISOC_FUNCTION_CODE` — Azure Functions function key (`code=...`)
- `AISOC_READ_KEY` — read key for gateway endpoints
- `AISOC_WRITE_KEY` — write key for mutation endpoints

> Keys should never be committed. Use local env vars, a `.env` file, or Key Vault.

## Run

After installing into a venv (`pip install -e .`), run:

```bash
# Always works (module invocation)
python -m aisoc_maf.cli triage <INCIDENT_ID>
```

If your environment exposes the entrypoint on PATH, this also works:

```bash
aisoc triage <INCIDENT_ID>
```
