#!/bin/sh
# Cut a release: bump app/package.json, commit, tag vX.Y.Z (annotated, message = notes), push.
# The tag build (~17 min on a GitHub Mac) attaches the unsigned IPA to a GitHub Release;
# then scripts/publish.sh puts it into the 全能签 source. With --publish this script starts
# publish.sh in the background, which waits for the build.
#   ./scripts/release.sh 0.2.0 "新增：xxx；修复：yyy" [--publish] [--retag]
# --retag: the tag already exists but is not yours — a new fork inherits all of upstream's tags — so
# replace it (locally and on origin) with your own and build it on your fork.
set -e
cd "$(dirname "$0")/.."

VERSION="$1"
NOTES="${2:-影库 $1}"
PUBLISH=0
RETAG=0
for a in "$3" "$4"; do
  case "$a" in --publish) PUBLISH=1 ;; --retag) RETAG=1 ;; '') ;; *) echo "unknown option $a" >&2; exit 1 ;; esac
done
echo "$VERSION" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || { echo "usage: $0 X.Y.Z [notes] [--publish] [--retag]" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "working tree not clean; commit first" >&2; exit 1; }
if git rev-parse "v$VERSION" >/dev/null 2>&1; then
  if [ "$RETAG" = 1 ]; then
    git tag -d "v$VERSION" >/dev/null
    git push -q origin ":refs/tags/v$VERSION" 2>/dev/null || true
    echo "removed the existing tag v$VERSION"
  else
    echo "tag v$VERSION already exists. A fresh fork inherits upstream's tags: if this one isn't your own release, rerun with --retag" >&2
    exit 1
  fi
fi
# The tag message becomes the public Release notes: keep instance values out of it.
printf '%s\n' "$NOTES" | ./scripts/instance.sh scan --text - || exit 1
# The tagger identity is public as well.
git var GIT_COMMITTER_IDENT | sed -E 's/ [0-9]+ [+-][0-9]{4}$//' | ./scripts/instance.sh scan --text - \
  || { echo "tagger identity is private: git config user.name/user.email for this repo" >&2; exit 1; }

CURRENT=$(node -p "require('./app/package.json').version")
LOWER=$(printf '%s\n%s\n' "$CURRENT" "$VERSION" | sort -V | head -1)
if [ "$CURRENT" != "$VERSION" ] && [ "$LOWER" = "$VERSION" ]; then
  echo "version $VERSION is lower than current $CURRENT" >&2; exit 1
fi

if [ "$CURRENT" != "$VERSION" ]; then
  (cd app && npm version "$VERSION" --no-git-tag-version >/dev/null)
  git add app/package.json app/package-lock.json
  git commit -q -m "Release v$VERSION"
fi
git tag -a "v$VERSION" -m "$NOTES"
git push origin HEAD "v$VERSION"
echo "pushed v$VERSION — CI: https://github.com/$(git remote get-url origin | sed -E 's#.*github.com[:/]##; s#\.git$##')/actions"
if [ "$PUBLISH" = 1 ]; then
  nohup ./scripts/publish.sh "$VERSION" > "/tmp/mediahub-publish-$VERSION.log" 2>&1 &
  echo "publish.sh running in background: /tmp/mediahub-publish-$VERSION.log"
fi
