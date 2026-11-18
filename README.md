# DeepSeek Harness（dsh）本地工作区

当前目录是一个自包含的 dsh 安装：CLI 和 pnpm 都在本项目的 `node_modules/` 里，版本由
`package.json` 锁定，升级与插件管理都有现成命令。

- 已安装：`@deepseek-ai/dsh` **0.2.2-rc.5**（npm `next`，对应 GitHub 最新 release）
- 桌面客户端：Electron 壳 + 内置 dsh，AppImage 支持自动更新
- Node 要求：`>= 24.9.0`（当前 `v24.22.2`）
- 用户数据：默认 `~/.dsh`（profiles、sessions、凭证），可用 `DSH_HOME` 覆盖

```text
.
├── bin/dsh          # 包装脚本：自动把 node_modules/.bin（含 pnpm）加入 PATH
├── desktop/         # Electron 桌面壳（主进程、启动页、图标、打包配置）
├── scripts/         # 桌面启动脚本
├── runtime/         # 构建时生成：AppImage 内置运行时（已被 git 忽略）
├── dist-desktop/    # 构建产物：AppImage（已被 git 忽略）
├── package.json     # 固定版本、更新、插件与桌面脚本
├── package-lock.json
└── node_modules/    # dsh + pnpm + electron + electron-builder
```

> 说明：dsh 的“插件”安装在各 profile 中（`~/.dsh/profiles/<profile>/`），不是装进本项目；
> 本项目的 `node_modules` 只负责 CLI 和它的包管理器。

## 快速开始

```bash
./bin/dsh --version          # 0.2.2-rc.5
./bin/dsh --help

./bin/dsh web                # Web UI（首次使用自动初始化 web profile）
./bin/dsh tui                # 终端界面
./bin/dsh headless "列出当前目录的文件"
```

也可以使用 npm 脚本：

```bash
npm run web
npm run tui
npm run dsh -- --help        # npm run dsh -- <任意 dsh 参数>
```

已有 profile 列表：`ls ~/.dsh/profiles`。`web/tui/headless/acp/sdk` 首次使用时自动创建。

## 桌面客户端（Linux / Electron）

官方 Desktop 只发布 **Windows x64 和 macOS** 版本，没有 Linux 版。本项目自带一个
Electron 桌面壳，把本地 Web UI 封装成原生窗口，并自动管理 `dsh web` 进程：

```bash
npm run desktop              # 前台启动（日志直接输出到终端）
npm run desktop:shortcut     # 安装应用菜单入口（只需执行一次）
```

装好后在 GNOME 应用列表搜索 **DeepSeek Harness** 即可启动。

行为：

- 启动时自动拉起 `dsh web`（绑定 `127.0.0.1` 的随机端口，带 token），加载完成后显示主窗口。
- **关闭窗口 = 最小化到托盘**，服务继续在后台运行；首次隐藏会发一条通知。
- 托盘菜单：打开主窗口 / 在浏览器中打开 / 检查更新 / 重启服务 / 关于 / 退出。
- 再次从应用菜单启动会唤醒已运行窗口（单实例），不会重复起服务。
- 只有托盘里的 **退出**（或 `Ctrl+Q`）才会停止 dsh 服务。

相关文件与日志：

| 路径 | 说明 |
|---|---|
| `desktop/main.mjs` | Electron 主进程：启动/停止 dsh、窗口、托盘、单实例、更新界面 |
| `desktop/updater.mjs` | 版本比较、GitHub Release 检查、下载与 AppImage 替换 |
| `desktop/splash.html` | 启动画面 |
| `desktop/assets/` | 官方 DeepSeek Harness 图标 |
| `scripts/desktop-launch.sh` | 应用菜单实际执行的启动脚本 |
| `~/.local/state/deepseek-harness/desktop.log` | 桌面壳日志 |
| `~/.local/state/deepseek-harness/server.log` | dsh 服务日志 |

注意：

