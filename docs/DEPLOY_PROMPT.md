# 部署提示词（给 AI 代理用）

把下面「提示词」整段交给 Claude Code（或任何能在你的服务器上执行命令的 AI 代理），在本仓库根目录运行。
它会先摸清你的环境，再按需安装缺失的服务并接好，**不会假设你和作者的环境一样**。

建议先自己备好：一台或两台 Linux 主机（可以是同一台）、一个 115 账号、一个域名与 TLS 证书、TMDb API Key、GitHub 账号（编译 IPA 用）。

---

## 提示词

你是部署工程师。目标：在我的机器上搭一套「115 + Emby + MoviePilot + 自制 iOS App（影库）」的家庭影音方案。仓库就是当前目录，先通读 `README.md`、`plugin/prowlarr115/__init__.py` 顶部与 `_defaults()`、`server/src/config.ts`、`deploy/` 下的示例，再动手。

### 0. 原则

1. **因地制宜**：先探测，再决定。不要照抄示例里的地址、路径、端口；示例里的 `example.com`、`openlist`、`emby`、`prowlarr` 等主机名只是占位。
2. **一次只改一个服务，改完验证**（curl 健康检查 / 看日志），再继续下一个。每步用一两句话告诉我在做什么、结果如何。
3. **密钥只放 `.env` / 服务自己的配置里**，不要打印到对话，不要提交进 git。需要我提供的东西（115 Cookie、TMDb Key、域名、证书）列成清单一次问我，别逐个打断。
4. 动到已有服务（已经在跑的 Emby、nginx、docker 网络）前先备份配置并告诉我；破坏性操作先问。
5. 超过 1 分钟的命令放后台跑，保持简短进度汇报。

### 1. 探测环境（只读）

- 操作系统与架构、内存与磁盘、是否有 docker / docker compose、Node（要 22+）、nginx、systemd。
- 已经有哪些服务：Emby、MoviePilot、Prowlarr、OpenList（或 Alist）、qBittorrent、FlareSolverr。有就复用，别重装。
- 网络：服务器在国内还是海外？115 对海外 IP 会风控，海外部署时 115 相关请求需要走国内出口（插件配置项 `proxy_115`，SOCKS5）。JavDB 等站点对部分国家屏蔽（后端环境变量 `INDEX_PROXY`）。
- 域名、证书、公网入口（IPv4/IPv6、端口映射、是否需要跳板机）。
- 把探测结果总结成一张表，并**给出部署方案（哪些服务装在哪台机器、用什么网络互通）**，等我确认后再继续。

### 2. 安装必要服务

按下列依赖顺序，缺哪个装哪个。镜像和端口以各项目官方文档为准，装之前先查最新文档，不要凭记忆。

| 顺序 | 服务 | 作用 | 要点 |
|---|---|---|---|
| 1 | OpenList | 挂载 115，对外给 strm 直链、对插件提供文件 API | 添加 115 存储（Cookie 或扫码）；**本地存储**指向媒体库目录（strm/NFO/字幕写在这里）；关闭直链签名过期（`link_expiration=0`）；记下管理员账号，后面给插件用 |
| 2 | Emby | 媒体库与刮削 | 库路径指向媒体库目录；电影/剧集/动漫库用 TMDb；新建 API Key；库内容全是 `.strm` |
| 3 | go-emby2openlist (ge2o) | 播放请求 302 到 115 CDN | 用 `deploy/nas/ge2o.config.template.yml` 渲染；`emby.host` 指向 Emby，`openlist.host/token` 指向 OpenList；`strm.internal-redirect-enable: true`（115 链接绑 UA，必须由 ge2o 转发客户端 UA）；只监听本机 8095 |
| 4 | nginx 前置 | TLS + 把播放类请求分流给 ge2o，其余给 Emby | 用 `deploy/nas/nginx-emby.conf`，改 `server_name`、证书、upstream 地址；对外端口通常 8920 |
| 5 | Prowlarr | 索引器聚合（给插件搜资源） | 添加你用得上的索引器；记下 API Key。需要过 Cloudflare 的站点配合 FlareSolverr |
| 6 | MoviePilot V3 | 订阅/搜索/整理框架，插件宿主 | 用 `deploy/moviepilot-compose.yml`；**关闭自动升级**（插件包装了 MP 内部搜索函数，升级可能破坏）；容器网络要能访问 OpenList、Emby、Prowlarr、qBittorrent（若用） |
| 7 | FlareSolverr（可选） | 后端抓 Jable 等有 CF 挑战的页面 | 默认 `http://127.0.0.1:8191/v1`，后端变量 `FLARESOLVERR_URL` |
| 8 | MDC 刮削器（可选，仅 AV） | 番号刮削 | 需有 REST 后端，插件配置 `mdc_url`；不做 AV 可跳过 |
| 9 | qBittorrent（可选） | 115 离线不可用时的本地缓冲 | 不需要缓冲可跳过 |

每装完一个，做一次最小验证：OpenList 能列出 `/115`；Emby 能扫到一个手写的测试 strm 并能播放；经 nginx 访问 Emby 的播放请求能 302 到 115。

