#!/bin/sh
# Deploy the backend to a Linux host over ssh:  ./server/deploy/deploy.sh [--dry-run]
# DEPLOY_HOST comes from your instance config (~/.config/mediahub/instance.env, see instance.env.example).
# Needs on the host: Node 22+, nginx, systemd. First run generates /opt/mediahub/.env from .env.example
# (APP_TOKEN, ADMIN_TOKEN are generated; fill MP_API_KEY, EMBY_* and UPDATES_BASE afterwards).
# The unit and nginx site are the repo templates unless ~/.config/mediahub/deploy/{mediahub.service,
# nginx-media.conf} exist — keep your server_name/TLS/listen there instead of editing tracked files.
# --dry-run only shows how the unit and nginx site differ from what the host has now.
set -e
cd "$(dirname "$0")/../.."
. scripts/lib/instance.sh
instance_load
instance_require DEPLOY_HOST
cd server
pick() { [ -f "$MEDIAHUB_CONFIG_DIR/deploy/$1" ] && echo "$MEDIAHUB_CONFIG_DIR/deploy/$1" || echo "deploy/$1"; }
UNIT=$(pick mediahub.service)
SITE=$(pick nginx-media.conf)
echo "unit: $UNIT"
echo "site: $SITE"
if [ "$1" = "--dry-run" ]; then
  for pair in "$UNIT:/etc/systemd/system/mediahub.service" "$SITE:/etc/nginx/conf.d/media.conf"; do
    ssh "$DEPLOY_HOST" "cat ${pair#*:} 2>/dev/null" | diff -u - "${pair%%:*}" --label "host ${pair#*:}" --label "${pair%%:*}" && echo "same: ${pair#*:}"
  done
  exit 0
fi
scp -q .env.example "$DEPLOY_HOST:/tmp/mediahub.env.example"
ssh "$DEPLOY_HOST" 'mkdir -p /opt/mediahub/app /opt/mediahub/data /opt/mediahub/cache /opt/mediahub/updates
  [ -f /opt/mediahub/.env ] || { umask 077; cp /tmp/mediahub.env.example /opt/mediahub/.env
    sed -i "s/^APP_TOKEN=.*/APP_TOKEN=$(openssl rand -hex 24)/; s/^ADMIN_TOKEN=.*/ADMIN_TOKEN=$(openssl rand -hex 24)/" /opt/mediahub/.env; }'
scp -q "$UNIT" "$DEPLOY_HOST:/etc/systemd/system/mediahub.service"
scp -q "$SITE" "$DEPLOY_HOST:/etc/nginx/conf.d/media.conf"
tar czf - package.json package-lock.json tsconfig.json src | ssh "$DEPLOY_HOST" 'cd /opt/mediahub/app && tar xzf - && npm ci --omit=dev --no-fund --no-audit >/dev/null \
  && systemctl daemon-reload && systemctl enable mediahub >/dev/null 2>&1; systemctl restart mediahub \
  && nginx -t 2>/dev/null && systemctl reload nginx && sleep 2 && curl -sf http://127.0.0.1:8793/health'
echo
