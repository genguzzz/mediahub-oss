---
name: mediahub-ops
description: Operate a running 影库 (mediahub) deployment — ingest tasks and their steps, 115 / NAS buffer state, swapping a release, health check, storage and library stats, Emby push status, user feedback, app logs, subscriptions, selection policy, 里番 re-identification. Use when asked to check why something did not ingest, why a download is stuck, what the 概览 shows, to handle feedback or health findings, or to inspect the backend/plugin. Triggers: 入库, 任务, 下载不动, 换资源, 刮削, 健康检查, 需要处理, 存储, 115 空间, 反馈, 日志, 订阅, 选片, 里番识别, mediahub, 影库, ops. Not for building or shipping the app (CLAUDE.md, Ship it) or for instance setup (docs/INSTANCE.md).
---

# mediahub-ops

Everything goes through `<skill_dir>/scripts/ops.sh`, which runs each call on `$DEPLOY_HOST` over ssh and reads tokens there (`APP_TOKEN_CMD`, `ADMIN_TOKEN_CMD`, `MP_API_KEY_CMD`; set them in your instance's `instance.env`, see `instance.env.example`). Nothing secret is printed or copied to your machine. Responses are JSON.

## Commands

```
ops.sh tasks [N]                  ingest tasks (影视/AV/里番) with six steps, stage, 115/qB progress
ops.sh task <hash>                event log + download detail (115 state or NAS buffer files)
ops.sh candidates <hash>          other releases for the same work/season/episodes, scored
ops.sh reselect <hash> <magnet> [true]   swap release (cancel + blacklist old); true = NAS buffer
ops.sh retry <hash> [strm|buffer|offline]  retry a task step
ops.sh cancel <hash>              cancel a task and delete what it downloaded on 115
ops.sh health [run]               last health findings / scan now (read-only)
ops.sh fix <key> <id>             act on one finding (hentai_ids → identify, unconfirmed → re-check)
ops.sh confirm                    re-check every task waiting for Emby confirmation
ops.sh stats [refresh]            storage + library stats (refresh obeys the 10-min minimum)
ops.sh emby-events                Emby push listener status (connected, events, forwarded)
ops.sh feedback                   user feedback reports with Emby snapshots
ops.sh feedback-done <id> [note]  mark a report handled (shown in the app)
ops.sh logs | events [YYYY-MM-DD] uploaded app logs / usage events
ops.sh subs | sub <id>            MP subscriptions / one subscription's per-episode state
ops.sh blacklist                  releases the pipeline will not pick again
ops.sh policy [set '<json>']      selection policy (merge update)
ops.sh relib <series> <jp-name>   re-identify a 里番 series on Bangumi and move its library folder
ops.sh test                       plugin connectivity (Prowlarr/OpenList/115/qB/Emby)
ops.sh v1|admin|hub|mp <METHOD> <path> [json]   raw call (backend /v1, /admin, plugin, MoviePilot)
```

## How to investigate

1. **A title did not ingest / is slow** → `tasks`, then `task <hash>`. The failing step and its log line say where: 搜索选片 (what was picked and why), 115 离线 (0% → `stalled`; size 0 = 115 cannot fetch metadata), 生成 strm (`no-video` = no episode recognised), 刮削 (waiting for Emby; check `emby-events` is connected).
2. **Download stuck** → `candidates <hash>`; `reselect` a better-seeded one, or `retry <hash> buffer`.
3. **概览 shows 需要处理** → `health`, act with `fix` or on the task; never add a periodic job to "auto-fix" a finding (CLAUDE.md, Design rules).
4. **Feedback** → `feedback`; the Emby snapshot (path, provider ids, images, streams) usually shows the cause; fix, then `feedback-done <id> "what was done"`.
5. **Subscription not progressing** → `sub <id>`: per-episode state, Bangumi vs TMDb episode counts.

## Gotchas

- Emby push only reaches signed-in user sessions; the server listens with the app's Emby account. If `emby-events` shows `connected: false`, check `EMBY_*` in the server env.
- Scrape confirmation is push-driven; tasks finished before the listener existed need one `confirm`.
- Selection: 4K HEVC first, > 10 GB per hour penalised, hardsubs excluded. MP's rule group only orders by tags; the plugin filters MP's results with the same policy.
- Your instance's own hosts and paths are in `~/.config/mediahub/NOTES.md`, not here.
