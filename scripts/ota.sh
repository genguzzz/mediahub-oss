#!/bin/sh
# Publish a JS-only over-the-air update from this machine (~1 min):
#   ./scripts/ota.sh "修复：xxx"
# Phones running a binary with the same runtimeVersion download it on next launch (or
# foreground) and apply it after a restart. Native changes (new/upgraded native packages,
# app.config.ts plugins/permissions, Expo SDK) need RUNTIME_VERSION bumped and a new IPA via
# ./scripts/release.sh; this script refuses when it sees such changes since the last tag (FORCE=1 overrides).
set -e
cd "$(dirname "$0")/.."
# Instance config (instance.env.example): APP_* render app.config.ts exactly like the IPA build did,
# so the bundle points at the same server; the admin token comes from secrets.env or the server.
. scripts/lib/instance.sh
instance_load
instance_require APP_SERVER
MESSAGE="${1:-$(git log -1 --format=%s)}"

LAST_TAG=$(git describe --tags --abbrev=0 --match 'v*' 2>/dev/null || true)
if [ -n "$LAST_TAG" ] && [ "${FORCE:-0}" != "1" ]; then
  NATIVE_CHANGED=$(node -e '
    const { execSync } = require("child_process");
    const old = JSON.parse(execSync(`git show ${process.argv[1]}:app/package.json`));
    const cur = require("./app/package.json");
    const diff = Object.keys({ ...old.dependencies, ...cur.dependencies }).filter((k) => old.dependencies?.[k] !== cur.dependencies?.[k]);
    const cfg = execSync(`git diff ${process.argv[1]} -- app/app.config.ts`).toString();
    if (diff.length) console.log("dependencies: " + diff.join(", "));
    if (cfg.trim()) console.log("app.config.ts changed");
  ' "$LAST_TAG")
  if [ -n "$NATIVE_CHANGED" ]; then
    echo "Native-side changes since $LAST_TAG:" >&2
    echo "$NATIVE_CHANGED" | sed 's/^/  /' >&2
    echo "Ship these with ./scripts/release.sh (and bump RUNTIME_VERSION if native code changed). JS-only? rerun with FORCE=1." >&2
    exit 1
  fi
fi

cd app
RV=$(npx expo config --json --type public 2>/dev/null | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).runtimeVersion))')
COMMIT=$(git rev-parse --short HEAD)$( [ -z "$(git status --porcelain -- .)" ] || echo "-dirty")
echo "Exporting iOS bundle (runtime $RV, $COMMIT)…"
rm -rf dist-ota
npx expo export --platform ios --output-dir dist-ota >/dev/null
npx expo config --json --type public > dist-ota/expoConfig.json 2>/dev/null
TGZ=$(mktemp /tmp/mediahub-ota.XXXXXX.tgz)
tar czf "$TGZ" -C dist-ota .

TOKEN="${MEDIAHUB_ADMIN_TOKEN:-}"
if [ -z "$TOKEN" ]; then
  instance_require DEPLOY_HOST ADMIN_TOKEN_CMD
  TOKEN=$(ssh "$DEPLOY_HOST" "$ADMIN_TOKEN_CMD")
fi
curl -sS --fail-with-body -X POST "${APP_SERVER%/}/admin/updates" \
  -H "Authorization: Bearer $TOKEN" \
  -F "bundle=@$TGZ" -F "runtimeVersion=$RV" -F "commit=$COMMIT" -F "message=$MESSAGE"
echo
rm -f "$TGZ"
