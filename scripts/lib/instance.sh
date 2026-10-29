# Sourced by the scripts: loads this deployment's instance config (never part of the repo).
#   ${MEDIAHUB_CONFIG_DIR:-~/.config/mediahub}/instance.env   hosts, ids, deploy/publish targets
#   ${MEDIAHUB_CONFIG_DIR:-~/.config/mediahub}/secrets.env    passphrase / tokens (chmod 600)
# Variables already set in the environment win over the files.
MEDIAHUB_CONFIG_DIR="${MEDIAHUB_CONFIG_DIR:-$HOME/.config/mediahub}"
export MEDIAHUB_CONFIG_DIR

instance_load() {
  for f in "$MEDIAHUB_CONFIG_DIR/instance.env" "$MEDIAHUB_CONFIG_DIR/secrets.env"; do
    [ -f "$f" ] || continue
    # Keep values the caller exported; take the rest from the file.
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in ''|'#'*) continue ;; esac
      key="${line%%=*}"
      case "$key" in *[!A-Za-z0-9_]*|'') continue ;; esac
      eval "cur=\${$key+set}"
      [ "$cur" = set ] && continue
      eval "$line" 2>/dev/null || { echo "instance: cannot parse $f: $key" >&2; return 1; }
      export "$key"
    done < "$f"
  done
  export APP_BUNDLE_ID APP_SERVER APP_EMBY_SERVER
}

# instance_require VAR... — exit with a hint when a setting is missing.
instance_require() {
  for v in "$@"; do
    eval "val=\${$v:-}"
    [ -n "$val" ] || { echo "missing $v — set it in $MEDIAHUB_CONFIG_DIR/instance.env (see instance.env.example)" >&2; exit 1; }
  done
}

# GitHub repo the instance builds on: GH_REPO, else origin.
instance_repo() {
  [ -n "${GH_REPO:-}" ] && { echo "$GH_REPO"; return; }
  git remote get-url origin | sed -E 's#.*github.com[:/]##; s#\.git$##'
}
