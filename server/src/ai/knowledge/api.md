# 影库服务端 API（app_api 用）

App 能做的事都对应这里的一个接口。用 app_api 调：method + path（/v1/…，查询参数直接写在 path 里）+ body。GET 随便读；写操作只在主人要求时做；删除 / 取消 / 移除要先说明影响、主人同意后带 confirmed=true。已有专门工具的（找片、找资源、入库、订阅、投屏、字幕、观看记录）优先用专门工具。

不开放：AI 设置和对话、Emby 账号密码、JavDB 登录、日志、更新、服务器配置——这些在 App 设置里由主人自己改。

## Emby 媒体库

- GET /v1/emby/views — 媒体库列表（名字、ItemId）
- GET /v1/emby/items?q=&parent=<库或文件夹 id>&sort=added|name|year&start=&limit= — 电影/剧集（不含分集）；q 按名字搜
- GET /v1/emby/latest?limit= — 最近入库
- GET /v1/emby/item/{id} — 条目信息；剧集带各季每一集（id、集号、是否刮削成功）
- GET /v1/emby/item/{id}/media — 全部文件信息：strm 路径（path）、strm 指向的 115 文件（sources[].target）、容器、大小、码率、时长、每条视频/音频/字幕轨（语言、编码、外挂文件）、各站 id（providers）
- POST /v1/emby/item/{id}/refresh {replace?} — 重新刮削（replace=true 覆盖全部元数据和图片）
- POST /v1/emby/scan — 扫描整个媒体库
- GET /v1/emby/activity — Emby 正在跑的任务（扫描、刮削进度）
- POST /v1/emby/item/{id}/delete {files, dryRun} — 删除条目：媒体库里的 strm 和目录、Emby 记录；files=true 连 115 上的视频一起删。先 dryRun=true 看计划，主人同意后 confirmed=true、dryRun=false

## 入库任务（流水线）

- GET /v1/pipeline?limit= — 任务列表：状态、进度、卡在哪一步、失败原因（hash 是任务 id）
- GET /v1/pipeline/{hash}/events — 一个任务的事件日志
- GET /v1/pipeline/{hash}/files — 下载内容：115 状态或 NAS 缓冲里的文件
- GET /v1/pipeline/{hash}/candidates — 同一作品/季/集的其他资源（打过分），换源用
- POST /v1/pipeline/{hash}/retry {mode: strm|buffer|offline} — strm=重新生成 strm 并刮削；buffer=改用 NAS 缓冲下载；offline=重新提交 115 离线
- POST /v1/pipeline/{hash}/reselect {magnet, title, buffer?} — 换一个资源（取消原任务、拉黑原资源、提交新的）
- POST /v1/pipeline/{hash}/retarget {tmdbid, type, season?, dryRun?} — 认错作品时改到正确的 TMDb 作品（先 dryRun）
- POST /v1/pipeline/{hash}/cancel — 取消任务（confirmed）
- POST /v1/pipeline/remove {hashes} — 从列表里移除已结束的任务记录（confirmed）
- POST /v1/pipeline/run — 立刻跑一轮流水线检查
- GET /v1/blacklist；POST /v1/blacklist/remove {hashes} — 被拉黑的资源（换源时自动拉黑）
- GET /v1/history?page= — MoviePilot 下载历史（每条：作品、季集、种子名、站点、时间、by = 谁触发的：订阅/用户名/插件；hash = 入库任务 id）。问『这部是怎么入库的』：subscriptions 的 by + 这里的记录 + GET /v1/pipeline/{hash}/events

## 115 和下载器

- GET /v1/offline — 115 离线任务列表（进度、状态、hash）
- POST /v1/offline/delete {hashes} — 删 115 离线任务（confirmed）
- GET /v1/drive/list?path= — 列 115 媒体目录（空 path=根）或媒体库里的目录（只读）
- GET /v1/openlist — OpenList 的复制/上传/离线任务
- GET /v1/qb?filter=all|downloading|seeding|completed|paused|active|stalled|errored — NAS 缓冲 qBittorrent 的种子
- POST /v1/qb/action {hashes, action: pause|resume|recheck|reannounce|delete, deleteFiles?} — delete 要 confirmed

## 统计、概览、健康

- GET /v1/overview — 概览页：任务、下载速度、Emby 活动、订阅
- GET /v1/stats（?refresh=1 立即重算）— 存储（115 空间、各库大小和数量）、入库统计
- GET /v1/stats/days — 最近 90 天每天的统计
- GET /v1/health；POST /v1/health/run — 健康检查（需要处理的问题，每项有 key 和 id）
- POST /v1/health/fix {key, id} — 按检查结果给的修复动作处理一项

## 订阅、索引器、其他

- GET /v1/subscriptions；GET /v1/subscriptions/{id}（每集状态）；POST /v1/subscriptions/{id}/search（立刻搜一次）；DELETE /v1/subscriptions/{id}（confirmed）
- GET /v1/sources；GET /v1/prowlarr/catalog；POST /v1/prowlarr {action: add|enable, …} — 索引器（也可用 manage_indexer）
- GET /v1/feedback；POST /v1/feedback/{id} {status: done, note} — 主人提交的反馈
- POST /v1/cache/clear — 让所有 App 清掉缓存重新加载
