# 部署提示词（给 AI 代理用）

这是一份**模板和方向**，不是安装脚本。每个人的机器、网络、已有服务、域名、签名方式、软件源都不一样；作者自己的部署只是其中一种（见文末「作者的部署只是一例」）。把下面「提示词」整段交给 Claude Code、Cursor、Codex 等能在你的机器上执行命令的 AI 代理，在**你自己 fork 的仓库**根目录运行。代理要先摸清你的环境、给出方案、等你确认，再一步步装、接、验证。

建议先备好：一台或多台 Linux 主机（可以是同一台）、一个 115 账号、域名与 TLS 证书（或能申请证书的 DNS）、TMDb API Key、GitHub 账号。只想要后端 + Emby 官方客户端时，可以跳过 App 部分。

---

## 提示词

你是我的部署工程师。目标：用这个仓库在我的机器上搭一套「115 + Emby + MoviePilot + 自制 iOS App（影库）」的家庭影音方案，并让我以后能方便地从上游更新。仓库是我从上游 fork 的，就是当前目录。

先通读：`README.md`、`CLAUDE.md`（工作规则，尤其「Instance config and credentials」与「Privacy」两节）、`docs/UPSTREAM.md`（fork 与更新方式）、`docs/TROUBLESHOOTING.md`（常见错误的处理）、`instance.env.example`、`server/.env.example`、`server/src/config.ts`、`plugin/prowlarr115/__init__.py` 顶部与 `_defaults()`、`deploy/` 下的示例。读完用几句话复述你理解的整体架构，再动手。

### 0. 必须遵守的规则

1. **因地制宜**：仓库里的地址、路径、端口、主机名（`example.com`、`openlist`、`emby`、`/opt/mediahub` 等）和作者的 GitHub Actions 配置都只是**一种可行做法**。先探测我的环境，再决定怎么装、装在哪、用什么网络互通；和示例不一样很正常，按我的情况改。
2. **个人信息绝不进仓库**。这是公开仓库，fork 也是公开的：我的域名、主机名、IP、bundle id、用户名、本机路径、令牌、Cookie、口令**不能**出现在任何被 git 跟踪的文件、提交说明、tag / Release 说明、PR、Issue、CI 日志或公开 artifact 里。它们只能放：
   - 本机实例目录 `${MEDIAHUB_CONFIG_DIR:-~/.config/mediahub}`（`instance.env`、`secrets.env`、`private-patterns.txt`、`deploy/` 覆盖文件、`NOTES.md`）；
   - 我 fork 的 GitHub Secrets / Variables（用 `./scripts/instance.sh ci` 写入）；
   - 服务器上的 `.env` 与各服务自己的配置。
   不要修改仓库里的占位值去"适配"我；需要不同的值就用实例配置或覆盖文件。代码确实缺一个可配置项时，加成通用设置（占位默认值 + 写进 `*.env.example`），而不是写死我的值。
3. **提交前钩子不许绕过**：`./scripts/instance.sh init` 会启用 `.githooks/`（pre-commit 扫文件、commit-msg 扫提交说明，规则来自 `instance.env` 的值与 `private-patterns.txt`）。被拦就改写内容，**不要** `--no-verify`。推送前跑 `./scripts/instance.sh scan`。不要 `git add -A` 一把梭，逐个确认要提交的文件。
4. **密钥不进对话**：不要把令牌、Cookie、口令打印出来或贴进回复；需要验证时只说"已设置 / 长度 N"。服务器上的令牌优先用 `*_CMD`（例如 `ADMIN_TOKEN_CMD`）在服务器上现场读取，不拷到本机。
5. **一次只改一个服务，改完验证**（curl 健康检查、看日志），再继续。每步用一两句话告诉我在做什么、结果如何。
6. 需要我提供的东西（115 Cookie、TMDb Key、域名、证书、Apple/签名方式、软件源）**列成清单一次问我**，别逐个打断。
7. 动到已有服务（在跑的 Emby、nginx、docker 网络、防火墙）前先备份配置并告诉我；破坏性操作先问。
8. 超过 1 分钟的命令放后台跑，保持简短进度汇报。
9. **出错先查 `docs/TROUBLESHOOTING.md`**（gh 登录与权限、写 Secrets、git 身份与推送、提交被拦、CI runner、解密、ssh、OTA、软件源）。需要我亲手做的（`gh auth login`、网页上启用 Actions、加 ssh 公钥、放行写密钥的命令）就停下来，告诉我具体做什么，等我做完。不要为了绕过错误去改脚本、关检查或用 `--no-verify`。

