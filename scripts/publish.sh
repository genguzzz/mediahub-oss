#!/bin/sh
# Put a built IPA into your self-hosted 全能签-format software source.
#   ./scripts/publish.sh 0.2.0 [--force]      (--force replaces an already published version)
# Waits for the v0.2.0 CI run, then takes the IPA from it:
#   - instance build (IPA_PASSPHRASE secret set): the encrypted artifact, decrypted with IPA_PASSPHRASE
#   - public build: the GitHub Release asset
# and POSTs it (multipart) to your publisher (any service that accepts the fields below and regenerates
# the source JSON; see docs/DEPLOY_PROMPT.md, "software source"). Settings: instance.env.example.
set -e
cd "$(dirname "$0")/.."
. scripts/lib/instance.sh
instance_load
instance_require PUBLISH_URL
VERSION="$1"
FORCE=$([ "$2" = "--force" ] && echo 1 || echo 0)
echo "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "usage: $0 X.Y.Z [--force]" >&2; exit 1; }
REPO=$(instance_repo)

echo "waiting for the v$VERSION build…"
for i in $(seq 1 30); do
  RUN=$(gh run list -R "$REPO" --workflow ios.yml --branch "v$VERSION" --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || true)
  [ -n "$RUN" ] && break
  sleep 10
done
[ -n "$RUN" ] || { echo "no CI run for v$VERSION" >&2; exit 1; }
gh run watch "$RUN" -R "$REPO" --exit-status --interval 30 >/dev/null || { echo "CI run $RUN failed: gh run view $RUN -R $REPO --log-failed" >&2; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
if gh run download "$RUN" -R "$REPO" --pattern 'ipa-encrypted-*' --dir "$TMP/enc" 2>/dev/null; then
  instance_require IPA_PASSPHRASE
  ENC=$(find "$TMP/enc" -name '*.tar.enc' | head -1)
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:IPA_PASSPHRASE -in "$ENC" | tar xf - -C "$TMP"
else
  gh release download "v$VERSION" -R "$REPO" --dir "$TMP" --pattern '*.ipa' --pattern 'ipa.env'
fi
. "$TMP/ipa.env"
IPA=$(ls "$TMP"/*.ipa)
echo "IPA: $(basename "$IPA") $(du -h "$IPA" | cut -f1), $BUNDLE_ID $VERSION ($BUILD)"
NOTES=$(git for-each-ref "refs/tags/v$VERSION" --format='%(contents:subject)%0a%0a%(contents:body)' | sed '/^-----BEGIN PGP/,$d' | head -c 1000)

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
if [ -n "${SOURCE_JSON_URL:-}" ]; then
  GOT=$(curl -sS "$SOURCE_JSON_URL" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const a=(j.apps||[]).find(x=>x.bundleIdentifier===process.argv[1]||x.bundleId===process.argv[1]);console.log(a?a.version:"")})' "$BUNDLE_ID" 2>/dev/null || true)
  [ "$GOT" = "$VERSION" ] && echo "published $VERSION — source lists $GOT" || echo "warning: source lists '${GOT:-?}', expected $VERSION (cached?)" >&2
else
  echo "published $VERSION"
fi
