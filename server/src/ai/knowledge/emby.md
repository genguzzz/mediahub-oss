# Emby 媒体库与播放

- App 直连 Emby 播放；strm → Emby → 302 到 115 CDN。播放卡顿多半是 115 CDN 或网络，不是 Emby。
- 刮削：Emby 按目录名里的 [tmdbid=N] / [bangumiid=N] 认作品；海报/信息不对可「刷新元数据」（refresh_library_item）。
- 「库里有没有」：search_media / lookup_titles 返回的 inLibrary 来自插件按 tmdbid 查库，比按名字搜准。
- 观看记录（watch_history）：只记这台 Emby 上的播放（App 内播放、其他 Emby 客户端）。在别的播放器/平台看的不会有。
- 继续观看 = resume（看了一部分）；played = 看完/标记已看。
- 用户：App 用主人的 Emby 账号登录；收藏、已看都是这个账号的。
- 删除条目（连同 115 原文件）只能主人在条目的「更多」菜单里做，会先预览要删什么。
