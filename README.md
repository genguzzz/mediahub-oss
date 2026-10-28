# 影库 (mediahub)

自用的 115 + Emby 家庭影音方案：订阅一部片，自动搜索、离线到 115、生成 strm、Emby 刮削，iPhone 自制 App 里能看到每一步进度，点开就能播。

```
iPhone App (Expo) ──HTTPS──► 后端 (Fastify)
                               ├─ MoviePilot V3 + 插件 Prowlarr115 ── Prowlarr 搜索 ── 115 离线 ── strm
                               ├─ Emby（媒体库、刮削）
                               └─ 发现页数据源（TMDb / JavDB / Jable / hanime）

播放：App → nginx :8920 ─ 播放请求 → go-emby2openlist → OpenList → 115 直链 (302)
                       └ 其他请求 → Emby
```

原片全部在 115，本地只放 strm 与元数据；播放时 302 到 115 CDN，流量不经过本地机器。

## 目录

| 路径 | 内容 |
|---|---|
| `app/` | Expo SDK 58 / Expo Router iOS 客户端，原生播放器模块基于 AetherEngine，JS 层改动走 OTA |
| `server/` | Fastify 后端（Node 22，直接运行 `.ts`），聚合 MoviePilot / Emby / 在线源，托管 OTA 更新 |
| `plugin/prowlarr115/` | MoviePilot V3 插件：多关键词搜索、选片打分、115 离线、strm 生成、字幕、Emby 刮削确认、AV/里番入库 |
| `deploy/` | 示例配置：nginx 分流、go-emby2openlist 配置模板、MoviePilot compose |
| `scripts/` | `release.sh`（打 tag 触发编译）、`publish.sh`（把 IPA 交给软件源）、`ota.sh`（推送 JS 更新） |
| `.github/workflows/ios.yml` | GitHub Actions 编译未签名 IPA |

## 部署

部署高度依赖各人的网络、机器和已有服务，所以这里不提供一键脚本，而是提供一份**部署提示词**：[`docs/DEPLOY_PROMPT.md`](docs/DEPLOY_PROMPT.md)。

用法：在本仓库根目录启动 Claude Code（或其他能在你的服务器上执行命令的 AI 代理），把提示词整段贴给它。它会先探测你的环境，给出方案并等你确认，再按需安装 OpenList、Emby、go-emby2openlist、nginx、Prowlarr、MoviePilot（及可选的 FlareSolverr、MDC、qBittorrent），安装插件，部署后端，并指导 App 的编译与分发。

## 注意

- 仓库已移除作者的域名、地址和凭据；所有占位值（`example.com`、`com.example.mediahub`、`openlist`、`emby` 等）需要换成你自己的。密钥只放 `.env` 与各服务配置，不要提交。
- 115 账号有并发与流量限制，且对海外 IP 敏感。
- 在线源与 AV/里番功能涉及成人内容，默认可在 App 设置里整体关闭；请遵守你所在地的法律与各站点条款。
- 个人项目，按现状提供，不保证适配其他环境。

## 许可

MIT，见 [LICENSE](LICENSE)。
