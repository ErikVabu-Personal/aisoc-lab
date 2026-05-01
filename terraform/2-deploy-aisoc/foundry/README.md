# SOC Gateway Function App (Phase 2)

The **SOC Gateway** is the only path the AISOC Runner has to write to
Microsoft Sentinel. It's an Azure Functions app (Python, function-
auth) that authenticates with the Sentinel workspace via a managed
identity and exposes a small, deliberate set of REST endpoints that
the Runner invokes on behalf of Foundry agents.

```
Foundry agent
    │  (OpenAPI tool, bearer token)
    ▼
AISOC Runner ─── (HTTPS + ?code=<host-key>) ──▶  SOC Gateway  ──▶  Sentinel + Log Analytics
```

Splitting Runner ↔ Gateway is a deliberate trust-boundary move:

- The **Runner** holds the agent-facing bearer token and the OpenAPI
  schemas. It runs in a Container App with no Sentinel-write
  identity.
- The **Gateway** holds the Sentinel-write managed identity. It only
  accepts requests carrying a valid host-key (`?code=`), which the
  Runner is given on first apply by
  `scripts/configure_runner_socgateway_key.sh`.

If the Gateway code is redeployed, the host-key rotates and the
Runner needs to be rewired — the post-apply hook in the Gateway's
GitHub Actions workflow runs `configure_runner_socgateway_key.sh`
automatically after every zip-deploy.

## Endpoints

| Path | Used for |
|------|----------|
| `POST /kql/query` | Run a KQL query against the workspace. The Runner exposes this as `kql_query`. |
| `GET  /sentinel/incidents` | List incidents. Backs `list_incidents`. |
| `GET  /sentinel/incidents/{id}` | Fetch one incident + its alerts + related entities. Backs `get_incident`. |
| `PATCH /sentinel/incidents/{id}` | Owner / status / classification updates. Backs `update_incident`. |
| `POST /sentinel/incidents/{id}/comments` | Append a comment to the case timeline. Backs `add_incident_comment` — every Triage / Investigator / Reporter run drops one. |
| `POST /sentinel/create-rule` | Create a Sentinel analytic rule from a JSON spec. Used only by the Detection Engineer agent's `create_analytic_rule` path. |

All endpoints are `authLevel="function"`. The Gateway's host-key is
shared once with the Runner at deploy time and rotated automatically
on Gateway code redeploys.

## Where the code lives

```
terraform/2-deploy-aisoc/foundry/
├─ README.md                 (this file)
└─ function_app/
    ├─ host.json
    ├─ requirements.txt
    ├─ shared/
    │   ├─ auth.py           — function-auth + MI-token helpers
    │   ├─ sentinel.py       — Sentinel + Log Analytics REST helpers
    │   └─ payloads.py       — request / response shapes
    └─ SOCGateway/
        ├─ function.json
        └─ __init__.py       — the route dispatcher
```

The Function App resource itself is provisioned by `main.tf` in the
parent `2-deploy-aisoc/` folder. The agent code is shipped via the
`deploy-soc-gateway.yml` GitHub Actions workflow on every push that
touches `terraform/2-deploy-aisoc/foundry/function_app/**`.

## Deploying the Function code

The standard path is **GitHub Actions** — push to `main` and the
workflow takes over. For a one-off manual deploy:

```bash
cd terraform/2-deploy-aisoc/foundry/function_app
zip -r function_app.zip .
az functionapp deployment source config-zip \
  --resource-group  $(cd ../.. && terraform output -raw resource_group) \
  --name            $(cd ../.. && terraform output -raw soc_gateway_function_name) \
  --src             function_app.zip

# Re-wire the runner with the new host key (the redeploy rotated it).
cd ../../scripts
./configure_runner_socgateway_key.sh
```

## Calling the API for debugging

Pull the host key from Key Vault (Phase 1's `aisoc-kv-*` vault stores
it) or the portal, then:

```bash
KEY="<host-key>"
APP="$(cd terraform/2-deploy-aisoc && terraform output -raw soc_gateway_function_name)"

# Recent incidents:
curl -s "https://${APP}.azurewebsites.net/api/sentinel/incidents?code=${KEY}" | jq

# A KQL query:
curl -s -X POST "https://${APP}.azurewebsites.net/api/kql/query?code=${KEY}" \
  -H 'content-type: application/json' \
  -d '{"query":"SecurityIncident | take 5"}' | jq
```
