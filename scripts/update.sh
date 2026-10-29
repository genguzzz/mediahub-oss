#!/bin/sh
# Bring your fork up to date with upstream and say what to ship:
#   ./scripts/update.sh            fetch upstream, show what changed, merge into the current branch, push
#   ./scripts/update.sh --dry-run  only show what would come in
# Upstream = the "upstream" remote (./scripts/instance.sh init adds it, without tags so upstream's vX.Y.Z
# never collides with your own release tags). Your instance config is outside the repo, so a fork that
# never edits tracked files merges without conflicts. Details: docs/UPSTREAM.md.
set -e
cd "$(dirname "$0")/.."
. scripts/lib/instance.sh
instance_load
git remote get-url upstream >/dev/null 2>&1 || { echo "no upstream remote — run ./scripts/instance.sh init" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "working tree not clean; commit or stash first" >&2; exit 1; }
BRANCH=$(git rev-parse --abbrev-ref HEAD)
git fetch -q --no-tags upstream main
BEHIND=$(git rev-list --count HEAD..upstream/main)
[ "$BEHIND" -gt 0 ] || { echo "already up to date with upstream/main"; exit 0; }

BASE=$(git merge-base HEAD upstream/main)
echo "upstream/main is $BEHIND commit(s) ahead of $BRANCH:"
git log --format='  %h %s' HEAD..upstream/main | head -30
CHANGED=$(git diff --name-only "$BASE" upstream/main)
has() { echo "$CHANGED" | grep -Eq "$1"; }
echo
echo "areas changed:"
has '^server/' && echo "  server/        → deploy the backend: ./server/deploy/deploy.sh --dry-run, then ./server/deploy/deploy.sh"
has '^server/deploy/' && echo "  server/deploy/ → templates changed; if you keep overrides in $MEDIAHUB_CONFIG_DIR/deploy/, merge the change into them"
has '^plugin/' && echo "  plugin/        → copy plugin/prowlarr115 (+ package.v3.json) to your MoviePilot plugin repo and reload it"
has '^app/' && echo "  app/           → OTA or new IPA, see below"
has '^\.github/workflows/' && echo "  workflows      → CI changed (check new secrets/variables in instance.env.example)"
has '^deploy/' && echo "  deploy/        → example configs changed (nginx/ge2o/compose); compare with your live ones"
has '^(instance|secrets)\.env\.example$' && echo "  config         → new instance settings, see the check below"
has '^docs/|^README|^CLAUDE|^AGENTS' && echo "  docs           → read the diff: git diff $BASE upstream/main -- docs README.md CLAUDE.md"

# New settings upstream added that your instance files don't have yet.
for pair in "instance.env.example:instance.env" "secrets.env.example:secrets.env"; do
  NEW=$(git show "upstream/main:${pair%%:*}" 2>/dev/null | sed -nE 's/^([A-Z][A-Z0-9_]*)=.*/\1/p' | while read -r k; do
    grep -Eq "^$k=" "$MEDIAHUB_CONFIG_DIR/${pair#*:}" 2>/dev/null || echo "$k"
  done | tr '\n' ' ')
  [ -n "$NEW" ] && echo "  new settings in ${pair%%:*} not in your ${pair#*:}: $NEW(defaults apply until you set them)"
done

MY_VER=$(node -p "require('./app/package.json').version")
UP_VER=$(git show upstream/main:app/package.json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).version))')
MY_RT=$(sed -nE 's/^(export )?const RUNTIME_VERSION = "([^"]+)".*/\2/p' app/app.config.ts)
UP_RT=$(git show upstream/main:app/app.config.ts | sed -nE 's/^(export )?const RUNTIME_VERSION = "([^"]+)".*/\2/p')
echo
if [ "$UP_RT" != "$MY_RT" ]; then
  echo "app: runtime $MY_RT → $UP_RT (native change). Phones need a new IPA: ./scripts/release.sh $UP_VER \"…\" --publish"
elif [ "$UP_VER" != "$MY_VER" ]; then
  echo "app: version $MY_VER → $UP_VER, same runtime $MY_RT. Either release it (./scripts/release.sh $UP_VER \"…\" --publish) or push the JS with ./scripts/ota.sh"
elif has '^app/'; then
  echo "app: JS changes on runtime $MY_RT → ./scripts/ota.sh \"…\" after the merge"
fi

[ "$1" = "--dry-run" ] && { echo; echo "(dry run: nothing merged)"; exit 0; }
echo
git merge --no-edit upstream/main || { echo "merge conflict — resolve it (keep instance values out of tracked files), commit, then rerun the ship steps above" >&2; exit 1; }
./scripts/instance.sh scan
git push origin "$BRANCH"
echo "merged upstream/main into $BRANCH and pushed. Now run the ship steps listed above."
