# DeepSeek Harness（dsh）本地工作区

当前目录是一个自包含的 dsh 安装：CLI 和 pnpm 都在本项目的 `node_modules/` 里，版本由
`package.json` 锁定，升级与插件管理都有现成命令。

- 已安装：`@deepseek-ai/dsh` **0.2.2-rc.3**（npm `next`，对应 GitHub 最新 release）
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
./bin/dsh --version          # 0.2.2-rc.3
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
- 托盘菜单：打开主窗口 / 在浏览器中打开 / 重启服务 / 关于 / 退出。
- 再次从应用菜单启动会唤醒已运行窗口（单实例），不会重复起服务。
- 只有托盘里的 **退出**（或 `Ctrl+Q`）才会停止 dsh 服务。

相关文件与日志：

| 路径 | 说明 |
|---|---|
| `desktop/main.mjs` | Electron 主进程：启动/停止 dsh、窗口、托盘、单实例 |
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
dist-desktop/DeepSeek-Harness-1.0.0-x86_64.AppImage   # 约 355 MB
```

直接运行（或 chmod 后在文件管理器双击）：

```bash
chmod +x dist-desktop/DeepSeek-Harness-1.0.0-x86_64.AppImage
./dist-desktop/DeepSeek-Harness-1.0.0-x86_64.AppImage
```

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
  ./DeepSeek-Harness-1.0.0-x86_64.AppImage --appimage-extract-and-run
  ```
- AppImage 自带 Node、dsh、pnpm，但不自带 glibc。本地构建使用当前系统（Ubuntu 26.04，glibc 2.43）；
  GitHub Actions 使用 Ubuntu 24.04（glibc 2.39）。目标系统的 glibc 不能低于构建机。
- 本机 AppArmor 限制下 AppImage 会自动使用 `--no-sandbox`（AppRun 检测 + desktop 入口参数）。
- AppImage **不会自动更新**。升级 dsh 或插件后需要重新执行 `npm run appimage` 生成新包；新包仍使用
  同一份 `~/.dsh` 用户数据。
- 重新打包前建议先退出正在运行的桌面客户端，否则新 AppImage 可能只是唤醒旧实例。

## 版本更新

```bash
npm run update:check         # 查看 npm 上的 latest / next / alpha
npm run update               # 升级到 next（默认，跟踪 GitHub 最新 release）
npm run update:latest        # 升级到 npm latest（当前仍为 0.2.2-rc.1）
./bin/dsh --version          # 验证
```

- 当前上游的 GitHub release 已到 `0.2.2-rc.3`，但 npm `latest` 标签仍停在
  `0.2.2-rc.1`；因此本项目默认跟踪 `next`。只有需要回退到 npm `latest` 时才用
  `npm run update:latest`。
- 升级会改写 `package.json` 中的精确版本，`package-lock.json` 保证可复现。
- 回滚：`npm install -D -E @deepseek-ai/dsh@<旧版本>`。
- 如果升级后 npm 提示 `install scripts not yet covered by allowScripts`，先审查再放行并重建：
  ```bash
  npm install-scripts ls
  npm install-scripts approve <pkg> [<pkg> ...]
  npm rebuild <pkg>
  ```
- 升级 dsh 后，已装插件也要匹配新版本（见下一节），dsh 启动时会做兼容性检查。
- 如果使用 AppImage，升级后需要重新执行 `npm run appimage` 生成新包（AppImage 不会自动更新）。

## GitHub Actions 自动更新与发布

[`.github/workflows/update-dsh.yml`](.github/workflows/update-dsh.yml) 每 6 小时检查一次
[`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness) 的
`dsh-v*` release，并在发现新版本时自动：

1. 确认 npm 上存在对应版本的 `@deepseek-ai/dsh`；
2. 更新 `package.json`、`package-lock.json` 和 README 中的版本号；
3. 重新安装依赖并执行 `npm run appimage`；
4. 校验 AppImage 内置的 dsh 版本，计算 SHA256；
5. 提交变更并推送 `main`；
6. 创建或更新标签为 `dsh-v<version>` 的 GitHub Release，上传 AppImage 和 `.sha256`。

也可以在 Actions 页面手动触发 **Update dsh and release AppImage**：

- `version` 留空：自动选择官方最新 release；
- 指定 `version`：构建并发布指定版本，例如 `0.2.2-rc.3`；
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
- 自动提交作者为 `github-actions[bot]`，提交信息格式为 `chore: update dsh to <version>`。

## 插件管理

dsh 插件按 profile 隔离。命令会转发给 pnpm，在对应 profile 目录中执行：

```bash
# 查看
./bin/dsh plugin --profile web list
./bin/dsh plugin --profile web outdated        # 可升级的依赖

# 安装 / 升级到指定版本（推荐显式写版本）
./bin/dsh plugin --profile web add @deepseek-ai/dsh-experimental-plugin-market-bundle@0.2.2-rc.3

# 移除
./bin/dsh plugin --profile web remove <package>

# 用 npm 脚本等价调用（注意 -- 后面的参数原样转发）
npm run plugin -- --profile web list
```

### 版本必须与 dsh 匹配

不少官方插件包的 npm `latest` 标签还停在 `0.0.1-rc.x` / `0.1.0-rc.x`，与本机
`dsh 0.2.2-rc.3` 不兼容，直接 `add <pkg>` 会被拒绝。请先查标签，再显式安装同一代的版本：

```bash
npm view @deepseek-ai/<plugin> dist-tags --json
./bin/dsh plugin --profile web add @deepseek-ai/<plugin>@0.2.2-rc.3
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
  --dsh-version 0.2.2-rc.3 --accept-risk
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

1. `npm install -D` 安装 `@deepseek-ai/dsh@0.2.2-rc.3`、`pnpm@12.21.0`、`electron@45.3.2`
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