- 这是“本机壳”，不是独立安装包：使用项目内的 dsh 和系统 Node，移动项目目录后需要重新
  执行 `npm run desktop:shortcut`。
- Ubuntu 24.10+ 的 AppArmor 会限制 Chromium 的 unprivileged user namespace，Electron 需要
  SUID sandbox。本机已执行过授权；重装或升级 Electron 后如果报
  `SUID sandbox helper ... is not configured correctly`，执行：
  ```bash
  sudo chown root:root node_modules/electron/dist/chrome-sandbox
  sudo chmod 4755 node_modules/electron/dist/chrome-sandbox
  ```
- Windows/macOS 请使用官方桌面端：<https://deepseek.com/harness>。

## 打包 AppImage（可分发单文件）

AppImage 是**自包含**的：里面打包了系统 Node、dsh、pnpm 和全部运行时依赖，不依赖本项目目录，
也不要求目标机器预装 Node。Electron 打包工具链本身不会被打进去。

```bash
npm run appimage
```

产物：

```text
dist-desktop/DeepSeek-Harness-0.2.2-rc.5-x86_64.AppImage   # 约 355 MB
```

直接运行（或 chmod 后在文件管理器双击）：

```bash
chmod +x dist-desktop/DeepSeek-Harness-0.2.2-rc.5-x86_64.AppImage
./dist-desktop/DeepSeek-Harness-0.2.2-rc.5-x86_64.AppImage
```

### 安装到应用菜单（可选）

如果希望从应用菜单启动，而不是每次手动运行 AppImage：

```bash
desktop/install-appimage.sh ~/Applications/DeepSeek-Harness-0.2.2-rc.5-x86_64.AppImage
```

脚本会安装多尺寸图标到 `~/.local/share/icons/hicolor`，并生成
`~/.local/share/applications/deepseek-harness.desktop`。桌面入口使用图标的绝对路径，
不依赖图标主题缓存，避免任务栏或应用菜单显示齿轮占位图。升级后如果 AppImage
文件名变化，重新执行一次即可；不带参数时会自动选择 `~/Applications` 里最新的 AppImage。

> 如果任务栏仍显示旧图标，注销并重新登录一次，GNOME Shell 会刷新内存中的图标缓存。

构建过程：

1. `desktop/prepare-runtime.sh` 把 `/usr/bin/node`（ABI 与当前原生模块一致）和项目
   `node_modules` 复制到 `runtime/`，并排除 Electron 与 electron-builder 工具链。
2. `electron-builder` 把 Electron 应用和 `runtime/` 一起压成 AppImage。
3. 运行时挂载在 `/tmp/.mount_*`，dsh 使用挂载卷内的 Node 和 `node_modules`，不会读写项目目录。
   AppImage 中 dsh 的默认工作目录是用户主目录（挂载卷是只读的），可在 Web UI 里切换到实际项目目录。

说明：

- 用户数据仍在 `~/.dsh`；日志仍在 `~/.local/state/deepseek-harness/`。删除 AppImage 不会删除会话和登录态。
- Ubuntu 24.10 / 26.04 运行 AppImage 需要 FUSE2：`sudo apt install libfuse2t64`。没有 FUSE 时用：
  ```bash
  ./DeepSeek-Harness-0.2.2-rc.5-x86_64.AppImage --appimage-extract-and-run
  ```
- AppImage 自带 Node、dsh、pnpm，但不自带 glibc。本地构建使用当前系统（Ubuntu 26.04，glibc 2.43）；
  GitHub Actions 使用 Ubuntu 24.04（glibc 2.39）。目标系统的 glibc 不能低于构建机。
- 本机 AppArmor 限制下 AppImage 会自动使用 `--no-sandbox`（AppRun 检测 + desktop 入口参数）。
- AppImage 内置自动更新：启动后会自动检查 GitHub Release，也可从托盘或帮助菜单手动检查。
  更新只替换 AppImage 文件，仍使用同一份 `~/.dsh` 用户数据。
