# 常见问题与处理

部署、编译、发布时最容易卡住的地方，以及最简单的处理方式。AI 代理遇到这里列出的情况时，**先照这里处理**；需要我（用户）亲手做的事（登录、授权、在网页上点按钮、输入口令），停下来用一两句话告诉我要做什么、为什么，等我做完再继续。不要为了绕过错误去改脚本、关掉检查或降低安全设置。

先跑这个，大部分问题它会直接指出来：

```bash
./scripts/instance.sh check
```

## GitHub CLI（gh）

| 现象 | 处理 |
|---|---|
| `gh: command not found` | 安装：macOS `brew install gh`；Debian/Ubuntu 按 cli.github.com 的 apt 源说明；其他系统见官方文档 |
| `gh auth status` 未登录 / `HTTP 401` | 用户亲自运行 `gh auth login`（GitHub.com → HTTPS → 浏览器登录）。代理不要代填令牌 |
| `gh secret set` / `gh variable set` 报 `HTTP 403` 或 `Resource not accessible` | 令牌权限不够或不是仓库管理员：`gh auth refresh -s repo,workflow`；确认 `GH_REPO` 是你自己的 fork（`./scripts/instance.sh check` 的 `CI repo`），不是上游 |
| `HTTP 404` / `Could not resolve to a Repository` | `GH_REPO` 写错，或 fork 还没建：`gh repo fork https://github.com/genguzzz/mediahub-oss --clone` |
| 推送工作流文件被拒：`refusing to allow an OAuth App to create or update workflow` | `gh auth refresh -s workflow` |
| AI 代理执行 `./scripts/instance.sh ci` 被它自己的权限机制拦下（写入密钥属于敏感操作） | 正常的安全设计。由用户自己在终端运行一次 `./scripts/instance.sh ci`，或在代理的权限设置里明确放行这一条命令 |

## git

| 现象 | 处理 |
|---|---|
| `Please tell me who you are` / 提交没有作者 | `git config --global user.name "<你的名字>"`、`git config --global user.email "<你的邮箱>"`；不想公开邮箱就用 GitHub 的 `<id>+<用户名>@users.noreply.github.com` |
| HTTPS 推送要密码 / `Authentication failed` | `gh auth setup-git`（让 git 用 gh 的登录）；或改用 SSH 远程并把公钥加到 GitHub |
| `fatal: 'upstream' does not appear to be a git repository` | `./scripts/instance.sh init`（会添加不拉 tag 的 upstream） |
| `tag vX.Y.Z already exists` | 新 fork 会继承上游当时的所有 tag。要发的正是这个版本而它不是你发的：`./scripts/release.sh X.Y.Z "说明" --retag`（替换成你自己的 tag 并在你的 fork 上编译）。以后不要 `git fetch upstream --tags` |
| 提交被 `leak-scan` 拦下 | 说明文件或提交说明里有你的私有值：改成占位值或挪进实例配置。确属误报（例如公开的上游仓库地址）就在 `private-patterns.txt` 加一行 `!<允许的正则>`。不要 `--no-verify` |
| 私有值已经推送到公开仓库 | 立刻轮换相关令牌/口令（见 `docs/UPSTREAM.md` 第 7 节）；再用 `git filter-repo` 清理历史并强推，告知 fork 者重新 clone。域名一旦公开无法收回，只能接受或更换 |
| 合并上游冲突 | 只有改过被跟踪文件才会冲突。个人值类的冲突一律取上游版本、把值挪到实例配置；代码冲突按 `docs/UPSTREAM.md` 第 5 节处理 |

## GitHub Actions 编译

| 现象 | 处理 |
|---|---|
| 推了 tag 但没有运行 | fork 的 Actions 默认关闭：到仓库 Actions 页启用；工作流只在 `app/**` 或工作流文件变动时由 main 触发，tag 总会触发 |
| 任务一直 `Queued` / `No runner matching label` | `xcode-27` 镜像在你的账号不可用或已更名：查当前可用的 Xcode 27 镜像，写进 `instance.env` 的 `IOS_RUNNER`，`./scripts/instance.sh ci` 后重跑 |
| `tag vX does not match app/package.json version` | tag 版本号必须等于 `app/package.json`：用 `./scripts/release.sh X.Y.Z` 打 tag，它会处理 |
| `Info.plist build … != …` / `bundle id does not match` | Secrets 与构建不一致：`./scripts/instance.sh ci` 重新写入后重跑 |
| 还没写 Secrets 就打了 tag | CI 会出一个公开的示例构建 Release。删掉那个 Release 和 tag（`gh release delete vX.Y.Z --cleanup-tag -R <你的 fork>`、`git tag -d vX.Y.Z`），写好 Secrets 再 `release.sh` |
| 编译失败要看日志 | `gh run view <id> --log-failed -R <你的 fork>`；实例构建的 xcodebuild 日志是加密 artifact，`openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass env:IPA_PASSPHRASE -in xcodebuild.log.enc`（先 `set -a; . ~/.config/mediahub/secrets.env; set +a`） |
| macOS 免费分钟用完 / 被计费 | fork 必须是公开仓库；私有仓库的 macOS 分钟按 10 倍计费 |

