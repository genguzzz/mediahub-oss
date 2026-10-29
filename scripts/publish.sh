#!/bin/sh
# Get the IPA of a release build and put it where your phones install from.
#   ./scripts/publish.sh 0.2.0 [--force]       publish to your software source (mode below)
#   ./scripts/publish.sh 0.2.0 --out <dir>     only save the IPA (+ ipa.env) to <dir>, e.g. for Sideloadly/AltStore
# Waits for the v0.2.0 CI run on your repo, then takes the IPA from it:
#   - instance build (IPA_PASSPHRASE secret set): the encrypted artifact, decrypted with IPA_PASSPHRASE
#   - public build: the GitHub Release asset
# Publish modes (instance.env, see instance.env.example):
#   static  PUBLISH_DIR set: copy the IPA and icon into a web directory (over ssh when PUBLISH_SSH_HOST is
#           set) and update its appstore.json yourself — any nginx/caddy serving that directory is a source.
#   api     PUBLISH_URL set: POST the IPA (multipart) to a publisher service that regenerates the source.
# --force replaces a version the source already lists.
set -e
cd "$(dirname "$0")/.."
. scripts/lib/instance.sh
instance_load
VERSION="$1"
shift || true
FORCE=0
OUT=
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1 ;;
    --out) OUT="$2"; shift ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
  shift
done
echo "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "usage: $0 X.Y.Z [--force] [--out dir]" >&2; exit 1; }
MODE="${PUBLISH_MODE:-}"
if [ -z "$OUT" ] && [ -z "$MODE" ]; then
  if [ -n "${PUBLISH_DIR:-}" ]; then MODE=static
  elif [ -n "${PUBLISH_URL:-}" ]; then MODE=api
  else echo "no publish target: set PUBLISH_DIR (static) or PUBLISH_URL (api) in $MEDIAHUB_CONFIG_DIR/instance.env, or use --out <dir>" >&2; exit 1
  fi
fi
REPO=$(instance_repo)

echo "waiting for the v$VERSION build on $REPO…"
for i in $(seq 1 30); do
  RUN=$(gh run list -R "$REPO" --workflow ios.yml --branch "v$VERSION" --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || true)
  [ -n "$RUN" ] && break
  sleep 10
