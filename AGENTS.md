# Agents

Read [`CLAUDE.md`](CLAUDE.md) first — it is the single set of working rules for every agent (Claude Code, Cursor, Codex, …). `app/AGENTS.md` adds Expo-specific rules for the app.

Two rules matter before you touch anything:

1. **No deployment-specific values in tracked files.** Hosts, bundle ids, IPs, user names, machine paths and tokens belong to the instance config in `${MEDIAHUB_CONFIG_DIR:-~/.config/mediahub}` (`instance.env`, `secrets.env`, `deploy/` overrides). If `~/.config/mediahub/NOTES.md` exists, read it: it describes this deployment's machines and operations.
2. **Ship with the scripts**, which load that config: `server/deploy/deploy.sh` (backend), `scripts/ota.sh` (JS-only), `scripts/release.sh … --publish` (native → CI IPA → 全能签 source). `./scripts/instance.sh check` shows what is configured; the pre-commit hook (`./scripts/instance.sh init`) blocks private values.
