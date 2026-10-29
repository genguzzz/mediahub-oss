# 影库 (mediahub) — working rules

iPhone client for a home media stack: an Emby client with its own player (direct to Emby, 115 CDN via go-emby2openlist 302), plus search resources by source, pick a release, ingest it, and watch every stage (115 offline / NAS qBittorrent buffer → strm → Emby scrape, AV → MDC), qBittorrent, 115 and OpenList. `app/` is Expo (SDK 58, Expo Router); `server/` is Node 22 + Fastify run with type stripping; `plugin/prowlarr115/` is the MoviePilot V3 plugin; `.github/workflows/ios.yml` builds an unsigned IPA that 全能签 signs on the phone.

This repo is public and shared by every deployment. **Nothing deployment-specific is ever committed**: no hosts, bundle ids, IPs, user names, paths of your machines, tokens. Each deployment ("instance") keeps those in its own config outside the repo (below), so everyone can `git pull` upstream without conflicts.

@~/.config/mediahub/NOTES.md

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

## Ship it

- Server change → `./server/deploy/deploy.sh` (`--dry-run` first shows how the unit/nginx site differ from the host), then curl the route. Deploy the server before the app when both change.
- JS-only app change → `./scripts/ota.sh "说明"` (~1 min). It renders `app.config.ts` with the instance's APP_* values, so the bundle points at the same server as the IPA.
- Native change (new/upgraded native package, config plugin, permission, SDK) → bump `RUNTIME_VERSION` in `app/app.config.ts`, then `./scripts/release.sh X.Y.Z "新增：…；修复：…" --publish`. The tag build (~15–25 min on a GitHub Mac; free for public repos) produces the IPA; `scripts/publish.sh X.Y.Z` (run in the background by `--publish`) puts it into the software source: `static` mode (`PUBLISH_DIR` + `SOURCE_BASE_URL`: copies IPA/icon into a web dir and updates `appstore.json` itself), `api` mode (`PUBLISH_URL`: hands it to an existing publisher service), or `--out <dir>` to just save the IPA.
- Instance builds (CI secrets set by `instance.sh ci`) upload only an encrypted artifact (`ipa-encrypted-<run>`, kept 7 days) because the binary contains your hosts; `publish.sh` downloads and decrypts it with `IPA_PASSPHRASE`. The Release gets notes only. Without the secrets CI makes the public example build and attaches it to the Release. A failed instance build uploads `xcodebuild.log.enc`: `openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:IPA_PASSPHRASE -in xcodebuild.log.enc`.
- CI runner label: `xcode-27` unless the repo variable `IOS_RUNNER` (instance.env) overrides it.
- `CFBundleVersion` = `BUILD_NUMBER_BASE` (repo variable, from instance.env) + run number, or the manual run's `build_number` input; it must stay above every build already in the source.
- Web preview for checking screens without a phone: `npx expo export --platform web`, serve it with an SPA fallback, set `localStorage["mediahub.settings"]` to `{"server":…, "token":…}`, screenshot with Playwright (tabs render on top on web; no player there).

## Architecture

```
iPhone 影库 ──HTTPS──▶ APP_SERVER  (nginx → mediahub :8793)
                         ├─ MoviePilot REST  127.0.0.1:3000  (TMDb search/detail, subscriptions, download history)
                         └─ Prowlarr115 plugin /plugin/Prowlarr115/hub/*  (everything NAS-side)
                               search (smart = MP search_by_id, or raw per source: Nyaa/AnimeTosho/Mikan/Prowlarr indexers/sukebei)
                               pipeline · 115 offline · qBittorrent · OpenList tasks · Emby JSON/image proxy · /submit · /av/add
```

