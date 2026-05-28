#!/bin/bash
# Run as root on a fresh Ubuntu 22.04 droplet after attaching a block volume.
# Usage: bash bootstrap-droplet.sh /dev/disk/by-id/YOUR-VOLUME-ID
set -euo pipefail

VOLUME_ID="${1:-}"
if [[ -z "$VOLUME_ID" ]]; then
  echo "Usage: $0 /dev/disk/by-id/YOUR-VOLUME-ID"
  echo "Run lsblk and ls /dev/disk/by-id/ to find the volume."
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt update && apt upgrade -y
apt install -y python3.11 python3.11-venv python3-pip nginx git

if ! id skipper &>/dev/null; then
  adduser --disabled-password --gecos "" skipper
  usermod -aG sudo skipper
fi

mkdir -p /var/skipper
if ! mountpoint -q /var/skipper; then
  if ! blkid "$VOLUME_ID" &>/dev/null; then
    mkfs.ext4 "$VOLUME_ID"
  fi
  mount "$VOLUME_ID" /var/skipper
  if ! grep -q "$VOLUME_ID" /etc/fstab; then
    echo "$VOLUME_ID /var/skipper ext4 defaults 0 2" >> /etc/fstab
  fi
fi

mkdir -p /var/skipper/Docs /var/skipper/Photos /var/skipper/Sketches
chown -R skipper:skipper /var/skipper

if [[ ! -d /home/skipper/app/.git ]]; then
  su - skipper -c "git clone https://github.com/skipperpools/SkipperGPT.git /home/skipper/app"
fi

su - skipper -c "cd /home/skipper/app/backend && python3.11 -m venv .venv && .venv/bin/pip install -r requirements.txt"

echo "Next steps (manual):"
echo "  1. Create /home/skipper/app/.env from deploy/production.env.example"
echo "  2. cp deploy/skipper.service /etc/systemd/system/skipper.service && systemctl enable --now skipper"
echo "  3. cp deploy/nginx-skipper.conf /etc/nginx/sites-available/skipper && ln -sf .../skipper /etc/nginx/sites-enabled/"
echo "  4. cp deploy/sudoers-skipper-deploy /etc/sudoers.d/skipper-deploy && chmod 440 ..."
echo "  5. certbot --nginx -d dashboard.skipperpools.net"