- 重新打包前建议先退出正在运行的桌面客户端，否则新 AppImage 可能只是唤醒旧实例。

## 客户端自动更新

客户端版本直接采用内置 dsh 版本，Release 标签也使用官方命名 `dsh-v<version>`。例如官方
`dsh-v0.2.2-rc.5` 对应应用版本 `0.2.2-rc.5` 和
`DeepSeek-Harness-0.2.2-rc.5-x86_64.AppImage`，不再单独维护客户端版本号。

AppImage 启动约 15 秒后检查 GitHub Releases 的 `dsh-v*` 标签，之后每 6 小时检查一次；
系统从睡眠恢复时也会补查。发现新版本后：

1. 托盘菜单显示 **安装更新 `<version>`**，并发送系统通知；
2. 用户确认后下载对应的完整 `DeepSeek-Harness-<version>-x86_64.AppImage`；
3. 用 Release 附带的 `.sha256` 校验下载内容；
4. 原子替换当前 AppImage，停止 dsh 服务并自动重启客户端。

更新在应用内完成，但下载和替换的是完整客户端；也可以直接从 Release 页面手动下载 AppImage
覆盖安装。两种方式都使用同一份 `~/.dsh` 用户数据。

手动入口：

- 托盘菜单 → **检查更新**
- 菜单栏 **帮助 → 检查更新**
- **帮助 → 自动检查更新** 可以关闭或重新开启自动检查（默认开启）

几个细节：

- 更新采用“替换当前文件”的方式，AppImage 文件名不会改变；实际版本可在 **关于** 中查看。
- 更新包会先写入当前 AppImage 同目录再替换。若该目录不可写，则下载到
  `~/.local/state/deepseek-harness/updates/` 并提示手动替换。
- 校验失败会删除下载文件，不会替换正在运行的客户端。
- 更新状态保存在 `~/.local/state/deepseek-harness/update-state.json`。
- 更新器逻辑有独立测试：`npm run test:updater`。
- 因为客户端版本跟随 dsh，客户端代码的单独修复不会自动产生新版本；需要覆盖同一版本的
  Release，或等待下一个官方 dsh 版本。覆盖同一版本后，已安装同版本的用户不会收到自动更新提示。
- 从旧的 `1.0.0` / `1.1.0` 客户端迁移时，需要手动安装一次 `0.2.2-rc.5`：旧版本号高于
  `0.2.2-rc.5`，更新器不会自动降级。

### 更新源与 token

默认更新源是 `qiaodapei/deepseek-harness-linux`，仓库已经设为**公开**，客户端无需登录即可检查更新。
如果使用私有镜像或私有 fork，需要给每台机器配置只读 token：

```bash
mkdir -p ~/.config/deepseek-harness
printf '%s' '<github-token>' > ~/.config/deepseek-harness/github-token
chmod 600 ~/.config/deepseek-harness/github-token
```

也可以使用环境变量 `DSH_UPDATE_TOKEN`（优先级最高）。Fine-grained token 至少需要该仓库的
**Contents: Read** 权限。

调试或使用镜像时还可以设置：

```bash
DSH_UPDATE_REPO=owner/repo          # 覆盖更新源仓库
DSH_DISABLE_UPDATE_CHECK=1          # 完全禁用自动检查（手动检查仍可用）
DSH_UPDATE_CHECK_DELAY_MS=5000      # 调整启动后首次检查延迟
```

## 版本更新

```bash
npm run update:check         # 查看 npm 上的 latest / next / alpha
npm run update               # 升级到 next（默认，跟踪 GitHub 最新 release）
npm run update:latest        # 升级到 npm latest（当前仍为 0.2.2-rc.1）
./bin/dsh --version          # 验证
```

- 当前上游的 GitHub release 已到 `0.2.2-rc.5`，但 npm `latest` 标签仍停在
  `0.2.2-rc.1`；因此本项目默认跟踪 `next`。只有需要回退到 npm `latest` 时才用
  `npm run update:latest`。