- Emby is NOT behind the backend: the app logs in to Emby itself (`lib/emby.ts`, no SDK — Emby.SDK has no maintained JS package) with the account from `/v1/emby/account` (`EMBY_*` in the server env) and keeps only the token. Playback = `PlaybackInfo` → `/emby/Videos/{id}/stream?static=true…` → NAS nginx → go-emby2openlist → 302 to the 115 CDN. 115 links are UA-bound: every request of a playback sends `PLAYER_UA`. Admin actions (re-scrape, scan) still go through the backend (the app's Emby user need not be an admin).
- The backend holds only `MP_API_KEY` and its own `APP_TOKEN`/`ADMIN_TOKEN` (`/opt/mediahub/.env`, or extra `EnvironmentFile`s via your unit override). Emby/qB/OpenList/115 credentials stay in the plugin config; never copy them here.
- New NAS-side data → add a `/hub/*` route in `plugin/prowlarr115/hub.py`, then a `/v1/*` route in `server/`.
- Keep the backend on its own host name (`APP_SERVER`), separate from the 全能签 software source host; never put the API on the source host.

## Player (native, runtime 2+)

- `modules/mediahub-player`: Expo view around [AetherEngine](https://github.com/superuser404notfound/AetherEngine) (LGPL + App Store exception; FFmpeg demux, VideoToolbox HEVC/H.264/AV1, Dolby Vision/HDR10 and Atmos via AVPlayer, MKV, PGS/ASS). Chosen over KSPlayer (its free GPL build has no iOS device binary), MPVKit (self-described "for learning") and VLCKit (no DV/Atmos). JS draws all controls (`src/app/player.tsx`), so control changes ship by OTA; the view draws subtitles (text + bitmap cues) natively.
- Linking: the pod pulls AetherEngine with `spm_dependency` (Xcode merges its objects into the static pod); `plugins/with-aether-engine.js` links/embeds only the dynamic FFmpeg frameworks (+ static libdovi) in the app target. Linking the AetherEngine product in the app too = duplicate symbols. Bump AetherEngine in the podspec and the plugin's package versions together.
- AetherEngine needs Xcode 27 and iOS 18: CI runs on `xcode-27`, deployment target 18.0 (expo-build-properties). A local build needs Xcode 27 (macOS 26.6+); otherwise native changes are verified only by CI.
- Runtime 3 adds: PiP on both routes (native: a second `AVPlayerLayer` on `currentAVPlayer`; software: sample-buffer content source from `softwarePiPSource`), auto-PiP on swipe-home, `pipKeeper` keeps a view alive when its screen closes while PiP runs and `onPiPRestore` (module event) reopens `/player?at=`; background audio (`backgroundPlaybackEnabled`) and Now Playing/lock-screen commands (`ownsVideoNowPlayingSession` + remote commands); `addSubtitle`, `togglePiP`, `capabilities()`, brightness/volume (off-screen `MPVolumeView`), and the `MediahubAirPlay` view (separate module: one view per module).
- Runtime 4 startup tuning: the source carries `probeBytes` 8 MB / `analyzeMs` 5 s (AetherEngine defaults 50 MB / 60 s) and `progressive` (loopback segments served while written); the view emits `onStartup` checkpoints (`streamsProbed`, `ready`, `presenting` with ms since load, tracked as `play_startup`); the module's `prewarm(uri, headers)` is called by `warmPlayback()` from the Emby detail page on Wi-Fi (PlaybackInfo + first 8 MB; the player then takes the cached plan within 5 min). AetherEngine caches the 302-resolved CDN URL itself, so seeks don't go back through go-emby2openlist. `play_start` has `fromOpen` (screen open → first frame) besides `ms` (plan → frame).
- Playback speed tracking (runtime 4): `lib/playStats.ts` sends one `play_timeline` per play (ms since the player opened: item, info, subs, plan, native checkpoints `n_*`, engine open timings connect/openInput/findStreamInfo/demuxTotal, firstData, frame; context container/codec/route/resume/prewarm/net/cdn), plus `play_seek` and `play_stall`. The module forwards AetherEngine's diagnostic lines (`EngineLog.handler`, URLs cut to host) as `onEngineLog`; they also land in the uploaded log under `playstats`. Summary: `GET /admin/playstats?days=7[&version=]`.
- Runtime 5 adds DLNA casting (native SSDP discovery, `src/lib/dlna.ts`, `components/CastPanel.tsx`).
- Rotation is owned by the native stack only (`orientation: "portrait_up"` on the root stack, `"landscape"` on the player). Calling expo-screen-orientation as well made the player rotate twice.
- Header values must be ASCII (the Emby client name is "MediaHub"; "影库" in a header made fetch throw).

## Native capabilities (runtime 3+)

- The binary ships, ahead of features: linear-gradient, glass-effect, svg, keep-awake, network, sqlite, local-authentication, document-picker, sharing, quick-actions, localization, crypto, speech-recognition, plus the player module above. Features built on these ship by OTA.
- Feature code calls `src/lib/device.ts` (never `expo-*` directly): `has(capability)` first (OTA code can run on an older runtime), wrappers return `null` on cancel and log + track every call. Player-module features check `nativeCaps().module`.
- Adding any native module, permission string or Swift change still means: bump `RUNTIME_VERSION`, `release.sh`. Verify Swift in small steps: push the native change alone (CI ~9 min) before building UI on it.
- Settings → 能力自检 (`/diagnostics`) lists what the binary carries and exercises each capability on the device; results can be uploaded with the log.
- OTA check: the server logs every manifest request (`journalctl -u mediahub -o cat | grep "updates manifest"` shows `current` → `served`); the app shows 「新版本已就绪 · 立即重启」 when one has downloaded.

## App conventions

- Tabs (`src/app/(tabs)`): 媒体库 (Emby home) · 发现 (search + MP discover rows) · 入库 · 管理 (媒体库 delete + 下载器 panel `components/Downloads.tsx`) · 概览, system tab bar (`NativeTabs`). Everything else opens from the left drawer (`components/Drawer.tsx`: libraries, favourites, subscriptions, history, settings; menu button in `TabHeader` or swipe from the left edge) or is a stack route with `TopBar`; settings is a modal, the player a full-screen modal.
- Posters: always 2:3, landscape cards 16:9 (`components/media.tsx`). Lists use `Posters` = two-column waterfall or large-poster list (Settings → 海报排列, `LayoutToggle` in headers).
- Pull-to-refresh: use `<Pull onRefresh>` (spins only for the user's pull; polling must not show the spinner).
- Data: `useQuery(key, fn, {interval, staleMs})` from `lib/query.ts` — shared cache by key (persisted, so a cold start offline shows the last lists), refetches on focus when stale, polls only while focused and the app is active. `mutate`/`invalidate` after actions.
- Theme: three styles (影院 default / 海盐 / 绯红) × light/dark in `lib/theme.ts`; `colors` is a mutable palette swapped by `applyTheme`; read it during render, never at module scope.
- UI copy is Simplified Chinese, plain and precise (正在…/已…/未能…), no emoji or exclamation marks. Every tap gets haptics (`tap()`), results use `toast()` / `toastError()`, destructive actions go through `confirm()`.
- Images: always through the backend (`img()` for `/v1/img/tmdb/*`, `embyImg()` for Emby) — the phone never talks to TMDb directly.
- Adult content (AV/里番 libraries, sukebei sources, AV/里番 search modes) is hidden unless Settings → 成人内容 is on.
- AV/里番 index (发现 → AV 番号 / 里番): backend provider registry in `server/src/catalog/` — `CatalogProvider` (home rows, list by sort/tag/person, detail, persons) and `StreamProvider` (`find` → sources with a `ref`; `/v1/stream/:id/resolve` → `{uri, headers}`, which the player opens via `/player?stream=&ref=`). Adding a source = one provider file + one line in `catalog/index.ts`; the app reads `/v1/catalog` and needs no change.
  - Catalogs: `javdb` (rankings, ratings, actress index; pages and images through `INDEX_PROXY` when the server's country is refused), `jable` (hot lists, latest, actresses; pages through FlareSolverr `FLARESOLVERR_URL` with three persistent sessions `mediahub-1..3`: first page ~15 s, then 1–4 s), `emby-av` (the AV library), `hanime` (public DB, refreshed every 6 h, cached in `$CACHE_DIR/catalog/`). `server/src/catalog/http.ts` holds the fetchers and their cache; JavDB/Jable home rows are re-warmed every 25 min.
  - Online sources: `jable` (番号 → `/videos/<code>/` and `<code>-c`; HLS on an open CDN, AES-128, URL expires after a few hours — resolved right before playing). Separate route `/v1/catalog/:p/item/:id/streams` because it takes 2–20 s. Emby is not an online source: a work already in the library gets a 「去 Emby 播放」 button (`library` in the detail response; AV by 番号, 里番 by the Japanese OriginalTitle inside hanime's search_titles).
- The only content filter: titles explicitly describing minors (`REJECT` in `catalog/jable.ts`) and hanime's `school girl` tag.
- Notifications are local: `lib/notify.ts` diffs the pipeline on foreground loads and in an `expo-background-task` (iOS decides when, ≥15 min). Self-signed builds have no push.
- Logging: `logger("area")` for ids, counts, timings, phases, errors (never tokens or URLs with api_key). Settings → 上传日志 (also on the player error overlay and info panel) stores `$DATA_DIR/logs/<id>.log` + `.json`; list with `GET /admin/logs` (ADMIN_TOKEN); match request ids with `journalctl -u mediahub -o cat | grep <rid>`.
- Feedback (反馈问题): long-press sheet → `components/FeedbackForm.tsx` (kinds + reason + optional log upload) → `POST /v1/feedback`; the server stores `$DATA_DIR/feedback/<id>.json` with an Emby snapshot (path, provider ids, images, streams) taken at submit time. Work through them with `GET /admin/feedback` (counts by kind/library/status), set `status`/`note` with `POST /v1/feedback/:id`; the app shows them under Settings → 问题反馈记录.
- System stats (概览 存储/媒体库, `/stats`): plugin `/hub/stats` (Emby counts per library, 115 space, qB free disk, task counts); the server caches it and refreshes only on demand — a `/v1/stats` request with a cache older than 10 min triggers a background refresh (no timer; manual refresh obeys the same 10-min minimum). One snapshot per day in `$DATA_DIR/stats/days.jsonl`.
- Usage events (埋点): `track(name, props)` / `timed()` from `lib/track.ts`, batched to `/v1/events` every 30 s and on background, stored as `$DATA_DIR/events/YYYY-MM-DD.jsonl`; summary `GET /admin/events?day=…&name=…`. Playback emits `play_start`, `play_info`, `play_error`, `play_stop`, `play_end`.

## Traps

- An OTA only reaches phones on the same runtime. If a runtime bump's IPA never got built or published, phones stay on the old runtime and see no updates. Check what they run: `journalctl -u mediahub -o cat | grep "updates manifest"` (`runtimeVersion`). If the new JS degrades safely on the old binary, publish it for the old runtime too: set `RUNTIME_VERSION` back temporarily, `FORCE=1 scripts/ota.sh …`, then restore.
- OTA bundles embed the app config: running `ota.sh` without (or with a different) instance config would point phones at the placeholder server. `instance_require APP_SERVER` guards the obvious case; keep one instance config per deployment.
- Library delete (`lib/libraryDelete.ts` → `/v1/emby/item/:id/delete` → plugin `/hub/emby/delete`) always dry-runs first and shows the plan. It removes the library strm/folder (OpenList path = `lib_ol` + Emby path minus `/media/library`), the Emby record and, with `files`, the 115 video + same-stem subs behind each strm, then the 115 folder if no video is left. Only paths under `/115/Emby/<lib>/<work>` are touched.
- AV pipeline (plugin `adult.py` `av_run`): an MDC batch with one missing strm is rejected whole, and an exception before saving made the same 115 file reappear every minute. Now only strm present in the inbox are sent, missing ones become `missing`, and state is saved in `finally`. Rows carry `key`/`step` for `/v1/av/cancel`; ended media tasks can be removed with `/v1/pipeline/remove`.
- hanime's stream manifests need a signed session; hanime is index-only.
- MP answers are wrapped `{success, message, data}`; `mp()` unwraps, `mpRaw()` keeps `message` for writes the user should see.
- Smart search is MP's own `search_by_id` (same results as the MP web page, season-filtered) and takes 10–40 s; raw search skips MP's filters and season checks. Both are scored by the plugin's 选片策略 (`policy.py`) and flagged `recommended` by its `pick()`.
- The 动漫 library numbers seasons by TMDb (it used TheTVDB before; `/anime/tmdb_renumber` migrates old folders). TMDb merges cours into one long season, so a show subscribed from cour 2 shows "缺" for cour 1 in `mpctl audit`. Show Emby's numbers as the truth for "库里已有".
- `z.coerce.boolean()` turns "false" into true — parse query flags explicitly.
