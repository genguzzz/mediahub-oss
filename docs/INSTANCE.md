# Instance config, privacy, forks

Details behind the short rules in CLAUDE.md. Every deployment ("instance") keeps its values outside this public repo.

## Instance config and credentials

- Instance dir `${MEDIAHUB_CONFIG_DIR:-~/.config/mediahub}` (never inside the repo; back it up in a private repo or password manager):
  - `instance.env` — app values (`APP_BUNDLE_ID`, `APP_SERVER`, `APP_EMBY_SERVER`), CI repo and build-number base, `DEPLOY_HOST`, OTA token command, software-source publish target. Template: `instance.env.example`.
  - `secrets.env` (chmod 600) — `IPA_PASSPHRASE`, optional `MEDIAHUB_ADMIN_TOKEN` / `PUBLISH_TOKEN`. Template: `secrets.env.example`. Prefer the `*_CMD` settings that read tokens on the server so they never leave it.
  - `private-patterns.txt` — regexes for this instance's private words (hosts, names, IPs, paths); `(?i)` = ignore case, `!` = allow. The APP_* hosts are checked automatically.
  - `deploy/mediahub.service`, `deploy/nginx-media.conf` — optional overrides of the server templates (your listen/TLS/server_name, extra `EnvironmentFile`s).
  - `NOTES.md` — this instance's own operations notes (which host runs what, proxies, caches, where plugin sources live). Imported above for Claude; other agents should read it if it exists. Instance facts go there, never into this file.
- `./scripts/instance.sh init` creates the dir, generates the IPA passphrase and enables the leak-check pre-commit hook (`.githooks/pre-commit` → `scripts/lib/leak-scan.mjs --staged`); `check` shows what is set (secrets redacted); `ci` pushes the CI secrets/variable to your GitHub repo; `scan` checks the whole tree.
- All scripts load the instance with `scripts/lib/instance.sh` (`instance_load`, `instance_require`); environment variables override the files. New per-instance setting → add it to `instance.env.example` with a placeholder and a comment, read it via `instance_load`, never hard-code it.
- Code defaults are placeholders only (`com.example.mediahub`, `media.example.com`, `emby.example.com`). App values reach the code through `app/app.config.ts` (`APP_*` env → bundle id, OTA URL, `extra`) and `src/lib/instance.ts`; the server reads only its env (`server/.env.example`).
- Never print, echo or commit tokens or the passphrase; don't copy server-side tokens to the local machine when a `*_CMD` can read them remotely.

## Privacy (every agent, every fork)

This repo and every fork of it are public. Whoever's instance you are working on, treat these as hard rules:

- Instance values (hosts, domains, IPs, bundle ids, user names, machine names and paths, tokens, cookies, passphrases) never go into tracked files, commit messages, tag / Release notes, PR or issue text, workflow logs or unencrypted artifacts. They live in the instance dir, the fork's GitHub Secrets/Variables, and server-side `.env` files only.
- Don't "adapt" the repo to an instance by replacing placeholders. Need a different value → instance setting or `deploy/` override. Missing knob → add a generic setting with a placeholder default and document it in `instance.env.example` / `server/.env.example`.
- Commit identity is public: each clone sets a repo-local `user.name` / `user.email` that may be published (GitHub noreply), never an inherited work identity.
- Hooks: `.githooks/pre-commit` scans staged files and the author/committer identity, `.githooks/commit-msg` scans the message, `release.sh` scans the tag notes, all with the instance's `APP_*` values + `private-patterns.txt`. Never `--no-verify`; a false positive gets an `!allow` line in `private-patterns.txt`. Stage files one by one (no blind `git add -A`), and run `./scripts/instance.sh scan` before pushing.
- Never print secrets into the conversation or logs (say "set, N chars"). Prefer `*_CMD` settings that read server tokens on the server.
- When writing docs, examples or error messages, use placeholders (`example.com`, `<your-server>`), even if you know the real value.
- Writing GitHub Secrets is a sensitive action: if your own permission system blocks `./scripts/instance.sh ci`, ask the user to run it; don't route around the block.
- Errors: follow `docs/TROUBLESHOOTING.md`. Things only the user can do (gh login, enabling Actions on a fork, adding ssh keys, approving secret writes) → stop and tell them exactly what to do.

## Fork, customize, update from upstream

Full guide: `docs/UPSTREAM.md`. First deployment: `docs/DEPLOY_PROMPT.md` (a template — adapt it to the user's machines; the author's setup is only one example).

- Every deployment builds its own IPA from its **own fork** (bundle id and OTA URL are baked in at build time); upstream's Release IPA is the example build. Keep the fork public (free macOS runners). `./scripts/instance.sh init` adds an `upstream` remote with `tagOpt --no-tags` so upstream tags never mix with the fork's release tags.
- Changes useful to everyone: generic (setting instead of constant), sent upstream as a PR from a branch based on `upstream/main`. Instance-only differences: instance settings or deploy overrides, not edits to tracked files — that keeps merges conflict-free. Fork-only code changes are the last resort; avoid fork-only native changes (they fight upstream's `RUNTIME_VERSION` / version numbers).
- Before every commit: `cd app && npx tsc --noEmit && npx eslint src`, `cd server && npx tsc --noEmit -p .`.
- Update: `./scripts/update.sh --dry-run` (what came in, what to ship, new settings) → `./scripts/update.sh` (merge, scan, push) → ship what it lists. Versions follow upstream: after upstream bumps to X.Y.Z, `./scripts/release.sh X.Y.Z "…" --publish` only tags (no bump commit).