- 升级会改写 `package.json` 中的精确版本，`package-lock.json` 保证可复现。
- 应用版本与内置 dsh 版本保持一致。手动升级 dsh 后执行
  `npm version "$(./bin/dsh --version)" --no-git-tag-version`；Actions 工作流会自动完成这一步。
- 回滚：`npm install -D -E @deepseek-ai/dsh@<旧版本>`，然后用 `npm version` 同步应用版本。
- 如果升级后 npm 提示 `install scripts not yet covered by allowScripts`，先审查再放行并重建：
  ```bash
  npm install-scripts ls
  npm install-scripts approve <pkg> [<pkg> ...]
  npm rebuild <pkg>
  ```
- 升级 dsh 后，已装插件也要匹配新版本（见下一节），dsh 启动时会做兼容性检查。
- 如果使用 AppImage，发布新的 GitHub Release 后客户端会自动提示更新；本地开发构建仍可用
  `npm run appimage` 生成新包。

## GitHub Actions 自动更新与发布

[`.github/workflows/update-dsh.yml`](.github/workflows/update-dsh.yml) 每 6 小时检查一次
[`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) 的
`dsh-v*` release。发现新 dsh 版本时自动：

1. 确认 npm 上存在对应版本的 `@deepseek-ai/dsh`；
2. 把 `package.json` / `package-lock.json` 的应用版本对齐到该 dsh 版本；
3. 更新 README 中的 dsh 版本和 AppImage 文件名；
4. 重新安装依赖并执行 `npm run appimage`；
5. 校验 AppImage 文件名、内置 dsh 版本，并计算 SHA256；
6. 提交变更并推送 `main`；
7. 创建或更新标签为 `dsh-v<version>` 的 GitHub Release，上传 AppImage 和 `.sha256`。

版本规则：客户端版本 = 内置 dsh 版本 = Release 标签去掉 `dsh-v` 前缀。例如官方
`dsh-v0.2.2-rc.5` 对应客户端 `0.2.2-rc.5`、AppImage
`DeepSeek-Harness-0.2.2-rc.5-x86_64.AppImage` 和 GitHub Release 标签 `dsh-v0.2.2-rc.5`。
Release 标题为 `DeepSeek Harness 0.2.2-rc.5`，不再有独立的客户端版本号。客户端更新器
只识别 `dsh-v*` 标签。

也可以在 Actions 页面手动触发 **Update dsh and release AppImage**：

- `version` 留空：自动选择官方最新 release；
- 指定 `version`：构建并发布指定 dsh 版本，例如 `0.2.2-rc.5`；
- `force`：即使版本未变化也重新构建，并覆盖已有 Release 附件。

也可以用 `repository_dispatch` 触发（只需要 `Contents: write` 权限）：

```bash
gh api -X POST repos/qiaodapei/deepseek-harness-linux/dispatches -f event_type=update-dsh
```

注意事项：

- 工作流使用 `GITHUB_TOKEN`，需要 `contents: write` 权限（已在工作流中声明）。
- 如果新版本引入了未审核的 npm 安装脚本，工作流会失败。此时在本地执行
  `npm install-scripts approve <pkg>`，提交 `package.json` 后重新触发。
- 自动构建运行在 `ubuntu-24.04`，产物体积较大（当前约 355 MB），Release 附件上限为 2 GiB。
- 自动提交作者为 `github-actions[bot]`，提交信息格式为 `chore: release <version>`。
- 客户端版本跟随 dsh，因此只修改客户端代码时不会单独产生新版本。需要分发这类修复时，可以用
  `force=true` 覆盖同一版本的 Release；已经安装同版本的用户不会收到自动更新提示，需要手动重新下载。

## 插件管理

dsh 插件按 profile 隔离。命令会转发给 pnpm，在对应 profile 目录中执行：

```bash
# 查看
./bin/dsh plugin --profile web list
./bin/dsh plugin --profile web outdated        # 可升级的依赖

# 安装 / 升级到指定版本（推荐显式写版本）
./bin/dsh plugin --profile web add @deepseek-ai/dsh-experimental-plugin-market-bundle@0.2.2-rc.5

# 移除
./bin/dsh plugin --profile web remove <package>

# 用 npm 脚本等价调用（注意 -- 后面的参数原样转发）
npm run plugin -- --profile web list
```

### 版本必须与 dsh 匹配

不少官方插件包的 npm `latest` 标签还停在 `0.0.1-rc.x` / `0.1.0-rc.x`，与本机
`dsh 0.2.2-rc.5` 不兼容，直接 `add <pkg>` 会被拒绝。请先查标签，再显式安装同一代的版本：

```bash
npm view @deepseek-ai/<plugin> dist-tags --json
./bin/dsh plugin --profile web add @deepseek-ai/<plugin>@0.2.2-rc.5
```

### bundle 插件 vs 普通插件

- **bundle**（包的 `package.json` 里有 `dsh.bundle`）：安装后自动加入 profile 的层列表并生效。
  例如官方插件市场 bundle：`@deepseek-ai/dsh-experimental-plugin-market-bundle`，装好后 Web 侧边栏
  会出现 **Discover**，可浏览插件索引并直接安装 bundle。
- **普通插件**（无 `dsh.bundle`）：只作为依赖安装，CLI 会提示
  `declares no dsh.bundle — installed as a plain dependency`。还需要在
  `~/.dsh/profiles/<profile>/cordis.patch.yml` 中挂载，例如：

  ```yaml
  - insert:
      - id: time-context
        name: '@deepseek-ai/dsh-time-context'
  ```

  保存后重启 dsh（或由 HMR 热加载）。

Web 端也可以直接在侧边栏 **Plugins** 页面启用/禁用插件和 bundle。

### 兼容性豁免（慎用）

只有当确认风险并必须使用不兼容版本时：

```bash
./bin/dsh plugin --profile web allow-version <pkg>@<version> \
  --dsh-version 0.2.2-rc.5 --accept-risk
```

豁免只对“精确包版本 + 精确 dsh 版本”有效，升级 dsh 或插件后需要重新授权。

## 可选：全局命令

```bash
npm run link                 # npm link，之后可在任意目录执行 dsh
```

`npm link` 指向本项目的包装脚本，但全局 dsh 找不到项目内的 pnpm，插件命令可能失败；
更推荐始终使用 `./bin/dsh` 或 `npm run ...`。

## DSH_HOME（数据目录）

默认使用 `~/.dsh`。如需让数据完全落在项目内：

```bash
DSH_HOME="$PWD/.dsh" ./bin/dsh web
```

注意这会使用一套全新的 profile / 凭证；现有登录态和 web profile 仍在 `~/.dsh`。

## 安装时做了什么

1. `npm install -D` 安装 `@deepseek-ai/dsh@0.2.2-rc.5`、`pnpm@12.21.0`、`electron@45.3.2`
   和 `electron-builder@26.18.0`（本地，未污染全局）。
2. 用 `npm install-scripts approve` 放行依赖的安装脚本（`allowScripts` 已写入 `package.json`）。
3. 配置 Electron SUID sandbox，并安装应用菜单入口 `~/.local/share/applications/deepseek-harness.desktop`。
4. 验证了 CLI、profile 组合、插件增删、桌面壳启动/关闭，以及 AppImage 的 Web UI 加载、
   内置 dsh/Node/pnpm 调用和进程清理；验证过程初始化了 `~/.dsh/profiles/tui`
   （当前为空 profile），原有的 `~/.dsh/profiles/web` 未改动。

## 卸载

```bash
rm -rf node_modules package-lock.json
```

用户数据（profile、会话、凭证）在 `~/.dsh`，需要时另行删除。