### 1. 准备 fork 与实例配置（在我用来部署/发布的电脑上）

1. 确认当前仓库是我自己的 fork（`git remote -v` 的 origin 是我的 GitHub 账号），不是上游。还没 fork 的话用 `gh repo fork https://github.com/genguzzz/mediahub-oss --clone`。fork 保持公开（公开仓库的 GitHub macOS runner 免费）。
2. 给本仓库设一个**可以公开**的 git 身份（`git config user.name`、`git config user.email` 用 GitHub noreply 地址，不加 `--global`），每个提交都会公开它。
3. `./scripts/instance.sh init`：建实例目录、生成 IPA 加密口令、启用提交前检查、添加不拉 tag 的 `upstream` 远程。
4. 把我的私有关键词（域名、主机名、用户名、真实姓名与邮箱、IP、本机路径）逐行写进 `~/.config/mediahub/private-patterns.txt`。`APP_*` 里的域名和 bundle id 会自动检查，不用重复写。
5. `instance.env` 先留着，后面每一步确定了值再填。

### 2. 探测环境（只读）

- 每台机器：操作系统与架构、内存与磁盘、docker / docker compose、Node（后端要 22+）、nginx 或其他反代、systemd。
- 已有服务：Emby、MoviePilot、Prowlarr、OpenList（或 Alist）、qBittorrent、FlareSolverr、已有的软件源。有就复用，不要重装。
- 网络：服务器在国内还是海外？115 对海外 IP 会风控，海外部署时 115 相关请求要走国内出口（插件 `proxy_115`，SOCKS5）。JavDB 等站点对部分国家屏蔽（后端 `INDEX_PROXY`）。从手机所在网络访问服务器快不快（决定 IPA 下载要不要走缓存/CDN）。
- 域名、证书、公网入口（IPv4/IPv6、端口映射、是否需要跳板机或隧道）。
- 我用什么方式把 IPA 装到手机上（自己的 Apple 开发者账号 + AltStore/SideStore/Sideloadly、全能签等签名工具 + 自建软件源、其他）。
- 把探测结果总结成表，**给出部署方案**（哪些服务装在哪台机器、怎么互通、App 怎么分发），等我确认后再继续。

### 3. 安装媒体服务

按依赖顺序，缺哪个装哪个。镜像、端口、配置项以各项目**当前官方文档**为准，装之前先查，不要凭记忆。

| 顺序 | 服务 | 作用 | 要点 |
|---|---|---|---|
| 1 | OpenList | 挂载 115，给 strm 直链、给插件文件 API | 添加 115 存储（Cookie 或扫码）；**本地存储**指向媒体库目录（strm/NFO/字幕写这里）；关闭直链签名过期（`link_expiration=0`）；记下管理员账号给插件用 |
| 2 | Emby | 媒体库与刮削 | 库路径指向媒体库目录；电影/剧集/动漫库用 TMDb；新建 API Key；库里全是 `.strm` |
| 3 | go-emby2openlist (ge2o) | 播放请求 302 到 115 CDN | 用 `deploy/nas/ge2o.config.template.yml` 渲染；`emby.host` 指向 Emby，`openlist.host/token` 指向 OpenList；`strm.internal-redirect-enable: true`（115 链接绑 UA，必须由 ge2o 转发客户端 UA）；只监听本机 |
| 4 | 反代（nginx 等） | TLS + 播放类请求分流给 ge2o，其余给 Emby | 参考 `deploy/nas/nginx-emby.conf`，按我的域名、证书、端口改；用 Caddy/Traefik 也行 |
| 5 | Prowlarr | 索引器聚合 | 加我用得上的索引器；记下 API Key；需要过 Cloudflare 的配 FlareSolverr |
| 6 | MoviePilot V3 | 订阅/搜索/整理，插件宿主 | 参考 `deploy/moviepilot-compose.yml`；**关闭自动升级**（插件包装了 MP 内部函数）；容器要能访问 OpenList、Emby、Prowlarr、qBittorrent |
| 7 | FlareSolverr（可选） | 后端抓有 CF 挑战的页面 | 后端 `FLARESOLVERR_URL` |
| 8 | MDC 刮削器（可选，仅 AV） | 番号刮削 | 插件 `mdc_url`；不做 AV 跳过 |
| 9 | qBittorrent（可选） | 115 离线不可用时的本地缓冲 | 不需要跳过 |

每装完一个做最小验证：OpenList 能列出 115；Emby 能扫到一个手写测试 strm 并播放；经反代访问 Emby 的播放请求能 302 到 115。

