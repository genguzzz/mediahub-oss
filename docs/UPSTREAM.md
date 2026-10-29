# Fork 维护与从上游更新

本文给**在自己 fork 里部署、构建、发布影库**的人（以及替你操作的 AI 代理）看：仓库与个人配置怎么分工、怎么跟进上游、怎么发自己的版本、怎么做只属于自己的定制。首次部署请先按 [`DEPLOY_PROMPT.md`](DEPLOY_PROMPT.md) 走完。

## 1. 为什么要 fork，而不是直接用上游的 IPA

App 里有几项**编译时写死**的值，每套部署都不同：

| 值 | 来源 | 写到哪里 |
|---|---|---|
| `APP_BUNDLE_ID` | 你的 instance.env → GitHub Secret | `Info.plist` 的 `CFBundleIdentifier`（签名、软件源、OTA 都按它区分 App） |
| `APP_SERVER` | 同上 | OTA 地址 `$APP_SERVER/updates/manifest`（只能在编译时定，之后无法改），以及首次打开时的默认后端 |
| `APP_EMBY_SERVER` | 同上 | 首次登录时默认的 Emby 地址 |
| `BUILD_NUMBER_BASE` | GitHub Variable | `CFBundleVersion` = 基数 + CI 运行序号 |

上游 Release 里的 IPA 是**示例构建**（`com.example.mediahub`、`media.example.com`），装上能用但收不到你后端推送的 OTA。所以每个人都应在**自己的 fork** 里配置 Secrets，用 GitHub Actions 编出属于自己的 IPA。仓库是公开的，但这些值只存在：

- 你本机的实例目录 `${MEDIAHUB_CONFIG_DIR:-~/.config/mediahub}`（`instance.env`、`secrets.env`、`private-patterns.txt`、`deploy/`、`NOTES.md`）；
- 你 fork 的 GitHub Secrets（只有仓库管理员能写，任何人都读不出；fork 你仓库的人也拿不到，来自 fork 的 PR 也拿不到，本工作流也不在 PR 上运行）；
- CI 产出的 IPA 只以 **加密 artifact** 上传（保存 7 天），Release 只放更新说明；日志里你的域名会被打码。

结论：**仓库文件永远只有占位值，你的版本 = 上游代码 + 你的实例配置**。只要不改仓库里被跟踪的文件，跟进上游永远不会冲突。

> fork 请保持公开：GitHub 对公开仓库的 macOS runner 免费，私有仓库按 10 倍分钟计费，一次 IPA 编译约 15–25 分钟。

## 2. 一次性设置（每台用来部署/发布的电脑）

```bash
gh repo fork https://github.com/genguzzz/mediahub-oss --clone   # 首次：fork 并 clone（已有 fork 则 git clone 你的 fork）
cd mediahub-oss
./scripts/instance.sh init    # 实例目录 + IPA 加密口令 + 提交前泄露检查 + upstream 远程（不拉 tag）
$EDITOR ~/.config/mediahub/instance.env      # 填你的值，逐项说明见 instance.env.example
./scripts/instance.sh ci      # 写入你 fork 的 Secrets / Variables
./scripts/instance.sh check   # 无缺项、Actions 已启用、Secrets 齐全
```

- fork 出来的仓库 **Actions 默认是关的**：到 fork 的 Actions 页点一次启用，`check` 会提示。
- 换电脑：把整个 `~/.config/mediahub` 拷过去（它就是你这套部署的全部私有状态，建议放进私有仓库或密码管理器备份），clone 你的 fork，再跑一次 `init` 和 `check`。`init` 不会覆盖已有文件。
- `upstream` 远程设置了 `tagOpt --no-tags`：上游的 `v0.6.0` 等 tag 不会进你的仓库，你的 `v0.6.0` 由你自己的 `release.sh` 打、触发你自己的构建。**不要** `git fetch upstream --tags`，也不要把上游 tag 推到你的 fork。

## 3. 日常：跟进上游

```bash
./scripts/update.sh --dry-run   # 看上游有哪些提交、改了哪些部分、要怎么发布
./scripts/update.sh             # 合并到当前分支、跑泄露检查、推送到你的 fork
```

`update.sh` 会按改动类型告诉你下一步：

| 上游改了 | 你要做 |
|---|---|
| `server/` | `./server/deploy/deploy.sh --dry-run` 看单元/nginx 差异，再 `./server/deploy/deploy.sh` |
| `server/deploy/` 模板 | 如果你在 `~/.config/mediahub/deploy/` 有覆盖文件，把模板的变化手动并进去（脚本优先用你的文件） |
| `plugin/` | 把 `plugin/prowlarr115/` 与 `plugin/package.v3.json` 拷到你的 MoviePilot 本地插件源，在 MP 里重载插件 |
| `app/` 只有 JS | `./scripts/ota.sh "说明"`，手机下次启动即更新 |
| `app/` 的 `RUNTIME_VERSION` 变了（原生改动） | 必须出新 IPA：`./scripts/release.sh <上游版本号> "说明" --publish` |
| `app/package.json` 版本号变了、runtime 没变 | 两种都行：发同版本号的 IPA（`release.sh`），或只推 OTA |
| `instance.env.example` 有新设置 | `update.sh` / `check` 会列出你缺的键；不填就是默认值，需要时填进你的 instance.env |
| `.github/workflows/` | 看是否新增了 Secret/Variable，需要的话 `./scripts/instance.sh ci` |
| `deploy/` 示例 | 和你线上的 nginx / ge2o / compose 对比，按需手动改线上配置 |

