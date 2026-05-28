#!/bin/bash
# Run as root on the droplet after /home/skipper/app exists and .env is configured.
set -euo pipefail

APP_ROOT="/home/skipper/app"
REPO_DEPLOY="$APP_ROOT/deploy"

if [[ ! -f "$APP_ROOT/.env" ]]; then
  echo "Create $APP_ROOT/.env first (see deploy/production.env.example)."
  exit 1
fi

cp "$REPO_DEPLOY/skipper.service" /etc/systemd/system/skipper.service
cp "$REPO_DEPLOY/nginx-skipper.conf" /etc/nginx/sites-available/skipper
ln -sf /etc/nginx/sites-available/skipper /etc/nginx/sites-enabled/skipper
cp "$REPO_DEPLOY/sudoers-skipper-deploy" /etc/sudoers.d/skipper-deploy
chmod 440 /etc/sudoers.d/skipper-deploy

nginx -t
systemctl reload nginx
systemctl daemon-reload
systemctl enable skipper
systemctl restart skipper
systemctl status skipper --no-pager

echo "OK. Add HTTPS with: certbot --nginx -d dashboard.skipperpools.net"
