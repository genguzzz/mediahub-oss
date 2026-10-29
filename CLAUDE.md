# 影库 (mediahub) — working rules

iPhone client for a home media stack: an Emby client with its own player, plus search → pick → ingest (115 offline / NAS buffer → strm → scrape) with every stage visible. `app/` Expo (SDK 58, Expo Router) · `server/` Node 22 + Fastify (type stripping) · `plugin/prowlarr115/` MoviePilot V3 plugin · `.github/workflows/ios.yml` builds an unsigned IPA.

@~/.config/mediahub/NOTES.md

## Design rules (read before changing anything)

- **Evaluate the design before implementing.** Ask whether the change fits how the systems already work; prefer the simplest mechanism that is correct, and remove what it replaces instead of keeping both.
- **Events and direct calls over polling.** If a system can tell us (Emby `LibraryChanged` via the server's user session, MP events) or be asked directly (refresh one Emby item, apply a known provider id, query a task by id), do that. Polling is only for systems that cannot notify (115 offline, MDC, RSS), at a cadence matching how fast they change.
- **No special-case or fallback layers.** No hidden retries, sweeps or "just in case" jobs that redo work silently. If something can fail, surface it (task state, notification, health check) and give the user an action.
- **Scheduled jobs are low-frequency, read-only scanners.** They report problems to 概览 → 健康检查 (`/v1/health`, every 6 h); they do not fix things on their own. Stats refresh only on demand (≥ 10 min apart).
- **One pipeline for every kind of media.** 影视, AV and 里番 share submit / 115 / stall handling / NAS buffer / reselect / blacklist / events; only the ingest and scrape steps differ.
- **Every fact in one place.** Rules here, details in `docs/`, operations in the `mediahub-ops` skill. Update the doc in the same change.

## Public repo, private instance

This repo and every fork are public. **Nothing deployment-specific is committed**: hosts, bundle ids, IPs, user names, machine paths, tokens live in `${MEDIAHUB_CONFIG_DIR:-~/.config/mediahub}` (`instance.env`, `secrets.env`, `private-patterns.txt`, `deploy/` overrides, `NOTES.md`) and the fork's GitHub Secrets. Use placeholders in code and docs. Hooks scan staged files, identity and messages — never `--no-verify`; stage files one by one; run `./scripts/instance.sh scan` before pushing. Never print secrets (say "set, N chars"). Details: [docs/INSTANCE.md](docs/INSTANCE.md).

## Ship it

- Before committing: `cd app && npx tsc --noEmit && npx eslint src`; `cd server && npx tsc --noEmit -p .`; `python3 -m py_compile plugin/prowlarr115/*.py`.
- Server → `./server/deploy/deploy.sh` (`--dry-run` first). JS-only app → `./scripts/ota.sh "说明"`. Native → bump `RUNTIME_VERSION`, `./scripts/release.sh X.Y.Z "…" --publish`. Deploy the server before the app when both change. Plugin → your MoviePilot local-plugin dir + reinstall (your instance's NOTES.md says how).
- JS-only commits on `main` carry `[skip ci]` (IPA builds only for native changes or releases).
- Operations (status, tasks, reselect, health, stats, feedback, logs, Emby push): the **`mediahub-ops` skill** in `.claude/skills/mediahub-ops/`.
- Errors: [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md). Fork upkeep: [docs/UPSTREAM.md](docs/UPSTREAM.md). First deployment: [docs/DEPLOY_PROMPT.md](docs/DEPLOY_PROMPT.md).

## Architecture in one screen

```
iPhone 影库 ──HTTPS──▶ server (/v1, /admin)
                         ├─ MoviePilot REST (TMDb, subscriptions, history)
                         ├─ plugin Prowlarr115 /hub/*  (search, pipeline, 115, qB, OpenList, Emby proxy, stats, health)
                         └─ Emby websocket as the app's user → LibraryChanged → plugin /hub/emby/changed
iPhone ──direct──▶ Emby (browse/play; playback 302 to the 115 CDN)
```

- New NAS-side data → a `/hub/*` route in `plugin/prowlarr115/hub.py`, then a `/v1/*` route in `server/`. Emby/qB/OpenList/115 credentials stay in the plugin config; the server holds only MP's key, its own tokens and the app's Emby account.
- Pipeline, selection policy, statuses, push and health design: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). App structure and UI rules: [docs/APP.md](docs/APP.md). Player and native modules: [docs/PLAYER.md](docs/PLAYER.md).

## UI rules (short)

Simplified Chinese, plain (正在…/已…/未能…), no emoji. Actions sit at the top of a screen and are never duplicated below; adding a button keeps the existing layout and order. Every tap gets haptics; results via `toast()`/`toastError()` (rendered above sheets); destructive actions via `confirm()`; sheets animate between modes. Long-press on anything browsable opens the 更多 sheet. Adult content only with Settings → 成人内容. Full list: [docs/APP.md](docs/APP.md).
