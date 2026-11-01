# 成人内容（AV / 里番）——只在隐藏内容开着时适用

- **AV**：索引 JavDB（排行、无码需登录）、Jable（在线播放）、我的 AV 库（emby-av）。入库：磁力 → 115 → strm 进 MDC 收件箱 → MDC 按番号刮削 → AV 库。番号形如 ABC-123，带 -C 表示中文字幕。
- **里番**：索引 hanime（只做目录，不能在线播）；目录按 Bangumi 作品建 `名 [bangumiid=N]`。认不出 Bangumi 的进「待识别」（needs-id），要主人指定作品。
- 同一部里番常有 GB/BIG5 两个字幕版本（按一集处理，简体优先）、前編/後編（第 1/2 集）、附带「前作」目录（不算本作）。
- catalog_list / catalog_item 读目录；入库仍走 ingest_resource / 任务流水线。
