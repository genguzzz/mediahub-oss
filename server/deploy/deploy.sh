#!/bin/sh
# Deploy the backend to a Linux host over ssh:  DEPLOY_HOST=user@host ./server/deploy/deploy.sh
# Needs on the host: Node 22+, nginx, systemd. First run generates /opt/mediahub/.env from .env.example
# (APP_TOKEN, ADMIN_TOKEN are generated; fill MP_API_KEY, EMBY_* and UPDATES_BASE afterwards).
# Edit deploy/nginx-media.conf (server_name, TLS) before the first run.
set -e
: "${DEPLOY_HOST:?set DEPLOY_HOST, e.g. root@your-server}"
cd "$(dirname "$0")/.."
scp -q .env.example "$DEPLOY_HOST:/tmp/mediahub.env.example"
ssh "$DEPLOY_HOST" 'mkdir -p /opt/mediahub/app /opt/mediahub/data /opt/mediahub/cache /opt/mediahub/updates
  [ -f /opt/mediahub/.env ] || { umask 077; cp /tmp/mediahub.env.example /opt/mediahub/.env
    sed -i "s/^APP_TOKEN=.*/APP_TOKEN=$(openssl rand -hex 24)/; s/^ADMIN_TOKEN=.*/ADMIN_TOKEN=$(openssl rand -hex 24)/" /opt/mediahub/.env; }'
scp -q deploy/mediahub.service "$DEPLOY_HOST:/etc/systemd/system/mediahub.service"
scp -q deploy/nginx-media.conf "$DEPLOY_HOST:/etc/nginx/conf.d/media.conf"
tar czf - package.json package-lock.json tsconfig.json src | ssh "$DEPLOY_HOST" 'cd /opt/mediahub/app && tar xzf - && npm ci --omit=dev --no-fund --no-audit >/dev/null \
  && systemctl daemon-reload && systemctl enable mediahub >/dev/null 2>&1; systemctl restart mediahub \
  && nginx -t 2>/dev/null && systemctl reload nginx && sleep 2 && curl -sf http://127.0.0.1:8793/health'
echo
