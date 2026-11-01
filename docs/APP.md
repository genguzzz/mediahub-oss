# App conventions

How the Expo app is organised and the UI rules every screen follows.

## App conventions

- Tabs (`src/app/(tabs)`): 媒体库 (Emby home) · 发现 (TMDb / 豆瓣 index tabs + search) · 入库 · 管理 (媒体库 delete + 下载器 panel `components/Downloads.tsx`) · 概览, system tab bar (`NativeTabs`). Everything else opens from the left drawer (`components/Drawer.tsx`: libraries, favourites, subscriptions, history, settings; menu button in `TabHeader` or swipe from the left edge) or is a stack route with `TopBar`; settings is a modal, the player a full-screen modal.
- Posters: always 2:3, landscape cards 16:9 (`components/media.tsx`). Lists use `Posters` = two-column waterfall or large-poster list (Settings → 海报排列, `LayoutToggle` in headers). Home rows (`CatalogHome`): portrait tiles 118 pt; sources with landscape covers (`posterAspect` > 1, e.g. Jable) get two tiles per screen width.
- Pull-to-refresh: use `<Pull onRefresh>` (spins only for the user's pull; polling must not show the spinner).
- Data: `useQuery(key, fn, {interval, staleMs})` from `lib/query.ts` — shared cache by key (persisted, so a cold start offline shows the last lists), refetches on focus when stale, polls only while focused and the app is active. `mutate`/`invalidate` after actions.
- Theme: three styles (影院 default / 海盐 / 绯红) × light/dark in `lib/theme.ts`; `colors` is a mutable palette swapped by `applyTheme`; read it during render, never at module scope.
- UI copy is Simplified Chinese, plain and precise (正在…/已…/未能…), no emoji or exclamation marks. Every tap gets haptics (`tap()`), results use `toast()` / `toastError()`, destructive actions go through `confirm()`.
- Images: the phone loads TMDb, Bangumi (400 px resize), 豆瓣 and JavDB images directly from the source (one hop, its own disk cache; `img()` adds the Referer 豆瓣 needs). The backend decides per host in `server/src/imageUrls.ts`; Jable (Cloudflare) and hanime (slow CDN, pre-warmed) still go through `/v1/img/ext`, Emby through `embyImg()`. JavDB's CDN refuses datacenter IPs but answers home and mobile networks. Failed or slow loads are logged (`lib/imageLog.ts`).
- Adult content (AV/里番 libraries, sukebei sources, AV/里番 search modes) is hidden unless Settings → 隐藏内容 is on. With 开启时验证 on, turning it on needs Face ID or the device passcode (`authenticate` in `lib/device.ts`); so does switching the lock itself on or off. Turning it off is always free.
- 发现: two index tabs. **TMDb** (trending, 本季新番, popular, 高分 rankings, 按类型浏览 genre / network shortcuts) and **豆瓣** (Top250, 华语/全球口碑剧集榜, 高分电影, hot lists). Sections come from `/v1/discover` (server `DISCOVER`: group, ranked, paging cap); ranked rows show the position (`CardData.rank`). Search returns TMDb works and people. Douban/Bangumi entries resolve to TMDb when opened.
- 发现 work page (`media/[type]/[id].tsx`) mirrors the Emby item page with TMDb data (`components/tmdbDetail.tsx`): cast and crew → `tmdb/person/[id]` (filmography timeline grouped by year, roles, 电影/剧集, 表演/幕后, 仅库中, decade jumps, or by rating; appearances as themself hidden unless asked), metadata chips (类型 / 播出 / 出品 / 关键词 → `discover/browse`, sortable 热门 / 高分 / 最新), collection and recommendations. Person, discover-by-network/company/keyword, keywords and collections come from the plugin's `/hub/tmdb/*` (MP's own TmdbApi; MP's REST lacks them).
- 无码: Jable's 无码最新/无码热门 lists are open. JavDB's 无码 section (lists, rankings, detail pages) needs an account: Settings → JavDB 账号 (shown with 隐藏内容) fetches the login form and its picture captcha through the backend, the owner types the captcha, the backend logs in with "remember me" and keeps only the session cookies (`server/src/catalog/javdbSession.ts`, `$DATA_DIR/javdb-session.json`). The captcha is always read by the owner, never solved automatically. A redirect to /login marks the session expired (shown in Settings; lists answer "JavDB 需要登录").
- 里番 has two indexes: hanime (public index JSON, direct; no playback — its player uses a signed session API) and Hanime1 (`server/src/catalog/hanime1.ts`: genre/keyword lists with sorts, detail with plot, tags (each opens its list), studio, episodes, and plain MP4 links played by the phone; also the online source for hanime works, matched by Japanese title + episode). Hanime1 needs an exit the site accepts (`SOURCE_PROXY` hanime1=…) and is offered only then.
- AV/里番 index (发现 → AV / 里番): backend provider registry in `server/src/catalog/` — `CatalogProvider` (home rows, list by sort/tag/person, detail, persons) and `StreamProvider` (`find` → sources with a `ref`; `/v1/stream/:id/resolve` → `{uri, headers}`, which the player opens via `/player?stream=&ref=`). Adding a source = one provider file + one line in `catalog/index.ts`; the app reads `/v1/catalog` and needs no change.
  - Outside sources go out per `SOURCE_PROXY` (`server/src/egress.ts`: direct / HTTP / SOCKS5 per source; JavDB defaults to `INDEX_PROXY`); `/admin/egress` shows the current routes.
  - Catalogs: `javdb` (rankings, ratings, actress index; pages and images through its configured exit when the server's country is refused), `jable` (hot lists, latest, actresses; pages through FlareSolverr `FLARESOLVERR_URL` with three persistent sessions `mediahub-1..3`: first page ~15 s, then 1–4 s), `emby-av` (the AV library), `hanime` (public DB, refreshed every 6 h, cached in `$CACHE_DIR/catalog/`). `server/src/catalog/http.ts` holds the fetchers and their cache; JavDB/Jable home rows are re-warmed every 25 min.
  - Online sources: `jable` (番号 → `/videos/<code>/` and `<code>-c`; HLS on an open CDN, AES-128, URL expires after a few hours — resolved right before playing). Separate route `/v1/catalog/:p/item/:id/streams` because it takes 2–20 s. Emby is not an online source: a work already in the library gets a 「去 Emby 播放」 button (`library` in the detail response; AV by 番号, 里番 by the Japanese OriginalTitle inside hanime's search_titles).
- The only content filter: titles explicitly describing minors (`REJECT` in `catalog/jable.ts`) and hanime's `school girl` tag.
- Notifications are local: `lib/notify.ts` diffs the pipeline on foreground loads and in an `expo-background-task` (iOS decides when, ≥15 min). Self-signed builds have no push.
- Logging: `logger("area")` for ids, counts, timings, phases, errors (never tokens or URLs with api_key). Settings → 上传日志 (also on the player error overlay and info panel) stores `$DATA_DIR/logs/<id>.log` + `.json`; list with `GET /admin/logs` (ADMIN_TOKEN); match request ids with `journalctl -u mediahub -o cat | grep <rid>`.
- Feedback (反馈问题): long-press sheet → `components/FeedbackForm.tsx` (kinds + reason + optional log upload) → `POST /v1/feedback`; the server stores `$DATA_DIR/feedback/<id>.json` with an Emby snapshot (path, provider ids, images, streams) taken at submit time. Work through them with `GET /admin/feedback` (counts by kind/library/status), set `status`/`note` with `POST /v1/feedback/:id`; the app shows them under Settings → 问题反馈记录.
- System stats (概览 存储/媒体库, `/stats`): plugin `/hub/stats` (Emby counts per library, 115 space, qB free disk, task counts); the server caches it and refreshes only on demand — a `/v1/stats` request with a cache older than 10 min triggers a background refresh (no timer; manual refresh obeys the same 10-min minimum). One snapshot per day in `$DATA_DIR/stats/days.jsonl`.
- Usage events (埋点): `track(name, props)` / `timed()` from `lib/track.ts`, batched to `/v1/events` every 30 s and on background, stored as `$DATA_DIR/events/YYYY-MM-DD.jsonl`; summary `GET /admin/events?day=…&name=…`. Playback emits `play_start`, `play_info`, `play_error`, `play_stop`, `play_end`.
- Detail pages (Emby item, 发现 TMDb work) share the immersive top from `components/DetailHero.tsx`: full-bleed backdrop fading into the page, poster + title over its lower edge, floating back button.
- Screen actions sit at the top and are never repeated at the bottom; adding a button keeps the existing order (the established primary button stays first) and the row must not wrap — use `small` buttons with equal `flex` when three share a row.
- The drawer footer shows the running version and a small 检查更新 (same check as Settings).
- 概览 shows 需要处理 from the 6-hourly read-only health check (`/health` screen lists findings with explicit actions).

## Remote config

The server can override app settings without a release (`server/src/appConfig.ts`, app `lib/remoteConfig.ts`). One schema declares each key, its type and default; overrides are stored on the server (`DATA_DIR/app-config.json`), validated, and versioned. Every `/v1` answer carries `x-config-version`; the app refetches `GET /v1/config` when it changes and keeps the last config on disk. Edit with `PUT /admin/config {set: {key: value}, unset: [key]}` or `ops.sh config`.

| Key | Default | Used by |
|---|---|---|
| `cacheMaxAgeSec` | `null` | `lib/query.ts`: cap on list freshness (sent as `x-cache-max-age`) |
| `defaultSources` | nyaa, animetosho, mikan, dmhy, prowlarr | 按来源搜索 / 索引源 when the owner hasn't saved their own |
| `aiOrb` | `true` | the assistant's floating orb |
| `hiddenDiscoverSections` | `[]` | 发现 sections (ids from `/v1/discover`) not shown |

Adding a key: declare it in `SCHEMA` and in `DEFAULTS` of `lib/remoteConfig.ts`, read it with `useConfig()`, add a row here.


## Online subtitles (player)

The player's subtitle sheet has 在线字幕: the backend searches every source for the item (`GET /v1/subs/search?embyId=`: 迅雷, 射手网, sub_share — see docs/AI.md), best match first; a 射手网 pack opens into its files (`/v1/subs/files`). A pick loads through `/v1/subs/file?path=<source>` (served as UTF-8, GBK files converted) and can be kept with 存到媒体库 (`POST /v1/emby/item/:id/subtitles/install`, written beside the strm, timing aligned to the audio).
