#!/bin/sh
# Put a released IPA into your self-hosted 全能签-format software source.
# Waits for the tag's CI run, downloads the IPA from the GitHub Release and POSTs it (multipart) to your
# source publisher. The publisher is not part of this repo: it is any service that accepts the fields
# below and regenerates the source JSON (see docs/DEPLOY_PROMPT.md, "software source").
#   SOURCE_PUBLISH_URL=https://apps.example.com/admin/publish SOURCE_PUBLISH_TOKEN=... ./scripts/publish.sh 0.2.0 [--force]
set -e
cd "$(dirname "$0")/.."
: "${SOURCE_PUBLISH_URL:?set SOURCE_PUBLISH_URL}"
: "${SOURCE_PUBLISH_TOKEN:?set SOURCE_PUBLISH_TOKEN}"
VERSION="$1"
FORCE=$([ "$2" = "--force" ] && echo 1 || echo 0)
echo "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "usage: $0 X.Y.Z [--force]" >&2; exit 1; }

echo "waiting for the v$VERSION build…"
for i in $(seq 1 30); do
  RUN=$(gh run list --workflow ios.yml --branch "v$VERSION" --limit 1 --json databaseId -q '.[0].databaseId' 2>/dev/null || true)
  [ -n "$RUN" ] && break
  sleep 10
done
[ -n "$RUN" ] || { echo "no CI run for v$VERSION" >&2; exit 1; }
gh run watch "$RUN" --exit-status --interval 30 >/dev/null || { echo "CI run $RUN failed: gh run view $RUN --log-failed" >&2; exit 1; }

TMP=$(mktemp -d)
gh release download "v$VERSION" --dir "$TMP" --pattern '*.ipa' --pattern 'ipa.env'
. "$TMP/ipa.env"
IPA=$(ls "$TMP"/*.ipa)
NOTES=$(git for-each-ref "refs/tags/v$VERSION" --format='%(contents:subject)%0a%0a%(contents:body)' | sed '/^-----BEGIN PGP/,$d' | head -c 1000)
curl -sS --fail-with-body -X POST "$SOURCE_PUBLISH_URL" -H "Authorization: Bearer $SOURCE_PUBLISH_TOKEN" \
  -F ipa=@"$IPA" -F icon=@app/assets/icon.png -F bundleId="$BUNDLE_ID" -F version="$VERSION" -F build="$BUILD" \
  -F name="$APP_NAME" -F minIos="$MIN_IOS" -F notes="$NOTES" -F force=$FORCE
echo
rm -rf "$TMP"
echo "published $VERSION"