### 4. 安装插件 Prowlarr115

1. 把 `plugin/prowlarr115/` 与 `plugin/package.v3.json` 放进 MoviePilot 本地插件源（`PLUGIN_LOCAL_REPO_PATHS` 指向的目录）：`plugins.v3/prowlarr115/` 和 `package.v3.json`。
2. 重启 MoviePilot，安装并启用「115 媒体入库」。
3. 按**我的实际地址**填插件设置：Prowlarr 地址与 Key、OpenList 地址与账号、115 Cookie、`proxy_115`（海外才需要）、Emby 地址与 Key、库根目录（`lib_ol_root` 是 OpenList 里的媒体库路径，`emby_lib_root` 是 Emby 容器里看到的同一目录）、115 根目录 `root`。
4. 端到端测试一部电影：MP 搜索 → 选资源 → 115 离线 → 生成 strm → Emby 刮削 → 播放。日志 `docker logs <moviepilot 容器> | grep Prowlarr115`。
5. 目录规范（插件依赖）：电影 `名 (年) [tmdbid=N]/…`；剧集 `名 (年) [tmdbid=N]/Season N/名 SxxEyy.ext`。

### 5. 后端（server/）

1. 定下后端对外地址（例如 `https://media.<我的域名>`），填进 `instance.env` 的 `APP_SERVER`；`DEPLOY_HOST` 填 ssh 目标（需要能写 `/opt/mediahub` 与 `/etc`）。
2. 仓库的 `server/deploy/deploy.sh` 是**一种**部署方式（ssh + systemd + nginx，装在 `/opt/mediahub`）。适合我就用：需要改 systemd 单元或 nginx 站点时，复制 `server/deploy/{mediahub.service,nginx-media.conf}` 到 `~/.config/mediahub/deploy/` 再改（不要改仓库里的模板）；反代不是 nginx 就设 `NGINX_SITE_PATH=none` 自己配；先 `./server/deploy/deploy.sh --dry-run` 看差异，再部署。不适合（docker、pm2、群晖等）就按我的习惯跑 `node src/server.ts`（Node 22 type stripping，无需编译），环境变量照 `server/.env.example`。
3. 首次部署后在服务器 `.env` 里填 `MP_API_KEY`、`EMBY_*`、`UPDATES_BASE`（= `$APP_SERVER/updates`）等，重启。`APP_TOKEN` 是 App 登录用的，`ADMIN_TOKEN` 给 OTA 与管理接口用，都留在服务器上。
4. `curl https://<后端地址>/health` 返回 ok。
5. 在线源可选：JavDB 需要合适出口（`INDEX_PROXY`），Jable 需要 FlareSolverr。不要成人内容就别配，App 设置里也有总开关。

### 6. iOS App：在我的 fork 上编译

App 的 bundle id、后端地址（含 OTA 地址）、默认 Emby 地址是**编译时嵌进 IPA** 的，所以必须用我自己的值、在我自己的 fork 上编译；上游的 IPA 是示例构建，不能用于我的部署。

1. 在 `instance.env` 填 `APP_BUNDLE_ID`（我自己的反向域名 id）、`APP_SERVER`、`APP_EMBY_SERVER`、`GH_REPO`（我的 fork）、`BUILD_NUMBER_BASE`（以前装过别的构建就调高）、`MASK_TERMS`（日志里要额外打码的词）。`./scripts/instance.sh ci` 写入 fork 的 Secrets / Variables；`./scripts/instance.sh check` 确认 Actions 已启用（fork 默认关闭，要在网页上启用一次）。
2. 工作流 `.github/workflows/ios.yml` 在 GitHub Mac 上产出**未签名 IPA**。它用 `xcode-27` runner（AetherEngine 需要 Xcode 27）；这个镜像在我的账号上不可用或已更名时，查 AetherEngine 与 GitHub runner 当前文档，把标签写进 `instance.env` 的 `IOS_RUNNER` 再 `instance.sh ci`，不要改工作流文件。
3. 发版：`./scripts/release.sh X.Y.Z "说明"`（版本号用 `app/package.json` 里的、跟上游走）。fork 继承了上游的 tag，所以**第一次**发当前版本要加 `--retag`。设置了 Secrets 的构建只上传**加密 artifact**，Release 只有说明。说明会公开，不要写我的域名。
4. 编译完成后检查：下载解密（`./scripts/publish.sh X.Y.Z --out <临时目录>`），核对 `Info.plist` 的 `CFBundleIdentifier`、`CFBundleShortVersionString`、`CFBundleVersion`、`MinimumOSVersion`、`CFBundleDisplayName`。