done
[ -n "$RUN" ] || { echo "no CI run for v$VERSION on $REPO" >&2; exit 1; }
gh run watch "$RUN" -R "$REPO" --exit-status --interval 30 >/dev/null || { echo "CI run $RUN failed: gh run view $RUN -R $REPO --log-failed" >&2; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
if gh run download "$RUN" -R "$REPO" --pattern 'ipa-encrypted-*' --dir "$TMP/enc" 2>/dev/null; then
  instance_require IPA_PASSPHRASE
  ENC=$(find "$TMP/enc" -name '*.tar.enc' | head -1)
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:IPA_PASSPHRASE -in "$ENC" | tar xf - -C "$TMP" \
    || { echo "cannot decrypt the artifact: IPA_PASSPHRASE differs from the repo secret (rerun ./scripts/instance.sh ci and rebuild)" >&2; exit 1; }
else
  gh release download "v$VERSION" -R "$REPO" --dir "$TMP" --pattern '*.ipa' --pattern 'ipa.env'
fi
. "$TMP/ipa.env"
IPA=$(ls "$TMP"/*.ipa)
SIZE=$(wc -c < "$IPA" | tr -d ' ')
echo "IPA: $(basename "$IPA") $(du -h "$IPA" | cut -f1), $BUNDLE_ID $VERSION ($BUILD), min iOS $MIN_IOS"

if [ -n "$OUT" ]; then
  mkdir -p "$OUT"
  cp "$IPA" "$TMP/ipa.env" "$OUT/"
  echo "saved to $OUT/$(basename "$IPA")"
  exit 0
fi
NOTES=$(git for-each-ref "refs/tags/v$VERSION" --format='%(contents:subject)%0a%0a%(contents:body)' | sed '/^-----BEGIN PGP/,$d' | head -c 1000)

case "$MODE" in
  static)
    instance_require PUBLISH_DIR SOURCE_BASE_URL
    BASE="${SOURCE_BASE_URL%/}"
    JSON_NAME="${SOURCE_JSON_NAME:-appstore.json}"
    SOURCE_JSON_URL="${SOURCE_JSON_URL:-$BASE/$JSON_NAME}"
    FILE="$BUNDLE_ID-$VERSION.ipa"
    on_host() { if [ -n "${PUBLISH_SSH_HOST:-}" ]; then ssh "$PUBLISH_SSH_HOST" "$1"; else sh -c "$1"; fi; }
    put() { if [ -n "${PUBLISH_SSH_HOST:-}" ]; then scp -q "$1" "$PUBLISH_SSH_HOST:$2"; else cp "$1" "$2"; fi; }
    on_host "mkdir -p '$PUBLISH_DIR/apps' '$PUBLISH_DIR/icons'; cat '$PUBLISH_DIR/$JSON_NAME' 2>/dev/null || true" > "$TMP/source.json"
    MEDIAHUB_NOTES="$NOTES" node scripts/lib/source-json.mjs "$BUNDLE_ID" "$VERSION" "$BUILD" "$APP_NAME" "$MIN_IOS" "$SIZE" \
      "$BASE/apps/$FILE" "$BASE/icons/$BUNDLE_ID.png" "$SOURCE_JSON_URL" "${SOURCE_NAME:-}" \
      $([ "$FORCE" = 1 ] && echo --force) < "$TMP/source.json" > "$TMP/source.new.json"
    put "$IPA" "$PUBLISH_DIR/apps/$FILE"
    put app/assets/icon.png "$PUBLISH_DIR/icons/$BUNDLE_ID.png"
    put "$TMP/source.new.json" "$PUBLISH_DIR/.$JSON_NAME.tmp"
    on_host "chmod 644 '$PUBLISH_DIR/apps/$FILE' '$PUBLISH_DIR/icons/$BUNDLE_ID.png' '$PUBLISH_DIR/.$JSON_NAME.tmp' && mv '$PUBLISH_DIR/.$JSON_NAME.tmp' '$PUBLISH_DIR/$JSON_NAME'"
    echo "uploaded $FILE and updated $JSON_NAME"
    ;;
  api)
    instance_require PUBLISH_URL
    if [ -n "${PUBLISH_SSH_HOST:-}" ]; then
      # Run the call on the publisher's host; its token is read there and never leaves it.
      instance_require PUBLISH_TOKEN_CMD
      scp -q "$IPA" "$PUBLISH_SSH_HOST:/tmp/mediahub-publish.ipa"
      scp -q app/assets/icon.png "$PUBLISH_SSH_HOST:/tmp/mediahub-publish-icon.png"
      printf '%s' "$NOTES" | ssh "$PUBLISH_SSH_HOST" "T=\$($PUBLISH_TOKEN_CMD); \
        curl -sS --fail-with-body -X POST '$PUBLISH_URL' -H \"Authorization: Bearer \$T\" \
        -F ipa=@/tmp/mediahub-publish.ipa -F icon=@/tmp/mediahub-publish-icon.png -F bundleId='$BUNDLE_ID' -F version='$VERSION' -F build='$BUILD' \
        -F name='$APP_NAME' -F minIos='$MIN_IOS' -F notes='<-' -F force=$FORCE; S=\$?; rm -f /tmp/mediahub-publish.ipa /tmp/mediahub-publish-icon.png; exit \$S"
    else
      instance_require PUBLISH_TOKEN
      printf '%s' "$NOTES" | curl -sS --fail-with-body -X POST "$PUBLISH_URL" -H "Authorization: Bearer $PUBLISH_TOKEN" \
        -F ipa=@"$IPA" -F icon=@app/assets/icon.png -F bundleId="$BUNDLE_ID" -F version="$VERSION" -F build="$BUILD" \
        -F name="$APP_NAME" -F minIos="$MIN_IOS" -F notes='<-' -F force=$FORCE
    fi
    echo
    ;;
  *) echo "unknown PUBLISH_MODE '$MODE' (static | api)" >&2; exit 1 ;;
esac

if [ -n "${SOURCE_JSON_URL:-}" ]; then
  GOT=$(curl -sS "$SOURCE_JSON_URL" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const a=(j.apps||[]).find(x=>x.bundleIdentifier===process.argv[1]||x.bundleId===process.argv[1]);console.log(a?a.version:"")})' "$BUNDLE_ID" 2>/dev/null || true)
  [ "$GOT" = "$VERSION" ] && echo "published $VERSION — source lists $GOT ($SOURCE_JSON_URL)" || echo "warning: source lists '${GOT:-?}', expected $VERSION (cached?)" >&2
else
  echo "published $VERSION"
fi
