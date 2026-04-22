# Phase 2 scripts (2-deploy-aisoc)

## Supported / current flow

Run these in order (after `terraform apply` in `terraform/2-deploy-aisoc`):

1) Deploy SOCGateway Function code

```bash
./scripts/deploy_socgateway_function.sh
```

2) Configure Runner with the SOCGateway function key

```bash
./scripts/configure_runner_socgateway_key.sh
```

3) Deploy prompt agents wired to the runner OpenAPI tool

```bash
./scripts/deploy_prompt_agents_with_runner_tools.sh
```

Notes:
- `deploy_prompt_agents_with_runner_tools.sh` bootstraps its own `.venv/` and installs Python deps from `scripts/requirements.txt`.
- It also creates (or fixes) the Foundry project connection `aisoc-runner-key` used for the runner bearer header.

## Legacy scripts

Older experiments and alternate deployment approaches live in `scripts/legacy/`.
They are kept for reference but are not part of the happy-path demo flow.