## 下载与解密 IPA

| 现象 | 处理 |
|---|---|
| `bad decrypt` / `cannot decrypt the artifact` | 本机 `secrets.env` 的 `IPA_PASSPHRASE` 与 fork 的 Secret 不一致（换过机器或重新 init 过）：`./scripts/instance.sh ci` 后重新编译 |
| `no CI run for vX.Y.Z` | tag 没推到 `GH_REPO` 指向的仓库，或 Actions 未启用 |
| artifact 下载 404 / 过期 | 加密 artifact 只保留 7 天：`gh run rerun <id> -R <你的 fork>` 重新编译 |

## ssh、部署后端

| 现象 | 处理 |
|---|---|
| `Permission denied (publickey)` | 本机公钥没加到服务器的 `authorized_keys`。用户自己加（`ssh-copy-id <主机>`），或在 `~/.ssh/config` 里配 `ProxyJump` 经能登录的跳板机；`DEPLOY_HOST` / `PUBLISH_SSH_HOST` 可以写 ssh config 里的别名 |
| `Could not resolve hostname` | 别名只在另一台机器的 ssh config 里：在本机 `~/.ssh/config` 加同名 `Host` 段 |
| 远端命令里的 `$(…)` 报语法错 | 远端登录 shell 是 fish 等非 POSIX shell：脚本只依赖服务器上的 `sh`/bash；手动执行时包一层 `bash -c '…'` |
| `needs Node 22+` | 服务器装 Node 22 或更新版本（NodeSource、nvm 或发行版包）；nvm 安装的 node 不在 systemd 的 PATH 里，在 `deploy/mediahub.service` 覆盖文件里写绝对路径 |
| `nginx -t` 失败 | 先 `ssh <主机> nginx -t` 看具体行；域名、证书、监听写在 `~/.config/mediahub/deploy/nginx-media.conf`；不用 nginx 设 `NGINX_SITE_PATH=none` |
| `/health` 不通 | `ssh <主机> journalctl -u mediahub -n 50`；首次部署后要在服务器 `/opt/mediahub/.env` 填 `MP_API_KEY`、`EMBY_*` 并重启 |
| `ADMIN_TOKEN_CMD` / `PUBLISH_TOKEN_CMD` 读出来为空 | 在服务器上手动执行那条命令看输出（不要贴进对话）；路径或变量名和你的部署不一致就改 `instance.env` |

## OTA 与软件源

| 现象 | 处理 |
|---|---|
| `ota.sh` 拒绝：`Native-side changes since vX` | 自上次发版以来改了原生依赖或 `app.config.ts`：提升 `RUNTIME_VERSION` 并 `release.sh`；确认只是 JS 时 `FORCE=1 ./scripts/ota.sh "说明"` |
| 手机收不到 OTA | 手机上 IPA 的 runtime 与这次 OTA 不同（看后端日志里 manifest 请求的 runtime）；或 IPA 编译时的 `APP_SERVER` 与现在不同；App 要冷启动两次（下载 + 应用） |
| 软件源里看不到新版本 | 打开 `SOURCE_JSON_URL` 看版本号；有 CDN/缓存反代时 `.json` 不要缓存；同版本重发要 `publish.sh X.Y.Z --force` 并清缓存 |
| `source already lists … use --force` | 该版本已发布过；确认要替换才加 `--force` |
| 签名工具提示安装失败 | 换了 `APP_BUNDLE_ID` 等于新 App；证书被吊销或设备未加入证书；`MinimumOSVersion` 高于手机系统 |
| IPA 下载很慢 | 源服务器到手机所在网络慢：在近处加缓存反代，或把 `SOURCE_BASE_URL` 指向 CDN |

还是解决不了：把错误原文（先删掉令牌、域名等私有值）、你执行的命令和 `./scripts/instance.sh check` 的输出整理好，再判断是不是仓库本身的问题；是的话在上游开 Issue，内容同样只能有占位值。
