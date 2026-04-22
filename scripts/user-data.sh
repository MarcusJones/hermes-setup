#!/bin/bash
# Cloud-init script for Hermes Agent on Ubuntu 24.04 ARM64.
# Runs once as root on first boot. Logs to /var/log/user-data.log.
#
# After this completes, SSH in as the `hermes` user and run `hermes setup`.

set -euxo pipefail
exec > >(tee /var/log/user-data.log) 2>&1

# ---- Base system ----
apt-get update
apt-get -y install curl git build-essential ca-certificates ufw unattended-upgrades

# ---- 4 GB swap (safety net for parallel CC subagents on 4 GB RAM) ----
if ! swapon --show | grep -q .; then
  fallocate -l 4G /swapfile && chmod 600 /swapfile
  mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

# ---- Firewall: SSH only ----
ufw --force enable
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp

# ---- Node.js 20 + Claude Code (for Hermes subagent orchestration) ----
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get -y install nodejs
npm install -g @anthropic-ai/claude-code

# ---- Dedicated hermes user ----
if ! id hermes >/dev/null 2>&1; then
  useradd -m -s /bin/bash -G sudo hermes
  echo 'hermes ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-hermes
  mkdir -p /home/hermes/.ssh
  cp /home/ubuntu/.ssh/authorized_keys /home/hermes/.ssh/authorized_keys
  chown -R hermes:hermes /home/hermes/.ssh
  chmod 700 /home/hermes/.ssh
  chmod 600 /home/hermes/.ssh/authorized_keys
fi

# Keeps hermes's systemd user services alive after SSH logout.
loginctl enable-linger hermes

# ---- Install Hermes Agent (non-interactive core install) ----
sudo -iu hermes bash -lc '
  curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
'

echo "Cloud-init done. SSH in as hermes and run: hermes setup"
