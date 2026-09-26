#!/usr/bin/env bash
# cloud-init user-data for the RedAmon box. Runs as root on first boot.
set -euxo pipefail
export DEBIAN_FRONTEND=noninteractive

apt-get update -y
# jq is required by redamon.sh (it bails at 'docker compose up' without it).
apt-get install -y git tmux ca-certificates curl unzip jq

# Docker Engine + Compose v2 plugin (RedAmon requires compose v2).
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sh
fi
usermod -aG docker ${ssh_username} || true

%{ if home_llm_ip != "" ~}
# --- Tailscale: reach a self-hosted LLM over the tailnet --------------------
# Installs Tailscale + a keepalive service that pings the LLM node every 55s so
# the direct P2P path stays warm (if it lapses to the DERP relay the agent chat
# starts timing out). Enabled by setting home_llm_tailscale_ip.
if ! command -v tailscale >/dev/null 2>&1; then
  # cloud-init usually has apt to itself, but wait briefly for any lock.
  for i in $(seq 1 30); do
    if fuser /var/lib/dpkg/lock-frontend >/dev/null 2>&1; then sleep 5; else break; fi
  done
  curl -fsSL https://tailscale.com/install.sh | sh
fi
%{ if tailscale_authkey != "" ~}
# Auth key supplied: join the tailnet unattended.
tailscale up --authkey='${tailscale_authkey}' --hostname='${tailscale_hostname}' --accept-routes || true
%{ else ~}
# No auth key: join by hand after boot with 'sudo tailscale up' (prints a URL).
%{ endif ~}
cat > /etc/systemd/system/ts-keepalive.service <<'KA'
[Unit]
Description=Tailscale direct-path keepalive to self-hosted LLM (${home_llm_ip})
After=tailscaled.service
Wants=tailscaled.service

[Service]
ExecStart=/bin/sh -c 'TS=$(command -v tailscale); while true; do "$TS" ping -c 1 ${home_llm_ip} >/dev/null 2>&1 || true; sleep 55; done'
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
KA
systemctl daemon-reload
systemctl enable --now ts-keepalive.service
%{ endif ~}

# Clone RedAmon.
rm -rf /opt/redamon
git clone --branch ${branch} ${repo_url} /opt/redamon
chown -R ${ssh_username}:${ssh_username} /opt/redamon

# The installer prompts for an admin account at the end, so run it detached in
# tmux (root: docker lives here) rather than blocking cloud-init. Attach later
# with: sudo tmux attach -t redamon
chmod +x /opt/redamon/redamon.sh || true
tmux new-session -d -s redamon \
  "cd /opt/redamon && ./redamon.sh install ${gvm_flag} 2>&1 | tee /var/log/redamon-install.log; exec bash"

cat > /etc/motd <<'MOTD'
==================================================================
 RedAmon - autonomous AI red-team platform (GOAD demo add-on)
------------------------------------------------------------------
 The installer runs in a tmux session on first boot.
   watch it:   sudo tmux attach -t redamon     (Ctrl-b then d to detach)
   log:        tail -f /var/log/redamon-install.log

 When it finishes, open the control UI:
   http://<this-host-public-ip>:3000
 Create the admin account, then go to /settings and add an LLM API
 key (OpenAI / Anthropic / OpenRouter / Bedrock) to arm the agent.
%{ if home_llm_ip != "" ~}

 Self-hosted LLM over Tailscale is wired up (node ${home_llm_ip}):
%{ if tailscale_authkey == "" ~}
   join first:  sudo tailscale up          (then approve the URL)
%{ endif ~}
   in /settings use base URL  http://${home_llm_ip}:8000/v1
   keepalive:   systemctl status ts-keepalive
%{ endif ~}

 Demo targets: the GOAD AD boxes (same Azure VNet) and the Maison
 Miro store (its public Container App URL).
==================================================================
MOTD