### 3. 安装插件 Prowlarr115

1. 把 `plugin/prowlarr115/` 与 `plugin/package.v3.json` 放到 MoviePilot 本地插件源（`PLUGIN_LOCAL_REPO_PATHS` 指向的目录）下：`plugins.v3/prowlarr115/` 和 `package.v3.json`。
2. 重启 MoviePilot，在插件页安装并启用「115 媒体入库」。
3. 在插件设置里按**你的实际地址**填写：Prowlarr 地址与 Key、OpenList 地址与账号、115 Cookie、`proxy_115`（海外部署才需要）、Emby 地址与 Key、库根目录（`lib_ol_root` 是 OpenList 里的媒体库路径，`emby_lib_root` 是 Emby 容器里看到的同一目录）、115 里的根目录 `root`（默认 `/115/Emby`）。
4. 用一部电影做端到端测试：MP 搜索 → 选资源 → 115 离线 → 插件生成 strm → Emby 刮削出海报 → 播放。日志看 `docker logs moviepilot | grep Prowlarr115`。
5. 目录规范（插件依赖）：电影 `名 (年) [tmdbid=N]/…`；剧集 `名 (年) [tmdbid=N]/Season N/名 SxxEyy.ext`。不要手动改成别的命名。

### 4. 后端（server/）

1. 复制 `server/.env.example` 为服务器上的 `.env`，填 `MP_API_KEY`（MP 设置里的 API 令牌）、`EMBY_*`、`UPDATES_BASE`；`APP_TOKEN`、`ADMIN_TOKEN` 用 `openssl rand -hex 24` 生成。
2. 改 `server/deploy/nginx-media.conf`（域名、证书），然后 `DEPLOY_HOST=user@host ./server/deploy/deploy.sh`；也可以按你的习惯用 docker 或 pm2 跑 `node src/server.ts`（Node 22 的 type stripping，无需编译）。
3. `curl https://你的域名/health` 返回 ok。
4. 在线源（可选）：JavDB 需要合适出口（`INDEX_PROXY`），Jable 需要 FlareSolverr。不需要成人内容就别配，App 设置里也有总开关。

### 5. iOS App（app/）

1. 全局替换占位：`app/app.config.ts` 里的 `media.example.com`（OTA 地址）和 bundle id `com.example.mediahub`（改成你自己的）；`app/src/lib/settings.ts` 的 `DEFAULT_SERVER`；`app/src/app/settings.tsx` 里的 Emby 占位地址。
2. 编译：推到你自己的 GitHub 仓库，`.github/workflows/ios.yml` 在 GitHub Mac 上产出**未签名 IPA**（需要带 Xcode 27 的 `xcode-27` runner，约 17 分钟；若 runner 不可用，按 AetherEngine 当前要求改 runner 标签）。`./scripts/release.sh X.Y.Z "说明"` 打 tag 触发。
3. 签名与分发由你决定，按你的条件选一种，**先问我用哪种**：自己的 Apple 开发者账号（AltStore/SideStore/Sideloadly）、企业/共享证书配合第三方签名工具的自建软件源，等。若自建软件源，`scripts/publish.sh` 通过 `SOURCE_PUBLISH_URL` 把 IPA 交给你的发布服务（需自行实现，接收 ipa/icon/version/notes 等表单字段并更新源 JSON）。
4. 只改 JS 的更新走 OTA：`MEDIAHUB_SERVER=https://你的域名 MEDIAHUB_ADMIN_TOKEN=… ./scripts/ota.sh "说明"`。涉及原生依赖或 `app.config.ts` 变更必须重新出 IPA 并提升 `RUNTIME_VERSION`。
5. App 首次打开：设置里填后端地址、`APP_TOKEN`、Emby 地址与账号。

### 6. 收尾

- 列出最终拓扑（谁在哪台机器、端口、域名），以及每个服务的启动/日志/重启命令，写到 `DEPLOYMENT_NOTES.md`（不含密钥）。
- 给出我还需要手动完成的事项清单（例如 DNS、证书续期、115 Cookie 过期后的更新方式、新增媒体库后要把它加进各 Emby 账号的可见库）。
- 如果 Emby 里有成人库，提醒我用独立账号和库权限隔离（只靠首页排除不彻底）。

---

## 常见需要因地制宜的点

| 情况 | 处理 |
|---|---|
| 国内家宽 + 公网 IPv6 | nginx 直接暴露 8920；无公网 IPv4 可加跳板机做 TLS 透传 |
| 海外 VPS 部署全部服务 | 115 相关请求走国内出口代理（`proxy_115`），否则易触发异地风控 |
| 已有 Emby/MoviePilot | 复用，只补插件、ge2o、nginx 分流 |
| 单机小内存 | MoviePilot 限 1.5 GB 左右；Prowlarr 不要开太多索引器；FlareSolverr 按需 |
| 不要成人内容 | 不配 MDC/JavDB/Jable，插件里关闭「AV / 里番 入库」 |
| 没有 Mac / 不想自己编译 | 只用后端 + Emby 官方客户端也能得到 115 + strm + 自动入库的主体能力 |
