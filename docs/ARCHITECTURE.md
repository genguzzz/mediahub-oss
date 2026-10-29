# Architecture

How the pieces talk to each other, the ingest pipeline, and known traps.

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

## Ingest pipeline (plugin `pipeline.py`, `adult.py`)

One task per torrent hash for every kind (`meta.kind`: media / av / hentai). Six steps:

| Step | What happens | Driven by |
|---|---|---|
| 搜索选片 | `meta.pick`: who picked it (subscription / auto / manual / reselect / rss / catalog), policy score and reasons, candidate count | MP download event, batch, app |
| 提交 | magnet (trackers kept / added by `with_trackers`) → 115 offline into the canonical folder | `Pipeline.submit` |
| 115 离线 / NAS 缓冲 | 115 progress; 30 min at 0% → `stalled` + notification (app: 改用 NAS 缓冲 / 换一个资源); 6 h → NAS buffer; dead / too-big → blacklist | tracking loop (115 cannot notify) |
| 生成 strm | media: TMDb folder `名 (年) [tmdbid=N]/Season N`; 里番: `<Bangumi 名> [bangumiid=N]`; AV: `<code>.strm` in the MDC inbox | `Pipeline._finish_one` → `Adult.finish` |
| 刮削 | Emby is nudged (refresh the existing item, or announce the new folder); confirmation arrives through Emby push; AV waits for MDC's task result | Emby `LibraryChanged` → server → `/hub/emby/changed`; MDC polled while it has work |
| 完成 | `emby` timestamp; 3 h without confirmation → marked failed and listed in the health check | |

- **Failures roll back**: an unusable release is blacklisted and its episodes are removed from the MP subscription's `note`, so MP picks the next candidate (`_on_task_failed`).
- **Selection policy** (`policy.py`): 4K HEVC first, size per hour over `max_gb_per_hour` (10 GB, TMDb runtime) penalised, hardsubs excluded, any subtitle language. `policy.veto` filters MP search results and cancels vetoed picks in the download event, so MP and the app follow the same rules. MP's rule group only orders by tags (4K/H265/1080P).
- **Subscriptions**: every subscription maps to an identity (TMDb id, TMDb season, episode offset) — direct for TMDb-sourced ones, through the same Bangumi → TMDb mapping as ingest for the auto-subscribe helper's Bangumi ones (`/sub_identity`). The app shows 已订阅 by identity, the server refuses to create a second subscription with the same identity, and the plugin deletes a newly added duplicate on `SubscribeAdded`. The offset keeps different cours of one merged TMDb season apart. Ended subscriptions are remembered (`ended_subs`) so the helper cannot re-add them; TV subscriptions without a season are removed. All of this runs on subscription events, not on a timer.

## Push, stats, health

- **Emby push**: Emby sends `LibraryChanged` only to signed-in user sessions (an API-key socket gets nothing; Webhooks need Premiere). The server signs in with the app's Emby account (`server/src/embyEvents.ts`), debounces 3 s and forwards item ids to `/hub/emby/changed`. The plugin confirms waiting tasks for those folders and identifies new 里番 by their `[bangumiid=N]` at once. Status: `GET /admin/emby/events`.
- **Stats** (`/v1/stats`, 概览 存储/媒体库): Emby counts per library, 115 space, NAS download disk, task counts. Refreshed only when requested and the cache is older than 10 min; one snapshot per day.
- **Health** (`/v1/health`, 概览 需要处理): the only scheduled job, every 6 h, read-only — unconfirmed scrapes, stalled and failed tasks, MDC failures, 里番 whose Emby id differs from the folder, missing posters. Fixes are explicit (`/v1/health/fix`: identify / re-check).

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