### 7. 分发：把 IPA 装到我的手机

按我的条件选，**先问我用哪种**：

- **只要 IPA**：`./scripts/publish.sh X.Y.Z --out <目录>`，用 Sideloadly / AltStore / 爱思等自己装。
- **自建软件源（全能签、ESign、AltStore 源等）**，二选一：
  - `static`：一个能被手机访问的 HTTPS 静态目录就是源。`instance.env` 填 `PUBLISH_DIR`（目录）、`SOURCE_BASE_URL`（它的公网地址）、目录不在本机时填 `PUBLISH_SSH_HOST`。`publish.sh` 会上传 IPA 和图标并自己更新 `appstore.json`。目录要配好 TLS，`.json` 不要缓存。
  - `api`：我已经有一个发布服务，填 `PUBLISH_URL`，令牌放 `secrets.env` 的 `PUBLISH_TOKEN`，或服务只在服务器本机监听时用 `PUBLISH_SSH_HOST` + `PUBLISH_TOKEN_CMD`，令牌留在服务器。
- 手机在国内而源服务器在海外时，IPA 下载可能很慢；可以在国内机器加缓存反代，或把 `SOURCE_BASE_URL` 指向 CDN。
- 以后发版直接 `./scripts/release.sh X.Y.Z "说明" --publish`，后台等编译完成后自动发布。

### 8. OTA 与首次使用

1. 只改 JS 的更新走 OTA：`./scripts/ota.sh "说明"`（地址来自 `APP_SERVER`，令牌用 `ADMIN_TOKEN_CMD` 在服务器上读）。改原生依赖或 `app.config.ts` 必须提升 `RUNTIME_VERSION` 并重新出 IPA。
2. App 首次打开：后端地址与 Emby 地址已是我的默认值，填 `APP_TOKEN` 与 Emby 账号即可。验证 OTA：推一次 `ota.sh`，App 重启后能在设置里看到新的更新说明。

### 9. 收尾

- 把最终拓扑（谁在哪台机器、端口、域名、反代、缓存）、每个服务的启动 / 日志 / 重启命令、插件源位置、需要定期处理的事（证书续期、115 Cookie 过期、新建媒体库后加进各 Emby 账号的可见库）写进 `~/.config/mediahub/NOTES.md`（不含密钥）。以后的代理会读它；`CLAUDE.md` 已经引用了它。
- 提醒我备份整个 `~/.config/mediahub`（私有仓库或密码管理器），它是这套部署的全部私有状态。
- 告诉我以后怎么更新：`./scripts/update.sh --dry-run` → `./scripts/update.sh` → 按提示部署后端 / OTA / 发 IPA（详见 `docs/UPSTREAM.md`）。
- 如果 Emby 里有成人库，提醒我用独立账号和库权限隔离。
- 最后跑一次 `./scripts/instance.sh scan` 和 `git status`，确认没有任何个人信息进了仓库。

---

## 常见需要因地制宜的点

| 情况 | 处理 |
|---|---|
| 国内家宽 + 公网 IPv6 | 反代直接暴露；无公网 IPv4 可加跳板机做 TLS 透传或用隧道 |
| 海外 VPS 部署全部服务 | 115 请求走国内出口代理（`proxy_115`），否则易触发异地风控 |
| 已有 Emby / MoviePilot | 复用，只补插件、ge2o、反代分流 |
| 单机小内存 | MoviePilot 限 1.5 GB 左右；Prowlarr 少开索引器；FlareSolverr 按需 |
| 不要成人内容 | 不配 MDC/JavDB/Jable，插件里关闭「AV / 里番 入库」 |
| 反代不是 nginx | `NGINX_SITE_PATH=none`，自己把后端 `127.0.0.1:8793` 接到 HTTPS |
| `xcode-27` runner 不可用 | 换成当前可用的、带 Xcode 27 的镜像标签，写进 `IOS_RUNNER` |
| 没有 Mac、不想自己编译 | 只用后端 + Emby 官方客户端，也能得到 115 + strm + 自动入库的主体能力 |

## 作者的部署只是一例

作者自己的部署大致是：后端、MoviePilot 与发布服务在一台海外 VPS，Emby/OpenList 在家里 NAS，后端经家宽出口访问部分站点；IPA 由本仓库的 Actions 编译（加密 artifact），`publish.sh` 用 `api` 模式交给 VPS 上已有的发布服务，再由国内机器上的缓存反代给手机下载。这只是因为作者的机器恰好这样分布，你的方案按你的条件来，不需要复刻。
