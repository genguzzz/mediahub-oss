#!/usr/bin/env bash
# Operate a mediahub deployment from your machine: backend /v1 + /admin, the Prowlarr115 plugin /hub/*, MoviePilot.
# Every call runs on $DEPLOY_HOST over ssh; tokens are read there by the *_CMD settings and never printed or copied.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ROOT="$(cd "$SCRIPT_DIR/../../../.." && pwd -P)"
# shellcheck source=/dev/null
. "$ROOT/scripts/lib/instance.sh"
instance_load
instance_require DEPLOY_HOST APP_TOKEN_CMD ADMIN_TOKEN_CMD MP_API_KEY_CMD
MP_URL="${MP_URL:-http://127.0.0.1:3000}"
SERVER_LOCAL_URL="${SERVER_LOCAL_URL:-http://127.0.0.1:8793}"
PLUGIN="${PLUGIN_ID:-Prowlarr115}"

# remote <auth: app|admin|mp> <METHOD> <url> [json-body]
remote() {
  local auth="$1" method="$2" url="$3" body="${4:-}" cmd hdr
  case "$auth" in
    app) cmd="$APP_TOKEN_CMD"; hdr="authorization: Bearer" ;;
    admin) cmd="$ADMIN_TOKEN_CMD"; hdr="authorization: Bearer" ;;
    mp) cmd="$MP_API_KEY_CMD"; hdr="X-API-KEY:" ;;
  esac
  # shellcheck disable=SC2029
  ssh "$DEPLOY_HOST" "T=\$($cmd); curl -sS --noproxy '*' -m 180 -X $method -H \"$hdr \$T\" -H 'content-type: application/json' \
    $( [ -n "$body" ] && printf -- "--data-binary %q" "$body" ) $(printf %q "$url") | python3 -m json.tool --no-ensure-ascii 2>/dev/null || true"
}
v1() { remote app "$1" "$SERVER_LOCAL_URL$2" "${3:-}"; }
adm() { remote admin "$1" "$SERVER_LOCAL_URL$2" "${3:-}"; }
hub() { remote mp "$1" "$MP_URL/api/v1/plugin/$PLUGIN$2" "${3:-}"; }
mp() { remote mp "$1" "$MP_URL/api/v1$2" "${3:-}"; }

usage() { sed -n '/^## Commands/,/^## /p' "$SCRIPT_DIR/../SKILL.md" | sed '$d'; exit "${1:-0}"; }
cmd="${1:-help}"; shift || true
case "$cmd" in
  v1) v1 "$@" ;;
  admin) adm "$@" ;;
  hub) hub "$@" ;;
  mp) mp "$@" ;;
  tasks) hub GET "/hub/pipeline?limit=${1:-30}&live=true" ;;
  task) hub GET "/hub/task/events?hash=$1"; hub GET "/hub/task/files?hash=$1" ;;
  candidates) hub GET "/hub/task/candidates?hash=$1" ;;
  reselect) hub POST /hub/task/reselect "{\"hash\":\"$1\",\"magnet\":\"$2\",\"buffer\":${3:-false}}" ;;
  retry) hub POST "/retry?hash=$1&mode=${2:-strm}" ;;
  cancel) hub POST /cancel "{\"hashes\":[\"$1\"]}" ;;
  health) if [ "${1:-}" = run ]; then v1 POST /v1/health/run '{}'; else v1 GET /v1/health; fi ;;
  fix) v1 POST /v1/health/fix "{\"key\":\"$1\",\"id\":\"$2\"}" ;;
  confirm) hub POST /hub/emby/confirm '{}' ;;
  stats) if [ "${1:-}" = refresh ]; then v1 GET '/v1/stats?refresh=1'; else v1 GET /v1/stats; fi ;;
  emby-events) adm GET /admin/emby/events ;;
  feedback) adm GET /admin/feedback ;;
  feedback-done) v1 POST "/v1/feedback/$1" "{\"status\":\"done\",\"note\":\"${2:-}\"}" ;;
  logs) adm GET /admin/logs ;;
  events) adm GET "/admin/events?day=${1:-$(date +%F)}" ;;
  subs) mp GET /subscribe/ ;;
  sub) v1 GET "/v1/subscriptions/$1" ;;
  blacklist) hub GET /hub/blacklist ;;
  policy) if [ "${1:-get}" = set ]; then hub POST /policy "{\"policy\":$2}"; else hub GET /policy; fi ;;
  relib) hub POST /hentai/relib "{\"series\":\"$1\",\"names\":[\"${2:-}\"]}" ;;
  test) hub GET /test ;;
  help|-h|--help) usage 0 ;;
  *) echo "unknown command: $cmd" >&2; usage 1 ;;
esac
