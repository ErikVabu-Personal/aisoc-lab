# Phase 5 — RedAmon (AI red-team attacker) on Azure

Drops a **RedAmon** VM into GOAD's Azure VNet so it can attack the AD estate
intra-VNet and hit the Maison Miró store over its public URL. RedAmon is the
autonomous attacker whose activity the blue side (Sentinel + Foundry agents) then
detects and triages. Ported from the AWS `redamon.tf` — same cloud-init.

## What it builds

In GOAD's resource group + subnet (discovered by name): a public IP, an NSG
(SSH + `:3000` locked to `admin_cidrs`), a NIC in `<lab>-vm-subnet`, and an Ubuntu
22.04 VM (`redamon_size` default `Standard_D4as_v4`, 200 GB — the driver auto-picks a
capacity-available size per region, see `scripts/azure_preflight.py`). cloud-init
(`templates/redamon-init.sh.tpl`, verbatim from the AWS box) installs Docker + jq,
clones RedAmon, and runs `./redamon.sh install --gvm` in a tmux session. Optional
Tailscale/keepalive for a self-hosted LLM (set `home_llm_tailscale_ip`).

## Prerequisites

- GOAD deployed on Azure (`goad.sh -p azure`) — this discovers its
  VNet/subnet/RG by name (override `goad_vnet_name` / `goad_subnet_name` /
  `goad_resource_group` if your lab differs).
- `terraform` ≥ 1.6, `az` logged in.

## Deploy

```bash
cd terraform/5-deploy-redamon
terraform init
terraform apply -var 'admin_cidrs=["<your-ip>/32"]'
# or via the driver (auto-locks SSH/UI to your resolved public IP, auto-picks a
# capacity-available VM size): ../../aisoc_demo.sh deploy --with-redamon
```

**`admin_cidrs`:** the Terraform default is `["0.0.0.0/0"]` (open), so a bare
`terraform apply` leaves SSH/`:3000` world-reachable — always pass your own `/32`.
The **driver** resolves your public IP (via ifconfig.me) and locks it to a `/32`
automatically when `admin_cidrs` is unset, so `--with-redamon` needs no manual CIDR;
override with `--admin-cidrs='["a.b.c.d/32"]'`.

## Access

GOAD's subnet NSG only permits SSH inbound, so reach the RedAmon UI via an SSH
tunnel (see `terraform output redamon_ui_tunnel`):

```bash
ssh -i ssh_keys/redamon.pem -L 3000:localhost:3000 azureuser@<public-ip>
# then browse http://localhost:3000
```

The on-box install is admin-run: SSH in, `sudo tmux attach -t redamon`, create the
admin account, add an LLM key in `/settings`. Point RedAmon at the GOAD AD range
(intra-VNet) and the Maison Miró store URL
(`terraform -chdir=../1-deploy-sentinel output -raw maison_url`).

## Notes

- **Stateful:** the VM ignores `custom_data` changes (findings/graph/DBs live on
  it); editing the template only affects a fresh box.
- Cost: a `Standard_D4s_v3` + 200 GB runs while up — the main cost of this phase.
  `terraform destroy` (or `aisoc_demo.sh destroy`, which tears Phase 5 down first)
  removes it. Destroy this **before** destroying GOAD (it references GOAD's VNet).
