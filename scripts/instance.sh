#!/bin/sh
# Manage this deployment's instance config (lives in ~/.config/mediahub, never in the repo).
#   ./scripts/instance.sh init    create instance.env / secrets.env from the templates, generate the
#                                 IPA passphrase, enable the leak-check git hook
#   ./scripts/instance.sh check   show what is set (secrets redacted) and what is missing
#   ./scripts/instance.sh ci      push APP_*, MASK_TERMS, IPA_PASSPHRASE (secrets) and BUILD_NUMBER_BASE
#                                 (variable) to the GitHub repo that builds your IPA
#   ./scripts/instance.sh scan    look for private values in tracked files (also run by the pre-commit hook)
set -e
cd "$(dirname "$0")/.."
. scripts/lib/instance.sh

case "${1:-check}" in
  init)
    mkdir -p "$MEDIAHUB_CONFIG_DIR/deploy"
    chmod 700 "$MEDIAHUB_CONFIG_DIR"
    [ -f "$MEDIAHUB_CONFIG_DIR/instance.env" ] || { cp instance.env.example "$MEDIAHUB_CONFIG_DIR/instance.env"; echo "created $MEDIAHUB_CONFIG_DIR/instance.env — edit it"; }
    if [ ! -f "$MEDIAHUB_CONFIG_DIR/secrets.env" ]; then
      (umask 077; sed "s/^IPA_PASSPHRASE=.*/IPA_PASSPHRASE=$(openssl rand -hex 32)/" secrets.env.example > "$MEDIAHUB_CONFIG_DIR/secrets.env")
      echo "created $MEDIAHUB_CONFIG_DIR/secrets.env (IPA passphrase generated)"
    fi
    [ -f "$MEDIAHUB_CONFIG_DIR/private-patterns.txt" ] || printf '%s\n' "# One regex per line; '(?i)' = ignore case, '!' = allow. Checked before every commit." \
      "# Your hosts and bundle id from instance.env are checked automatically; add names, IPs, paths." > "$MEDIAHUB_CONFIG_DIR/private-patterns.txt"
    git config core.hooksPath .githooks
    echo "git hook enabled (.githooks/pre-commit runs the leak scan)"
    ;;
  check)
    instance_load
    echo "config dir: $MEDIAHUB_CONFIG_DIR"
    for v in APP_BUNDLE_ID APP_SERVER APP_EMBY_SERVER GH_REPO BUILD_NUMBER_BASE MASK_TERMS DEPLOY_HOST SOURCE_JSON_URL PUBLISH_URL PUBLISH_SSH_HOST; do
      eval "val=\${$v:-}"; printf '  %-18s %s\n' "$v" "${val:-—}"
    done
    for v in ADMIN_TOKEN_CMD PUBLISH_TOKEN_CMD IPA_PASSPHRASE MEDIAHUB_ADMIN_TOKEN PUBLISH_TOKEN; do
      eval "val=\${$v:-}"; printf '  %-18s %s\n' "$v" "$([ -n "$val" ] && echo set || echo —)"
    done
    for f in mediahub.service nginx-media.conf; do
      [ -f "$MEDIAHUB_CONFIG_DIR/deploy/$f" ] && echo "  deploy override: $f"
    done
    case "$APP_BUNDLE_ID" in ''|com.example.*) echo "warning: APP_BUNDLE_ID is still the placeholder" >&2 ;; esac
    [ "$(git config core.hooksPath)" = .githooks ] || echo "warning: leak-check hook off — run: ./scripts/instance.sh init" >&2
    ;;
  ci)
    instance_load
    instance_require APP_BUNDLE_ID APP_SERVER APP_EMBY_SERVER IPA_PASSPHRASE
    REPO=$(instance_repo)
    for v in APP_BUNDLE_ID APP_SERVER APP_EMBY_SERVER IPA_PASSPHRASE MASK_TERMS; do
      eval "val=\${$v:-}"
      [ -n "$val" ] || continue
      printf '%s' "$val" | gh secret set "$v" -R "$REPO" >/dev/null
      echo "secret $v → $REPO"
    done
    gh variable set BUILD_NUMBER_BASE -R "$REPO" --body "${BUILD_NUMBER_BASE:-0}" >/dev/null
    echo "variable BUILD_NUMBER_BASE=${BUILD_NUMBER_BASE:-0} → $REPO"
    ;;
  scan)
    instance_load
    shift
    node scripts/lib/leak-scan.mjs "$@"
    ;;
  *) sed -n '2,9p' "$0" >&2; exit 1 ;;
esac
