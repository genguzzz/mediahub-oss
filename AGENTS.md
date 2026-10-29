# Agents

Read [`CLAUDE.md`](CLAUDE.md) first — it is the single set of working rules for every agent (Claude Code, Cursor, Codex, …). `app/AGENTS.md` adds Expo-specific rules for the app.

Three rules matter before you touch anything:

1. **No deployment-specific values anywhere public.** This repo and its forks are public. Hosts, bundle ids, IPs, user names, machine paths and tokens belong to the instance config in `${MEDIAHUB_CONFIG_DIR:-~/.config/mediahub}` (`instance.env`, `secrets.env`, `deploy/` overrides) and the fork's GitHub Secrets — never in tracked files, commit messages, tag/Release notes, PRs or issues. The git hooks (`./scripts/instance.sh init`) block them; never `--no-verify`. If `~/.config/mediahub/NOTES.md` exists, read it: it describes this deployment's machines and operations. See CLAUDE.md, "Privacy".
2. **Ship with the scripts**, which load that config: `server/deploy/deploy.sh` (backend), `scripts/ota.sh` (JS-only), `scripts/release.sh … --publish` (native → CI IPA on your fork → software source), `scripts/update.sh` (merge upstream, tells you what to ship). `./scripts/instance.sh check` shows what is configured.
3. **On errors, follow [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md)**; stop and ask the user for things only they can do (gh login, enabling Actions, ssh keys, approving secret writes). First deployment: [`docs/DEPLOY_PROMPT.md`](docs/DEPLOY_PROMPT.md) (a template, adapt it); fork upkeep: [`docs/UPSTREAM.md`](docs/UPSTREAM.md).
