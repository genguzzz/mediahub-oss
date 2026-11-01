# 平台总览：影库的媒体架构

一句话：主人在 iPhone 的「影库」里找片、入库、看片；入库的原片放在 115 网盘，媒体库里只是指向 115 的 strm 小文件，Emby 刮削后直接播放。

## 组成
- **影库 App（iPhone）**：Emby 客户端（自带播放器，直连 Emby 播放）+ 找片/入库/任务界面 + 你（AI 助手）。
- **影库后端**：App 的统一接口（/v1）。把 MoviePilot、Prowlarr115 插件、Emby 拼成一套 API，还有发现榜单、图片、日志、AI。
- **MoviePilot（MP）**：媒体元数据（TMDb/豆瓣/Bangumi）、订阅、下载历史、选片规则。
- **Prowlarr115 插件（跑在 MP 里）**：一切 NAS 侧的事——资源搜索（Prowlarr 索引器 + 直连源）、入库流水线、115 离线、qBittorrent（NAS 缓冲）、OpenList、Emby 代理、统计、健康检查。
- **115 网盘**：原片存放处；用 115 离线下载（秒传很快）。下不动时改用 NAS 上的 qBittorrent 下载再传上去（「NAS 缓冲」）。
- **OpenList**：把 115 挂成可访问的路径，strm 里写的就是 OpenList 链接。
- **Emby**：媒体库服务器。播放 strm 时 302 跳到 115 CDN，所以不占 NAS 带宽。
- **元数据源**：TMDb（影视主 id，tmdbid）、豆瓣（口碑/榜单）、Bangumi（里番 id，bangumiid）。

## 数据流
找片（发现/搜索/AI） → 选资源（搜资源 or 自动选片 or 订阅自动下载） → 入库流水线（115 离线 → 生成 strm → Emby 刮削 → 完成） → 在 App 媒体库里播放。

## 媒体库
按类型分库（例如 电影 / 剧集 / 动漫 / 纪录片 / AV / 里番，具体名字用 platform_status 查）。目录名带 id：`名 (年) [tmdbid=N]/Season N`，里番 `名 [bangumiid=N]`。AV / 里番 只在「隐藏内容」开着时出现。

更多：ingest（入库流水线）、subscriptions（订阅）、emby（媒体库与播放）、selection（选片策略）、app（App 里各功能在哪）、troubleshooting（常见问题）。
