#!/bin/sh
# Deploy the backend to a Linux host over ssh:  ./server/deploy/deploy.sh [--dry-run]
# DEPLOY_HOST comes from your instance config (~/.config/mediahub/instance.env, see instance.env.example).
# Needs on the host: Node 22+, nginx, systemd. First run generates /opt/mediahub/.env from .env.example
# (APP_TOKEN, ADMIN_TOKEN are generated; fill MP_API_KEY, EMBY_* and UPDATES_BASE afterwards).
# The unit and nginx site are the repo templates unless ~/.config/mediahub/deploy/{mediahub.service,
# nginx-media.conf} exist — keep your server_name/TLS/listen there instead of editing tracked files.
# NGINX_SITE_PATH (instance.env) is where the site goes on the host (default /etc/nginx/conf.d/media.conf;
# "none" = leave nginx alone, e.g. when Caddy or another proxy fronts 127.0.0.1:8793).
# The ssh user must be able to write /opt/mediahub and /etc (root, or adapt via your overrides).
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
SITE_PATH="${NGINX_SITE_PATH:-/etc/nginx/conf.d/media.conf}"
echo
[ "$NEW_ENV" = yes ] && echo "first deploy: fill MP_API_KEY, EMBY_*, UPDATES_BASE in $DEPLOY_HOST:/opt/mediahub/.env, then: ssh $DEPLOY_HOST systemctl restart mediahub"
true "unit: $UNIT"
[ "$SITE_PATH" = none ] && echo "site: (nginx not managed)" || echo "site: $SITE → $SITE_PATH"
NODE_MAJOR=$(ssh "$DEPLOY_HOST" "node -p 'process.versions.node.split(\".\")[0]' 2>/dev/null" || true)
[ "${NODE_MAJOR:-0}" -ge 22 ] 2>/dev/null || { echo "$DEPLOY_HOST needs Node 22+ (found: ${NODE_MAJOR:-none})" >&2; exit 1; }
if [ "$1" = "--dry-run" ]; then
  PAIRS="$UNIT:/etc/systemd/system/mediahub.service"
  [ "$SITE_PATH" = none ] || PAIRS="$PAIRS $SITE:$SITE_PATH"
  for pair in $PAIRS; do
    ssh "$DEPLOY_HOST" "cat ${pair#*:} 2>/dev/null" | diff -u - "${pair%%:*}" --label "host ${pair#*:}" --label "${pair%%:*}" && echo "same: ${pair#*:}"
  done
  exit 0
fi
scp -q .env.example "$DEPLOY_HOST:/tmp/mediahub.env.example"
NEW_ENV=$(ssh "$DEPLOY_HOST" '[ -f /opt/mediahub/.env ] || echo yes')
ssh "$DEPLOY_HOST" 'mkdir -p /opt/mediahub/app /opt/mediahub/data /opt/mediahub/cache /opt/mediahub/updates
  [ -f /opt/mediahub/.env ] || { umask 077; cp /tmp/mediahub.env.example /opt/mediahub/.env
    sed -i "s/^APP_TOKEN=.*/APP_TOKEN=$(openssl rand -hex 24)/; s/^ADMIN_TOKEN=.*/ADMIN_TOKEN=$(openssl rand -hex 24)/" /opt/mediahub/.env; }'
scp -q "$UNIT" "$DEPLOY_HOST:/etc/systemd/system/mediahub.service"
[ "$SITE_PATH" = none ] || scp -q "$SITE" "$DEPLOY_HOST:$SITE_PATH"
RELOAD_NGINX=$([ "$SITE_PATH" = none ] && echo true || echo 'nginx -t 2>/dev/null && systemctl reload nginx')
tar czf - package.json package-lock.json tsconfig.json src | ssh "$DEPLOY_HOST" 'cd /opt/mediahub/app && tar xzf - && npm ci --omit=dev --no-fund --no-audit >/dev/null \
  && systemctl daemon-reload && systemctl enable mediahub >/dev/null 2>&1; systemctl restart mediahub \
  && '"$RELOAD_NGINX"' && sleep 2 && curl -sf http://127.0.0.1:8793/health'
echo
[ "$NEW_ENV" = yes ] && echo "first deploy: fill MP_API_KEY, EMBY_*, UPDATES_BASE in $DEPLOY_HOST:/opt/mediahub/.env, then: ssh $DEPLOY_HOST systemctl restart mediahub"
true