**部署顺序**：后端和 App 都变时，先部署后端，再 OTA / 发 IPA。

也可以用 GitHub 网页上 fork 的 “Sync fork” 按钮，然后本地 `git pull`；效果相同（同样不同步 tag），但看不到上面的发布提示：Sync 之前先跑一次 `./scripts/update.sh --dry-run`，或按上表自己判断。

## 4. 发布你自己的版本

**版本号跟上游走。** 上游发 `0.6.0` 时，它的 `app/package.json` 已经是 `0.6.0`，你合并后运行：

```bash
./scripts/release.sh 0.6.0 "新增：…；修复：…" --publish
```

版本号与 `package.json` 相同时，`release.sh` 不会产生 “Release v…” 提交，只在你的 fork 上打 tag `v0.6.0` 并推送，触发**你 fork 的** CI：用你的 Secrets 编译 → 校验 `Info.plist`（版本、构建号、bundle id）→ 加密上传。`--publish` 在后台运行 `publish.sh`，等编译完成后下载、解密并发布到你的软件源（三种方式见 `instance.env.example`：`static` 直接写网站目录、`api` 交给已有的发布服务、或 `--out <dir>` 只拿 IPA 自己装）。

- **新 fork 的第一次发版**：fork 时 GitHub 会复制上游当时的所有 tag，所以当前版本的 tag 已经存在（但不是你的构建）。第一次发当前版本时加 `--retag`：`./scripts/release.sh 0.5.0 "说明" --publish --retag`。之后的版本不会再遇到。
- 构建号：`CFBundleVersion = BUILD_NUMBER_BASE + 运行序号`，单调递增。若你以前装过更高构建号的包，把 `BUILD_NUMBER_BASE` 调高后 `instance.sh ci`。
- 同一版本想重发（比如改了 Secret）：在 GitHub 上删除那次 tag 和 Release 后重新 `release.sh`，再 `publish.sh X.Y.Z --force`。
- 编译失败：`gh run view <id> --log-failed`；实例构建的 xcodebuild 日志是加密的 `xcodebuild.log.enc`，用 `IPA_PASSPHRASE` 解密（命令见 `CLAUDE.md`）。

## 5. 定制：哪些放配置，哪些改代码

按这个顺序选，越靠前越不会和上游冲突：

1. **实例设置**：地址、id、主机、发布目标 → `instance.env`；后端行为 → 服务器 `/opt/mediahub/.env`；systemd / nginx → `~/.config/mediahub/deploy/` 覆盖文件；App 里的偏好 → App 设置页。
2. **通用的新设置项**：你需要的行为别人也可能需要 → 在代码里加成可配置项（占位默认值 + 写进 `instance.env.example` 或 `server/.env.example`），给上游提 PR。合并后你只在实例配置里打开它。
3. **只属于你的代码改动**（最后手段）：在你 fork 的 `main` 上直接提交，接受跟进上游时偶尔要解决冲突。保持改动小、集中、写清提交说明。避免只在自己 fork 里做原生改动：它要求提升 `RUNTIME_VERSION` 和版本号，会和上游后续的版本号撞车（真遇到时，合并时采用上游的 `package.json` / `RUNTIME_VERSION`，再发一个还没用过的更高版本）。

无论哪种，**提交里都不能出现你的域名、主机名、IP、用户名、路径、令牌**。提交前钩子会按 `instance.env` 的值和 `private-patterns.txt` 拦截；整个仓库可用 `./scripts/instance.sh scan` 检查。不要用 `--no-verify` 绕过。

## 6. 给上游提 PR

```bash
git switch -c fix/xxx upstream/main     # 基于上游最新代码
# 改代码、自测（app: npx tsc --noEmit && npx eslint src；server: npx tsc --noEmit -p .）
git push origin fix/xxx
gh pr create -R github.com/genguzzz/mediahub-oss --base main --head <你的用户名>:fix/xxx
```

PR 里同样只能有占位值。合并后用 `./scripts/update.sh` 拉回你的 `main`。

## 7. 口令与令牌的轮换

| 要换的 | 做法 |
|---|---|
| `IPA_PASSPHRASE` | 改 `secrets.env`（`openssl rand -hex 32`）→ `instance.sh ci`。旧的加密 artifact 用新口令解不开，重新编译即可 |
| 后端 `APP_TOKEN` / `ADMIN_TOKEN` | 改服务器 `/opt/mediahub/.env` 并重启 `mediahub`；App 设置页填新的 `APP_TOKEN`。脚本通过 `ADMIN_TOKEN_CMD` 现场读取，本机无需改 |
| 发布服务令牌 | 改发布服务那边；用 `PUBLISH_TOKEN_CMD` 的话本机无需改 |
| 换域名 / bundle id | 改 `instance.env` → `instance.sh ci` → 发新 IPA。bundle id 变了等于新 App，需要重新安装；`APP_SERVER` 变了，旧 IPA 收不到新地址上的 OTA |

## 8. 上游维护者

上游仓库本身也按同一套方式发布作者自己的版本（`origin` 就是上游，所以 `init` 不添加 `upstream`，也不需要 `update.sh`）。作者的私有值同样只在作者的实例目录和本仓库的 Secrets 里；公开 Release 只有说明，没有作者的 IPA。
