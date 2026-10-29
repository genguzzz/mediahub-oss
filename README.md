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
| `scripts/` | `instance.sh`（实例配置）、`release.sh`（打 tag 触发编译）、`publish.sh`（把 IPA 放进软件源）、`ota.sh`（推送 JS 更新）、`update.sh`（跟进上游） |
| `docs/` | 部署提示词、fork 维护与更新、常见问题 |
| `.github/workflows/ios.yml` | GitHub Actions 编译未签名 IPA |

## 部署：先 fork，再在自己的仓库里构建

App 的 bundle id、后端地址（含 OTA 地址）是**编译时嵌进 IPA** 的，所以每个人都要：

1. **fork 本仓库**（保持公开，GitHub 的 macOS 编译对公开仓库免费），clone 自己的 fork；
2. 在仓库之外的实例目录里配置自己的值，写入自己 fork 的 GitHub Secrets；
3. 用自己 fork 的 GitHub Actions 编译 IPA，发布到自己的软件源 / 自己安装；
4. 以后从上游拉更新，再按提示部署后端、推 OTA 或发新 IPA。

部署高度依赖各人的网络、机器和已有服务，所以没有一键脚本，而是一份**部署提示词模板**：[`docs/DEPLOY_PROMPT.md`](docs/DEPLOY_PROMPT.md)。在你 fork 的仓库根目录启动 Claude Code（或其他能在你机器上执行命令的 AI 代理），把提示词整段贴给它：它先探测你的环境、给出方案等你确认，再按需安装 OpenList、Emby、go-emby2openlist、反代、Prowlarr、MoviePilot（及可选的 FlareSolverr、MDC、qBittorrent），装插件、部署后端、编译并分发 App。

| 文档 | 内容 |
|---|---|
| [`docs/DEPLOY_PROMPT.md`](docs/DEPLOY_PROMPT.md) | 首次部署的提示词模板（按你的环境调整） |
| [`docs/UPSTREAM.md`](docs/UPSTREAM.md) | fork 维护：什么放配置、怎么从上游更新、怎么发自己的版本、怎么定制、怎么给上游提 PR |
| [`docs/TROUBLESHOOTING.md`](docs/TROUBLESHOOTING.md) | gh 登录与权限、写 Secrets、git 身份、提交被拦、CI、解密、ssh、OTA、软件源等常见问题 |

## 实例配置、发布与更新

仓库里只有占位值（`example.com`、`com.example.mediahub` 等），**不需要也不应该改它们**。每套部署的个人值放在仓库之外的实例目录 `~/.config/mediahub/`：

| 文件 | 内容 |
|---|---|
| `instance.env` | bundle id、后端/Emby 地址、编译用的 fork 与构建号基数、服务器 ssh、软件源发布方式（模板 `instance.env.example`） |
| `secrets.env` | IPA 加密口令，以及可选的管理/发布令牌（模板 `secrets.env.example`，chmod 600） |
| `private-patterns.txt` | 你的域名、主机名、IP 等，提交前自动检查文件和提交说明，防止误提交 |
| `deploy/` | 可选：覆盖 `server/deploy/` 的 systemd 单元与 nginx 站点 |
| `NOTES.md` | 你这套部署的运维笔记，AI 代理会读取 |

```bash
./scripts/instance.sh init        # 建目录、生成口令、启用提交前检查、添加 upstream
./scripts/instance.sh check       # 查看配置、缺项、fork 的 Actions 与 Secrets
./scripts/instance.sh ci          # 写入你 fork 的 GitHub Secrets / Variables
./server/deploy/deploy.sh         # 部署后端（--dry-run 只看差异）
./scripts/ota.sh "说明"            # 只改 JS 时的热更新
./scripts/release.sh 0.6.0 "说明" --publish   # 打 tag → 你 fork 的 Actions 编译 → 发布到你的软件源
./scripts/publish.sh 0.6.0 --out ~/Downloads  # 或者只下载解密 IPA，自己安装
./scripts/update.sh --dry-run     # 上游有什么新东西、要怎么发布；去掉 --dry-run 即合并
```

设置了 Secrets 后，CI 编译的 IPA 带你的域名，只以加密 artifact 上传（Release 里只有说明），`publish.sh` 在本机解密后放进你的软件源：`static` 模式直接写网站目录并维护 `appstore.json`，`api` 模式交给你已有的发布服务。公开仓库和日志里看不到你的域名。

## 注意

- 仓库已移除作者的域名、地址和凭据；密钥只放实例目录、服务器 `.env` 与各服务配置，不要提交。
- 115 账号有并发与流量限制，且对海外 IP 敏感。
- 在线源与 AV/里番功能涉及成人内容，默认可在 App 设置里整体关闭；请遵守你所在地的法律与各站点条款。
- 个人项目，按现状提供，不保证适配其他环境。

## 许可

MIT，见 [LICENSE](LICENSE)。
