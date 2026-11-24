import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  nativeImage,
  Notification,
  dialog,
  screen,
  shell,
  powerMonitor,
  ipcMain,
  session,
} from 'electron'
import { spawn } from 'node:child_process'
import {
  createWriteStream,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { rm } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { format } from 'node:util'
import {
  DEFAULT_REPO,
  compareVersions,
  downloadAssetToFile,
  ensureFreeSpace,
  fetchAssetText,
  fetchLatestNpmVersion,
  fetchReleases,
  formatBytes,
  installAppImage,
  isDirectoryWritable,
  isStableChannelVersion,
  parseSha256,
  readInstalledDshVersion,
  readUpdateState,
  selectLatestRelease,
  writeUpdateState,
} from './updater.mjs'
import {
  DEFAULT_REGISTRY,
  FALLBACK_REGISTRY,
  activateRuntime,
  clearRuntimeBroken,
  installRuntimeVersion,
  isValidRuntime,
  markRuntimeBroken,
  pruneRuntimeVersions,
  readDshVersion,
  removeStaleRuntimeDirs,
  resolveActiveRuntime,
  resolveDataDir,
  runtimeLayout,
} from './runtime.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const runtimeDir = app.isPackaged ? join(process.resourcesPath, 'runtime') : ''
const bundledProjectRoot =
  process.env.DSH_DESKTOP_PROJECT_ROOT || (runtimeDir ? join(runtimeDir, 'app') : dirname(here))
const dataDir = resolveDataDir()
let activeRuntime = app.isPackaged
  ? resolveActiveRuntime({ bundledRoot: bundledProjectRoot, dataDir })
  : {
      root: bundledProjectRoot,
      version: readDshVersion(bundledProjectRoot) || app.getVersion(),
      source: 'bundled',
      layout: runtimeLayout(dataDir),
    }
let projectRoot = activeRuntime.root
const serverCwd = process.env.DSH_DESKTOP_CWD || (app.isPackaged ? homedir() : projectRoot)
const bundledPnpm = runtimeDir ? join(runtimeDir, 'app', 'node_modules', '.bin', 'pnpm') : ''
const bundledNode = runtimeDir ? join(runtimeDir, 'node', 'bin', 'node') : process.execPath
const runtimeRegistries = process.env.DSH_NPM_REGISTRY
  ? [process.env.DSH_NPM_REGISTRY]
  : [DEFAULT_REGISTRY, FALLBACK_REGISTRY]
const staticDir = app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked', 'desktop') : here
const preloadFile = app.isPackaged ? join(app.getAppPath(), 'desktop', 'preload.cjs') : join(here, 'preload.cjs')
const splashFile = join(staticDir, 'splash.html')
const iconFile = join(staticDir, 'assets', 'icon.png')
const trayIconFile = join(staticDir, 'assets', 'tray.png')
const stateDir = join(process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'deepseek-harness')
const serverLog = join(stateDir, 'server.log')
const smokePath = process.env.DSH_DESKTOP_SMOKE || ''
const updateRepo = process.env.DSH_UPDATE_REPO || DEFAULT_REPO
const updateStateFile = join(stateDir, 'update-state.json')
const updateCacheDir = join(stateDir, 'updates')
const updateTokenFile = join(
  process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
  'deepseek-harness',
  'github-token',
)
const updateCheckIntervalMs = 60 * 60 * 1000
const updateCheckDelayMs = (() => {
  const value = Number(process.env.DSH_UPDATE_CHECK_DELAY_MS)
  return Number.isFinite(value) && value >= 0 ? value : 15_000
})()
const updateChecksDisabled = process.env.DSH_DISABLE_UPDATE_CHECK === '1'
// Passed to the process spawned by relaunchAppImage(). The old instance is
// still shutting down and holds the single-instance lock, so the new instance
// must wait briefly instead of quitting immediately.
const RELAUNCH_WAIT_FLAG = '--dsh-relaunch-wait'

app.setName('DeepSeek Harness')
app.commandLine.appendSwitch('class', 'deepseek-harness')
if (process.env.WAYLAND_DISPLAY && process.env.XDG_SESSION_TYPE !== 'x11') {
  app.commandLine.appendSwitch('ozone-platform', 'wayland')
  // Chromium's native Wayland backend only talks to the compositor's
  // text-input protocol when this switch is present. Without it ibus/fcitx
  // never receive composition events, so Chinese/Japanese/Korean input
  // silently degrades to plain ASCII key presses.
  app.commandLine.appendSwitch('enable-wayland-ime')
  app.commandLine.appendSwitch('wayland-text-input-version', '3')
} else {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto')
}

const windowStateFile = join(app.getPath('userData'), 'window-state.json')

let win = null
let tray = null
let serverChild = null
let serverUrl = null
let quitting = false
let cleanupDone = false
let restarting = false
let notifiedHidden = false

let updateState = readUpdateState(updateStateFile)
let updateStatus = {
  phase: 'idle',
  latest: null,
  error: null,
  progress: 0,
  total: 0,
  runtimeAvailable: false,
  shellAvailable: false,
}
let updateTimer = null
let checkPromise = null
let downloadController = null
let lastUpdateUiAt = 0
let installedDshVersion = ''
const activeNotifications = new Set()

// A desktop launcher may close stdout/stderr when its parent process exits.
// Logging is best-effort and must never crash the main process with EPIPE.
function safeWrite(stream, data) {
  if (!stream || stream.destroyed || stream.writable === false) return false
  try {
    return stream.write(data)
  } catch (error) {
    if (error?.code === 'EPIPE') return false
    throw error
  }
}

for (const stream of [process.stdout, process.stderr]) {
  stream?.on?.('error', () => {})
}

const log = (...args) =>
  safeWrite(process.stdout, `[${new Date().toISOString()}] ${format(...args)}\n`)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function currentAppVersion() {
  return process.env.DSH_UPDATE_CURRENT_VERSION || getInstalledDshVersion() || app.getVersion()
}

function currentShellVersion() {
  return app.getVersion()
}

function updateTargets(version) {
  let runtimeAvailable = false
  let shellAvailable = false
  try {
    runtimeAvailable = compareVersions(version, currentAppVersion()) > 0
  } catch {}
  try {
    shellAvailable = compareVersions(version, currentShellVersion()) > 0
  } catch {}
  return { runtimeAvailable, shellAvailable }
}

function getInstalledDshVersion() {
  if (!installedDshVersion) {
    installedDshVersion =
      activeRuntime.version && activeRuntime.version !== 'unknown'
        ? activeRuntime.version
        : readInstalledDshVersion(projectRoot, app.getVersion())
  }
  return installedDshVersion
}

function useRuntime(runtime) {
  activeRuntime = runtime
  projectRoot = runtime.root
  installedDshVersion =
    (runtime.version && runtime.version !== 'unknown' ? runtime.version : '') ||
    readDshVersion(runtime.root) ||
    installedDshVersion
  return runtime
}

function readUpdateToken() {
  for (const name of ['DSH_UPDATE_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN']) {
    const value = process.env[name]
    if (value && value.trim()) return value.trim()
  }
  try {
    return readFileSync(updateTokenFile, 'utf8').trim()
  } catch {
    return ''
  }
}

function autoCheckEnabled() {
  return !updateChecksDisabled && updateState.autoCheck !== false
}

let persistQueue = Promise.resolve()
function persistUpdateState() {
  const snapshot = JSON.parse(JSON.stringify(updateState))
  persistQueue = persistQueue
    .catch(() => {})
    .then(() => writeUpdateState(updateStateFile, snapshot))
    .catch((error) => log('failed to save update state:', error.message))
  return persistQueue
}

function cacheRelease(release) {
  if (!release) return null
  return {
    ...release,
    notes: String(release.notes || '').slice(0, 4000),
  }
}

function setUpdateStatus(patch) {
  updateStatus = { ...updateStatus, ...patch }
  refreshMenus()
  sendUpdateStatusToRenderer()
}

// Serializable update-state view for the in-window update dialog (notes are
// flattened to plain text; the raw markdown never reaches the page).
function updateStatusSnapshot() {
  const { phase, latest, error, progress, total, runtimeAvailable, shellAvailable } = updateStatus
  return {
    phase,
    error: error ?? null,
    progress,
    total,
    current: currentAppVersion(),
    currentRuntime: currentAppVersion(),
    currentShell: currentShellVersion(),
    runtimeAvailable: Boolean(runtimeAvailable),
    shellAvailable: Boolean(shellAvailable),
    latest: latest
      ? { ...latest, notes: plainNotes(latest.notes) }
      : null,
  }
}

function sendUpdateStatusToRenderer() {
  if (win === null || win.isDestroyed()) return
  try {
    win.webContents.send('dsh-desktop:update-status', updateStatusSnapshot())
  } catch {}
}

// Opens the in-window update dialog (rendered by the preload overlay).
function showUpdateOverlay() {
  showWindow()
  if (win === null || win.isDestroyed()) return
  try {
    win.webContents.send('dsh-desktop:update-dialog', {
      open: true,
      status: updateStatusSnapshot(),
    })
  } catch {}
}

function reportUpdateProgress(received, total) {
  updateStatus.progress = received
  if (total > 0) updateStatus.total = total
  const now = Date.now()
  if (now - lastUpdateUiAt >= 500) {
    lastUpdateUiAt = now
    refreshMenus()
    sendUpdateStatusToRenderer()
  }
}

function plainNotes(notes) {
  let text = String(notes || '')
    .replace(/<[^>]+>/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/`{1,3}/g, '')
    .replace(/\r/g, '')
    .trim()
  if (text.length > 1800) text = `${text.slice(0, 1800)}…`
  return text || '（无更新说明）'
}

function showMessageBox(options) {
  if (win && !win.isDestroyed()) return dialog.showMessageBox(win, options)
  return dialog.showMessageBox(options)
}

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return
  try {
    const notification = new Notification({
      title,
      body,
      icon: nativeImage.createFromPath(iconFile),
    })
    activeNotifications.add(notification)
    notification.on('close', () => activeNotifications.delete(notification))
    if (onClick) {
      notification.on('click', () => {
        activeNotifications.delete(notification)
        onClick()
      })
    }
    notification.show()
  } catch (error) {
    log('notification failed:', error.message)
  }
}

function updateEntryLabel() {
  const { phase, latest, progress, total, runtimeAvailable } = updateStatus
  if (phase === 'checking') return '正在检查更新…'
  if (phase === 'downloading') {
    if (total > 0) {
      return `正在下载更新… ${Math.min(100, Math.floor((progress / total) * 100))}%`
    }
    return '正在下载 dsh 更新…'
  }
  if (phase === 'installing') return '正在安装 dsh 更新…'
  if (phase === 'available' && latest) {
    return runtimeAvailable ? `安装更新 v${latest.version}…` : `桌面客户端更新 v${latest.version}…`
  }
  if (phase === 'error') return '重新检查更新…'
  return '检查更新…'
}

function updateMenuTemplate({ fullPackage = false } = {}) {
  const { phase } = updateStatus
  const items = [
    {
      label: updateEntryLabel(),
      enabled: !['checking', 'installing', 'downloading'].includes(phase),
      click: () => {
        if (phase === 'available') showUpdateOverlay()
        else if (!['checking', 'installing', 'downloading'].includes(phase)) {
          checkForUpdates({ manual: true, force: true })
        }
      },
    },
  ]
  if (phase === 'downloading') {
    items.push({ label: '取消下载', click: cancelUpdateDownload })
  } else if (
    fullPackage &&
    phase === 'available' &&
    updateStatus.latest?.appImage &&
    updateStatus.latest?.shaAsset
  ) {
    items.push({
      label: updateStatus.shellAvailable
        ? `下载完整安装包 v${updateStatus.latest.version}…`
        : '下载完整安装包（可选）…',
      click: () => downloadAndInstallFullUpdate(),
    })
  }
  return items
}

function autoCheckMenuItem() {
  return {
    label: '自动检查更新',
    type: 'checkbox',
    checked: autoCheckEnabled(),
    enabled: !updateChecksDisabled,
    click: (item) => toggleAutoCheck(item.checked),
  }
}

async function toggleAutoCheck(checked) {
  updateState.autoCheck = Boolean(checked)
  await persistUpdateState()
  scheduleUpdateChecks()
  refreshMenus()
  if (checked) checkForUpdates({ automatic: true, force: true })
}

function updateTrayTooltip() {
  if (!tray || tray.isDestroyed()) return
  let text = `DeepSeek Harness — dsh ${getInstalledDshVersion()}`
  if (updateStatus.phase === 'available' && updateStatus.latest) {
    text += ` — 可更新到 v${updateStatus.latest.version}`
  } else if (updateStatus.phase === 'downloading') {
    text += ' — 正在下载更新'
  } else if (updateStatus.phase === 'installing') {
    text += ' — 正在安装更新'
  }
  tray.setToolTip(text)
}

function updateProgressBar() {
  if (!win || win.isDestroyed()) return
  if (updateStatus.phase === 'downloading') {
    const { progress, total } = updateStatus
    win.setProgressBar(total > 0 ? Math.max(0.01, Math.min(1, progress / total)) : 2)
  } else if (updateStatus.phase === 'installing') {
    win.setProgressBar(1)
  } else {
    win.setProgressBar(-1)
  }
}

function refreshMenus() {
  if (!app.isReady()) return
  buildMenu()
  if (tray && !tray.isDestroyed()) {
    tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate()))
  }
  updateTrayTooltip()
  updateProgressBar()
}

async function fetchLatestUpdateInfo({ manual = false, force = false, token = '' } = {}) {
  // Older builds could cache an alpha/beta preview. Drop it so the stable
  // channel check does not reuse a preview release hidden behind an ETag.
  if (updateState.latestRelease && !isStableChannelVersion(updateState.latestRelease.version)) {
    updateState.latestRelease = null
    updateState.etag = ''
  }
  if (updateState.latest && !isStableChannelVersion(updateState.latest.version)) {
    updateState.latest = null
  }

  let release = null
  let githubError = null
  try {
    const result = await fetchReleases({
      repo: updateRepo,
      token,
      etag: manual || force ? '' : updateState.etag || '',
    })
    if (result.notModified) {
      release = updateState.latestRelease || null
    } else {
      updateState.etag = result.etag || ''
      release = cacheRelease(selectLatestRelease(result.releases, '0.0.0'))
      updateState.latestRelease = release
    }
  } catch (error) {
    githubError = error
    release = updateState.latestRelease || null
    log('release check failed:', error.message)
  }

  if (release && !isStableChannelVersion(release.version)) release = null

  let npm = null
  let npmError = null
  try {
    npm = await fetchLatestNpmVersion({ registries: runtimeRegistries })
  } catch (error) {
    npmError = error
    log('npm version check failed:', error.message)
  }

  let version = release?.version || null
  if (npm?.version && (!version || compareVersions(npm.version, version) > 0)) {
    version = npm.version
  }
  if (!version) throw githubError || npmError || new Error('无法获取最新版本。')

  // The Release workflow can lag a few minutes behind npm. Fetch fresh notes
  // when npm already knows about a newer version.
  if (release?.version !== version && !manual && !force && !githubError) {
    try {
      const fresh = await fetchReleases({ repo: updateRepo, token, etag: '' })
      if (!fresh.notModified) {
        const freshRelease = cacheRelease(selectLatestRelease(fresh.releases, '0.0.0'))
        updateState.etag = fresh.etag || ''
        updateState.latestRelease = freshRelease
        if (freshRelease?.version === version) release = freshRelease
      }
    } catch (error) {
      log('release refresh failed:', error.message)
    }
  }

  const matched = release?.version === version ? release : null
  return {
    latest: {
      version,
      name: matched?.name || `dsh ${version}`,
      url:
        matched?.url || `https://www.npmjs.com/package/@deepseek-ai/dsh/v/${version}`,
      notes: matched?.notes || '',
      publishedAt: matched?.publishedAt || null,
      prerelease: matched ? matched.prerelease : true,
      appImage: matched?.appImage || null,
      shaAsset: matched?.shaAsset || null,
      npmRegistry: npm?.registry || '',
    },
    npm,
  }
}

async function checkForUpdates({ manual = false, force = false } = {}) {
  if (manual) showWindow()
  if (updateStatus.phase === 'downloading' || updateStatus.phase === 'installing') {
    if (manual) showUpdateOverlay()
    return null
  }
  if (checkPromise) return checkPromise
  if (!manual && !autoCheckEnabled()) return null
  if (!manual && !force && Date.now() - updateState.lastAttempt < updateCheckIntervalMs) {
    return null
  }

  setUpdateStatus({ phase: 'checking', error: null })
  updateState.lastAttempt = Date.now()
  await persistUpdateState()
  if (manual) showUpdateOverlay()

  checkPromise = (async () => {
    const token = readUpdateToken()
    const current = currentAppVersion()
    const shellCurrent = currentShellVersion()
    try {
      const { latest: newest } = await fetchLatestUpdateInfo({ manual, force, token })
      const targets = updateTargets(newest.version)

      updateState.lastCheck = Date.now()
      updateState.latest =
        isStableChannelVersion(newest.version) &&
        (targets.runtimeAvailable || targets.shellAvailable)
          ? cacheRelease(newest)
          : null
      await persistUpdateState()

      log(
        'update check:',
        `current=v${current}`,
        `shell=v${shellCurrent}`,
        updateState.latest ? `available=v${newest.version}` : 'up-to-date',
      )

      if (updateState.latest) {
        const latest = updateState.latest
        setUpdateStatus({
          phase: 'available',
          latest,
          error: null,
          runtimeAvailable: targets.runtimeAvailable,
          shellAvailable: targets.shellAvailable,
        })
        if (manual) {
          showUpdateOverlay()
        } else if (updateState.notifiedVersion !== latest.version) {
          updateState.notifiedVersion = latest.version
          await persistUpdateState()
          const message = targets.runtimeAvailable
            ? `v${latest.version} 可用，当前 dsh 为 v${current}。点击查看并安装。`
            : `桌面客户端 v${latest.version} 可用，当前为 v${shellCurrent}。请从托盘菜单下载完整安装包。`
          notify('发现 DeepSeek Harness 更新', message, () => showUpdateOverlay())
        }
        return latest
      }

      setUpdateStatus({
        phase: 'idle',
        latest: null,
        error: null,
        runtimeAvailable: false,
        shellAvailable: false,
      })
      return null
    } catch (error) {
      log('update check failed:', error.message)
      let cached = null
      let cachedTargets = { runtimeAvailable: false, shellAvailable: false }
      try {
        if (updateState.latest && isStableChannelVersion(updateState.latest.version)) {
          const targets = updateTargets(updateState.latest.version)
          if (targets.runtimeAvailable || targets.shellAvailable) {
            cached = updateState.latest
            cachedTargets = targets
          }
        }
      } catch {}
      setUpdateStatus({
        phase: 'error',
        latest: cached,
        error: error.message,
        ...cachedTargets,
      })
      return null
    }
  })()

  try {
    return await checkPromise
  } finally {
    checkPromise = null
  }
}

async function showDownloadedDialog(release, path) {
  showWindow()
  const mode = app.isPackaged ? '当前 AppImage 所在目录不可写' : '当前是开发模式（npm run desktop）'
  const { response } = await showMessageBox({
    type: 'info',
    title: '更新已下载',
    message: `DeepSeek Harness ${release.version} 已下载`,
    detail: [
      `文件：${path}`,
      `${mode}，无法自动替换正在运行的客户端。`,
      '退出客户端后，用这个文件替换原来的 AppImage 即可。',
    ].join('\n'),
    buttons: ['打开所在文件夹', '查看发布说明', '关闭'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  })
  if (response === 0) shell.showItemInFolder(path)
  else if (response === 1) shell.openExternal(release.url)
}

async function showDownloadErrorDialog(error, path) {
  showWindow()
  const latest = updateStatus.latest
  const detail = [
    String(error?.message || error),
    path ? `文件：${path}` : '',
    '',
    latest ? `发布页面：${latest.url}` : `https://github.com/${updateRepo}/releases`,
  ]
    .filter(Boolean)
    .join('\n')

  const { response } = await showMessageBox({
    type: 'error',
    title: '完整安装包更新失败',
    message: '无法下载或安装完整 AppImage',
    detail,
    buttons: ['重试', '打开 Release 页面', '关闭'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  })
  if (response === 0) downloadAndInstallFullUpdate()
  else if (response === 1) {
    shell.openExternal(latest?.url || `https://github.com/${updateRepo}/releases`)
  }
}

function cancelUpdateDownload() {
  if (downloadController) downloadController.abort()
}

function runtimeInstallLogger() {
  let lastAt = 0
  return (line) => {
    const now = Date.now()
    if (now - lastAt < 2000 && !/(error|warn|fail)/i.test(line)) return
    lastAt = now
    log('pnpm:', line)
  }
}

async function installRuntimeUpdate(version, signal) {
  if (!app.isPackaged) {
    throw new Error('开发模式下不执行内部更新，请使用 npm run update。')
  }
  if (!bundledPnpm || !existsSync(bundledPnpm)) {
    throw new Error(`找不到内置 pnpm：${bundledPnpm || '(未打包)'}`)
  }

  const layout = runtimeLayout(dataDir)
  const target = join(layout.versions, version)
  if (isValidRuntime(target) && readDshVersion(target) === version) {
    log('runtime already installed:', version)
    return { root: target, version, reused: true }
  }

  const failures = []
  for (const registry of runtimeRegistries) {
    if (signal?.aborted) throw new Error('已取消。')
    try {
      log('installing dsh runtime:', version, 'from', registry)
      const result = await installRuntimeVersion({
        dataDir,
        version,
        pnpmBin: bundledPnpm,
        nodeBin: bundledNode,
        registry,
        signal,
        onLine: runtimeInstallLogger(),
      })
      updateState.runtimeRegistry = registry
      return result
    } catch (error) {
      if (signal?.aborted) throw error
      failures.push(`${registry}: ${error.message}`)
      log('runtime install failed:', registry, error.message)
    }
  }
  throw new Error(`无法安装 dsh ${version}。\n${failures.join('\n')}`)
}

async function downloadAndInstallUpdate() {
  const latest = updateStatus.latest
  if (!latest || downloadController) return
  if (!isStableChannelVersion(latest.version)) {
    setUpdateStatus({ phase: 'idle', latest: null, progress: 0, total: 0 })
    await showMessageBox({
      type: 'error',
      title: '无法安装预览版本',
      message: '当前客户端只跟踪官方稳定通道，不会安装 alpha/beta 版本。',
      buttons: ['确定'],
    })
    return
  }

  if (compareVersions(latest.version, currentAppVersion()) <= 0) {
    const targets = updateTargets(latest.version)
    if (targets.shellAvailable) {
      setUpdateStatus({
        phase: 'available',
        latest,
        progress: 0,
        total: 0,
        error: null,
        ...targets,
      })
      await showMessageBox({
        type: 'info',
        title: '需要更新桌面客户端',
        message: `桌面客户端 v${latest.version} 可用。`,
        detail:
          '窗口内更新只更新 dsh runtime，不会替换桌面客户端。请从托盘菜单选择「下载完整安装包」更新客户端。',
        buttons: ['确定'],
      })
      return
    }
    setUpdateStatus({
      phase: 'idle',
      latest: null,
      progress: 0,
      total: 0,
      error: null,
      runtimeAvailable: false,
      shellAvailable: false,
    })
    await showMessageBox({
      type: 'info',
      title: '无需更新',
      message: '当前 dsh 和桌面客户端都已是最新版本。',
      buttons: ['确定'],
    })
    return
  }

  const controller = new AbortController()
  downloadController = controller
  lastUpdateUiAt = 0
  setUpdateStatus({
    phase: 'downloading',
    latest,
    error: null,
    progress: 0,
    total: 0,
  })

  try {
    const result = await installRuntimeUpdate(latest.version, controller.signal)
    if (controller.signal.aborted) throw new Error('已取消。')

    setUpdateStatus({ phase: 'installing', latest, progress: 1, total: 1 })
    const previousVersion = activeRuntime.source === 'managed' ? activeRuntime.version : ''
    await activateRuntime(dataDir, latest.version)
    useRuntime(resolveActiveRuntime({ bundledRoot: bundledProjectRoot, dataDir }))
    if (activeRuntime.source !== 'managed' || activeRuntime.version !== latest.version) {
      throw new Error(`切换到 dsh ${latest.version} 失败。`)
    }

    updateState.installedVersion = latest.version
    updateState.latest = null
    updateState.runtime = {
      ...(updateState.runtime || {}),
      version: latest.version,
      previousVersion,
      installedAt: Date.now(),
      source: 'npm',
      registry: result.registry || updateState.runtimeRegistry || '',
    }
    await persistUpdateState()
    log('dsh runtime updated:', latest.version, '->', activeRuntime.root)

    try {
      await restartServer({ rethrow: true })
      await clearRuntimeBroken(dataDir, latest.version).catch(() => {})
    } catch (error) {
      log('new runtime failed to start:', error.message)
      await markRuntimeBroken(dataDir, latest.version).catch(() => {})
      const layout = runtimeLayout(dataDir)
      if (previousVersion && isValidRuntime(join(layout.versions, previousVersion))) {
        await activateRuntime(dataDir, previousVersion)
      } else {
        await rm(join(layout.root, 'current'), { force: true }).catch(() => {})
      }
      useRuntime(resolveActiveRuntime({ bundledRoot: bundledProjectRoot, dataDir }))
      await restartServer().catch(() => {})
      updateState.runtime = {
        ...(updateState.runtime || {}),
        version: activeRuntime.version,
        brokenVersion: latest.version,
      }
      await persistUpdateState()
      throw new Error(
        `dsh ${latest.version} 启动失败，已回退到 ${activeRuntime.version}。\n${error.message}`,
      )
    }

    setUpdateStatus({
      phase: 'idle',
      latest: null,
      progress: 0,
      total: 0,
      error: null,
      runtimeAvailable: false,
      shellAvailable: false,
    })
    notify('dsh 已更新', `已更新到 ${latest.version}，dsh 服务已重启。`)
    pruneRuntimeVersions(dataDir, [latest.version, previousVersion].filter(Boolean)).catch((error) =>
      log('failed to prune old runtime versions:', error.message),
    )
    setTimeout(() => checkForUpdates({ automatic: true, force: true }), 5000).unref?.()
  } catch (error) {
    const aborted =
      error?.code === 'aborted' || error?.name === 'AbortError' || controller.signal.aborted
    log('internal update failed:', error.message)
    if (aborted) {
      setUpdateStatus({ phase: 'available', latest, progress: 0, total: 0, error: null })
      notify('更新已取消', 'dsh 更新已停止。', () => showUpdateOverlay())
    } else {
      setUpdateStatus({ phase: 'error', latest, progress: 0, total: 0, error: error.message })
      showUpdateOverlay()
    }
  } finally {
    if (downloadController === controller) downloadController = null
  }
}

async function downloadAndInstallFullUpdate() {
  const latest = updateStatus.latest
  if (!latest || downloadController) return
  if (!isStableChannelVersion(latest.version)) {
    setUpdateStatus({ phase: 'idle', latest: null, progress: 0, total: 0 })
    await showMessageBox({
      type: 'error',
      title: '无法安装预览版本',
      message: '当前客户端只跟踪官方稳定通道，不会下载 alpha/beta 完整安装包。',
      buttons: ['确定'],
    })
    return
  }

  if (compareVersions(latest.version, currentShellVersion()) <= 0) {
    const targets = updateTargets(latest.version)
    if (targets.runtimeAvailable) {
      setUpdateStatus({
        phase: 'available',
        latest,
        progress: 0,
        total: 0,
        error: null,
        ...targets,
      })
      await showMessageBox({
        type: 'info',
        title: 'dsh 可在窗口内更新',
        message: `dsh v${latest.version} 可用。`,
        detail:
          '窗口内更新只更新 dsh runtime。请使用标题栏「应用 → 检查更新」或托盘菜单的「安装更新」。',
        buttons: ['确定'],
      })
      return
    }
    setUpdateStatus({
      phase: 'idle',
      latest: null,
      progress: 0,
      total: 0,
      error: null,
      runtimeAvailable: false,
      shellAvailable: false,
    })
    await showMessageBox({
      type: 'info',
      title: '无需更新',
      message: '当前桌面客户端和 dsh 都已是最新版本。',
      buttons: ['确定'],
    })
    return
  }

  if (!latest.appImage || !latest.shaAsset) {
    await showMessageBox({
      type: 'error',
      title: '无法下载完整安装包',
      message: '该版本还没有发布完整的 AppImage。',
      detail: latest.url,
      buttons: ['确定'],
    })
    return
  }

  const token = readUpdateToken()
  const appImagePath = process.env.APPIMAGE || ''
  const canInstall = Boolean(
    app.isPackaged && appImagePath && (await isDirectoryWritable(dirname(appImagePath))),
  )
  const destination = canInstall
    ? join(dirname(appImagePath), `.${basename(appImagePath)}.update`)
    : join(updateCacheDir, latest.appImage.name)

  const controller = new AbortController()
  downloadController = controller
  lastUpdateUiAt = 0
  setUpdateStatus({
    phase: 'downloading',
    latest,
    error: null,
    progress: 0,
    total: latest.appImage.size || 0,
  })

  try {
    const shaText = await fetchAssetText(latest.shaAsset, {
      token,
      signal: controller.signal,
    })
    const expectedSha256 = parseSha256(shaText)
    if (!expectedSha256) {
      throw new Error('更新包的 SHA256 校验文件格式无效。')
    }

    if (latest.appImage.size) {
      await ensureFreeSpace(dirname(destination), latest.appImage.size)
    }

    const result = await downloadAssetToFile(latest.appImage, destination, {
      token,
      expectedSha256,
      signal: controller.signal,
      onProgress: reportUpdateProgress,
    })
    log(
      'update downloaded:',
      latest.version,
      formatBytes(result.size),
      `sha256=${result.sha256}`,
    )

    if (!canInstall) {
      setUpdateStatus({ phase: 'available', latest, progress: 0, total: 0 })
      await showDownloadedDialog(latest, destination)
      return
    }

    setUpdateStatus({ phase: 'installing', latest, progress: 1, total: 1 })
    await installAppImage({ source: destination, target: appImagePath })
    log('update installed:', latest.version, '->', appImagePath)

    updateState.installedVersion = latest.version
    updateState.latest = null
    await persistUpdateState()
    notify('更新已安装', `正在重启到 DeepSeek Harness ${latest.version}…`)
    await relaunchAppImage(appImagePath)
  } catch (error) {
    const aborted = error?.code === 'aborted' || error?.name === 'AbortError'
    log('update failed:', error.message)
    if (aborted) {
      setUpdateStatus({ phase: 'available', latest, progress: 0, total: 0, error: null })
      notify('更新已取消', '下载已停止。', () => showUpdateOverlay())
    } else {
      setUpdateStatus({ phase: 'error', latest, progress: 0, total: 0, error: error.message })
      await showDownloadErrorDialog(error, destination)
    }
  } finally {
    if (downloadController === controller) downloadController = null
  }
}

const APPIMAGE_ENV_KEYS = ['APPIMAGE', 'APPDIR', 'OWD', 'ARGV0']
const APPIMAGE_PATH_KEYS = [
  'PATH',
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'XDG_DATA_DIRS',
  'XDG_CONFIG_DIRS',
  'GI_TYPELIB_PATH',
  'GTK_PATH',
  'GIO_EXTRA_MODULES',
  'QT_PLUGIN_PATH',
]
const APPIMAGE_DIR_KEYS = [
  'GSETTINGS_SCHEMA_DIR',
  'GDK_PIXBUF_MODULE_FILE',
  'GDK_PIXBUF_MODULEDIR',
  'GIO_MODULE_DIR',
  'QT_QPA_PLATFORM_PLUGIN_PATH',
]

// The AppImage runtime exports paths into its own mount. If those are passed to
// the freshly installed AppImage, it keeps using the old (about to disappear)
// mount and fails to start. Drop them so the new AppImage mounts itself.
function relaunchEnvironment() {
  const env = { ...process.env }
  const appDir = env.APPDIR || ''
  for (const key of APPIMAGE_ENV_KEYS) delete env[key]
  if (!appDir) return env
  const insideAppDir = (entry) => entry === appDir || entry.startsWith(`${appDir}/`)
  for (const key of APPIMAGE_PATH_KEYS) {
    const value = env[key]
    if (!value) continue
    const kept = value.split(':').filter((entry) => entry && !insideAppDir(entry))
    if (kept.length > 0) env[key] = kept.join(':')
    else delete env[key]
  }
  for (const key of APPIMAGE_DIR_KEYS) {
    if (env[key] && insideAppDir(env[key])) delete env[key]
  }
  return env
}

async function relaunchAppImage(target) {
  quitting = true
  try {
    await stopServer()
  } catch (error) {
    log('failed to stop server before restart:', error.message)
  }
  cleanupDone = true
  const args = process.argv
    .slice(1)
    .filter((arg) => arg !== app.getAppPath() && !arg.endsWith('desktop/main.mjs'))
  if (!args.includes(RELAUNCH_WAIT_FLAG)) args.push(RELAUNCH_WAIT_FLAG)
  // app.relaunch() cannot be used here: it would start the AppImage with the
  // environment of the current mount. Spawn it through a detached shell with a
  // clean environment instead.
  try {
    const child = spawn('/bin/sh', ['-c', 'sleep 1; exec "$0" "$@"', target, ...args], {
      detached: true,
      stdio: 'ignore',
      cwd: homedir(),
      env: relaunchEnvironment(),
    })
    child.unref()
    log('relaunching:', target)
  } catch (error) {
    log('failed to relaunch:', error.message)
  }
  app.quit()
}

function cleanupStaleUpdateFiles() {
  try {
    mkdirSync(updateCacheDir, { recursive: true })
    for (const name of readdirSync(updateCacheDir)) {
      if (name.endsWith('.part')) rmSync(join(updateCacheDir, name), { force: true })
    }
  } catch {}
  if (!process.env.APPIMAGE) return
  const target = process.env.APPIMAGE
  try {
    rmSync(`${join(dirname(target), `.${basename(target)}.update`)}.part`, { force: true })
  } catch {}
}

function hydrateCachedUpdate() {
  const cached = updateState.latest
  if (!cached || !cached.version) return
  try {
    if (!isStableChannelVersion(cached.version)) return
    const targets = updateTargets(cached.version)
    if (targets.runtimeAvailable || targets.shellAvailable) {
      updateStatus = {
        ...updateStatus,
        phase: 'available',
        latest: cached,
        runtimeAvailable: targets.runtimeAvailable,
        shellAvailable: targets.shellAvailable,
      }
    }
  } catch {}
}

function scheduleUpdateChecks() {
  if (updateTimer) {
    clearInterval(updateTimer)
    updateTimer = null
  }
  if (!autoCheckEnabled() || smokePath) return
  updateTimer = setInterval(() => {
    checkForUpdates({ automatic: true })
  }, updateCheckIntervalMs)
  updateTimer.unref?.()
}

function startAutoUpdateChecks() {
  if (smokePath || !autoCheckEnabled()) return
  scheduleUpdateChecks()
  const timer = setTimeout(() => {
    checkForUpdates({ automatic: true })
  }, Math.max(1000, updateCheckDelayMs))
  timer.unref?.()
}

function tailServerLog(lines = 30) {
  try {
    return readFileSync(serverLog, 'utf8').trim().split('\n').slice(-lines).join('\n')
  } catch {
    return '(no log yet)'
  }
}

function startServer() {
  mkdirSync(stateDir, { recursive: true })
  const output = createWriteStream(serverLog, { flags: 'a' })
  output.on('error', () => {})
  safeWrite(output, `\n===== ${new Date().toISOString()} starting dsh web =====\n`)

  const env = {
    ...process.env,
    DSH_PNPM_BIN: bundledPnpm || process.env.DSH_PNPM_BIN || '',
    PATH: [
      join(projectRoot, 'node_modules', '.bin'),
      join(projectRoot, 'bin'),
      runtimeDir ? join(runtimeDir, 'node', 'bin') : '',
      '/usr/local/bin',
      '/usr/bin',
      '/bin',
      process.env.PATH || '',
    ]
      .filter(Boolean)
      .join(':'),
  }

  const child = spawn(
    join(projectRoot, 'bin', 'dsh'),
    ['web', '--no-open', '--host', '127.0.0.1', '--port', '0'],
    { cwd: serverCwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  )
  serverChild = child

  return new Promise((resolve, reject) => {
    let settled = false
    let seen = ''
    let timer = null

    const finish = (error, url) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (error) reject(error)
      else resolve(url)
    }

    const feed = (chunk) => {
      const text = chunk.toString('utf8')
      safeWrite(output, chunk)
      safeWrite(process.stdout, text)
      if (settled) return
      seen = (seen + text).slice(-131072)
      const match = seen.match(/dsh web:\s+(https?:\/\/[^\s]+)/)
      if (match) {
        log('server is up:', match[1].replace(/token=[^&]+/, 'token=***'))
        finish(null, match[1])
      }
    }

    child.stdout.on('data', feed)
    child.stderr.on('data', feed)

    child.once('exit', (code, signal) => {
      if (serverChild === child) serverChild = null
      safeWrite(output, `===== ${new Date().toISOString()} exited code=${code} signal=${signal} =====\n`)
      output.end()
      if (!settled) {
        finish(new Error(`dsh 服务启动失败（code=${code}, signal=${signal}）\n\n${tailServerLog(15)}`))
      } else if (!quitting && !restarting && serverUrl) {
        serverUrl = null
        handleServerCrash(code, signal)
      }
    })

    child.once('error', (error) => {
      if (serverChild === child) serverChild = null
      safeWrite(output, `spawn error: ${error.stack || error}\n`)
      output.end()
      finish(new Error(`无法启动 dsh：${error.message}`))
    })

    timer = setTimeout(() => {
      finish(new Error(`dsh 服务在 180 秒内没有就绪\n\n${tailServerLog(15)}`))
      stopChild(child)
    }, 180_000)
  })
}

function stopChild(child) {
  return new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    const done = () => {
      clearTimeout(killTimer)
      resolve()
    }
    const killTimer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {}
      }
      resolve()
    }, 5000)
    child.once('exit', done)
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      try {
        child.kill('SIGTERM')
      } catch {}
    }
  })
}

async function stopServer() {
  const child = serverChild
  serverChild = null
  serverUrl = null
  await stopChild(child)
}

async function waitForHttp(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    if (quitting) throw new Error('启动已取消')
    try {
      const response = await fetch(url, {
        redirect: 'manual',
        signal: AbortSignal.timeout(5000),
      })
      if (response.status < 500) return
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      lastError = error
    }
    await delay(400)
  }
  throw new Error(`服务未就绪：${lastError?.message || 'timeout'}`)
}

function loadBounds() {
  try {
    const saved = JSON.parse(readFileSync(windowStateFile, 'utf8'))
    if (saved && Number.isFinite(saved.width) && Number.isFinite(saved.height)) {
      const displays = screen.getAllDisplays()
      const onScreen = displays.some(({ workArea: area }) => {
        const x = Number.isFinite(saved.x) ? saved.x : area.x
        const y = Number.isFinite(saved.y) ? saved.y : area.y
        return (
          x + saved.width > area.x &&
          x < area.x + area.width &&
          y + saved.height > area.y &&
          y < area.y + area.height
        )
      })
      if (onScreen) return { x: saved.x, y: saved.y, width: saved.width, height: saved.height }
      return { width: saved.width, height: saved.height }
    }
  } catch {}
  return { width: 1280, height: 860 }
}

function saveBounds() {
  if (!win || win.isDestroyed()) return
  try {
    const bounds = win.getNormalBounds()
    mkdirSync(dirname(windowStateFile), { recursive: true })
    writeFileSync(windowStateFile, JSON.stringify(bounds))
  } catch (error) {
    log('failed to save window bounds', error)
  }
}

function showWindow() {
  if (!win || win.isDestroyed()) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function openInBrowser() {
  if (serverUrl) shell.openExternal(serverUrl)
}

function isTrustedUrl(target) {
  try {
    const url = new URL(target)
    if (!serverUrl) return url.protocol === 'file:'
    return url.origin === new URL(serverUrl).origin
  } catch {
    return false
  }
}

function createWindow() {
  const bounds = loadBounds()
  win = new BrowserWindow({
    ...bounds,
    minWidth: 900,
    minHeight: 600,
    show: false,
    icon: iconFile,
    title: 'DeepSeek Harness',
    backgroundColor: '#0b1220',
    autoHideMenuBar: true,
    ...(process.platform === 'linux'
      ? {
          titleBarStyle: 'hidden',
          titleBarOverlay: { color: '#0b1220', symbolColor: '#e6e9f0', height: 40 },
        }
      : {}),
    webPreferences: {
      preload: preloadFile,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
    },
  })

  win.once('ready-to-show', () => win.show())
  win.on('close', (event) => {
    if (quitting) {
      saveBounds()
      return
    }
    event.preventDefault()
    saveBounds()
    win.hide()
    if (!notifiedHidden && Notification.isSupported()) {
      notifiedHidden = true
      new Notification({
        title: 'DeepSeek Harness 仍在后台运行',
        body: '点击顶部托盘图标可以重新打开窗口。',
        icon: nativeImage.createFromPath(iconFile),
      }).show()
    }
  })
  win.on('resize', saveBounds)
  win.on('move', saveBounds)
  win.on('closed', () => {
    win = null
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isTrustedUrl(url)) {
      win.loadURL(url)
    } else if (/^https?:/i.test(url)) {
      shell.openExternal(url)
    }
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (isTrustedUrl(url)) return
    event.preventDefault()
    if (/^https?:/i.test(url)) shell.openExternal(url)
  })

  if (process.env.DSH_DESKTOP_VERBOSE) {
    win.webContents.on('console-message', (...args) => {
      const details = args[1]
      if (details && typeof details === 'object') {
        console.log(`[renderer:${details.level}]`, details.message)
      } else {
        console.log('[renderer]', args.slice(1).join(' '))
      }
    })
    win.webContents.on('did-fail-load', (_event, code, description, url) => {
      console.log('[load-fail]', code, description, url)
    })
  }

  win.loadURL(pathToFileURL(splashFile).href)
}

function trayMenuTemplate() {
  return [
    { label: '打开主窗口', click: showWindow },
    { label: '在浏览器中打开', click: openInBrowser },
    { type: 'separator' },
    ...updateMenuTemplate({ fullPackage: true }),
    autoCheckMenuItem(),
    { type: 'separator' },
    { label: '重启服务', click: () => restartServer() },
    { label: '关于', click: showAbout },
    { label: '退出', click: quitApp },
  ]
}

function createTray() {
  const image = nativeImage.createFromPath(trayIconFile)
  tray = new Tray(image)
  tray.setToolTip('DeepSeek Harness')
  tray.setContextMenu(Menu.buildFromTemplate(trayMenuTemplate()))
  tray.on('click', showWindow)
  tray.on('double-click', showWindow)
  log('tray created')
}

function isMainWindowSender(event) {
  return win !== null && !win.isDestroyed() && event.sender === win.webContents
}

function commandTargetPath() {
  return join(projectRoot, 'bin', 'dsh')
}

function commandLinkPath() {
  return join(homedir(), '.local', 'bin', 'dsh')
}

async function showCommandManager() {
  showWindow()
  const target = commandTargetPath()
  const link = commandLinkPath()
  let current
  try {
    current = lstatSync(link).isSymbolicLink() ? readlinkSync(link) : link
  } catch {}
  const installed = current === target
  const { response } = await showMessageBox({
    type: 'info',
    title: '管理 dsh 命令',
    message: installed ? 'dsh 命令已安装到 ~/.local/bin。' : '把 dsh 命令安装到 ~/.local/bin。',
    detail: [
      `dsh 可执行文件：${target}`,
      `命令链接：${link}`,
      current && !installed ? `当前指向：${current}` : '',
      '',
      '安装后请确保 ~/.local/bin 已加入 PATH。',
    ].filter(Boolean).join('\n'),
    buttons: installed ? ['重新安装链接', '移除链接', '关闭'] : ['安装链接', '移除链接', '关闭'],
    defaultId: 0,
    cancelId: 2,
  })
  try {
    if (response === 0) {
      mkdirSync(dirname(link), { recursive: true })
      try {
        unlinkSync(link)
      } catch {}
      symlinkSync(target, link)
      await showMessageBox({
        type: 'info',
        title: '管理 dsh 命令',
        message: '已安装 dsh 命令。',
        detail: `${link} → ${target}`,
        buttons: ['确定'],
      })
    } else if (response === 1) {
      try {
        unlinkSync(link)
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      await showMessageBox({
        type: 'info',
        title: '管理 dsh 命令',
        message: '已移除 dsh 命令链接。',
        buttons: ['确定'],
      })
    }
  } catch (error) {
    await showMessageBox({
      type: 'error',
      title: '管理 dsh 命令',
      message: '操作失败。',
      detail: error.message,
      buttons: ['确定'],
    })
  }
}

function applicationMenuItems() {
  return [
    { label: '关于 DeepSeek Harness', click: () => showAbout() },
    { type: 'separator' },
    { label: '检查更新', click: () => { void checkForUpdates({ manual: true, force: true }) } },
    { label: '管理 dsh 命令...', click: () => { void showCommandManager() } },
    { type: 'separator' },
    {
      label: '开发者工具',
      accelerator: 'Ctrl+Shift+I',
      click: () => {
        if (win && !win.isDestroyed()) win.webContents.toggleDevTools()
      },
    },
    { type: 'separator' },
    { label: '退出', accelerator: 'Ctrl+Q', click: () => quitApp() },
  ]
}

function editMenuItems() {
  return [
    { role: 'undo', label: '撤销', accelerator: 'Ctrl+Z' },
    { role: 'redo', label: '重做', accelerator: 'Ctrl+Y' },
    { type: 'separator' },
    { role: 'cut', label: '剪切', accelerator: 'Ctrl+X' },
    { role: 'copy', label: '复制', accelerator: 'Ctrl+C' },
    { role: 'paste', label: '粘贴', accelerator: 'Ctrl+V' },
    { role: 'delete', label: '删除' },
    { type: 'separator' },
    { role: 'selectAll', label: '全选', accelerator: 'Ctrl+A' },
  ]
}

const captionMenus = {
  application: applicationMenuItems,
  edit: editMenuItems,
}

function registerDesktopIpc() {
  ipcMain.handle('dsh-desktop:windows-menu', (event, name, x, y) => {
    if (!isMainWindowSender(event)) throw new Error('desktop menu: rejected sender')
    const buildItems = captionMenus[name]
    if (buildItems === undefined) throw new Error('desktop menu: unknown menu')
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > 100_000 || y > 100_000) {
      throw new Error('desktop menu: invalid popup request')
    }
    const window = win
    const zoom = window.webContents.getZoomFactor()
    return new Promise((resolve) => {
      Menu.buildFromTemplate(buildItems()).popup({
        window,
        x: Math.round(x * zoom),
        y: Math.round(y * zoom),
        callback: resolve,
      })
    })
  })
  ipcMain.on('dsh-desktop:update-action', (event, action) => {
    if (!isMainWindowSender(event)) throw new Error('desktop update: rejected sender')
    if (action === 'check') {
      void checkForUpdates({ manual: true, force: true })
    } else if (action === 'install') {
      void downloadAndInstallUpdate()
    } else if (action === 'cancel') {
      cancelUpdateDownload()
    } else if (action !== 'close') {
      throw new Error('desktop update: unknown action')
    }
  })
  ipcMain.on('dsh-desktop:titlebar-appearance', (event, color, symbolColor) => {
    if (!isMainWindowSender(event)) return
    const validColor = (value) => typeof value === 'string'
      && /^(?:#[\da-f]{3,8}|rgba?\([\d.,%\s]+\))$/iu.test(value)
    if (!validColor(color) || !validColor(symbolColor)) return
    try {
      win.setTitleBarOverlay({ color, symbolColor, height: 40 })
    } catch {}
  })
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '在浏览器中打开', accelerator: 'CmdOrCtrl+Shift+O', click: openInBrowser },
        { label: '重启服务', click: () => restartServer() },
        { type: 'separator' },
        { label: '退出', accelerator: 'CmdOrCtrl+Q', click: quitApp },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '全屏' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        ...updateMenuTemplate(),
        { type: 'separator' },
        autoCheckMenuItem(),
        { type: 'separator' },
        { label: '关于 DeepSeek Harness', click: showAbout },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function showAbout() {
  showWindow()
  if (win === null || win.isDestroyed()) return
  let icon = ''
  try {
    icon = nativeImage.createFromPath(iconFile).toDataURL()
  } catch {}
  try {
    win.webContents.send('dsh-desktop:about-dialog', {
      name: 'DeepSeek Harness',
      tagline: 'DeepSeek Harness 桌面客户端',
      version: app.getVersion(),
      dshVersion: getInstalledDshVersion() || currentAppVersion(),
      copyright: `© ${new Date().getFullYear()} DeepSeek Harness`,
      icon,
    })
  } catch {}
}

function handleServerCrash(code, signal) {
  if (!win || win.isDestroyed()) return
  dialog
    .showMessageBox(win, {
      type: 'error',
      title: 'DeepSeek Harness 服务已停止',
      message: `dsh 服务意外退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}）`,
      detail: `日志：${serverLog}\n\n${tailServerLog(12)}`,
      buttons: ['重启服务', '退出'],
      defaultId: 0,
      cancelId: 1,
    })
    .then(({ response }) => {
      if (response === 0) restartServer()
      else quitApp()
    })
    .catch(() => {})
}

// dsh web mints one auth cookie per server instance, named after the random
// ephemeral port and valid for 30 days on 127.0.0.1. Nothing expires them, so
// they accumulate across launches; once enough pile up every request exceeds
// the server's header-size limit, it answers 431, and the window stays blank
// forever. Drop them all before (re)loading the app — the load URL carries a
// fresh token and the server re-issues its cookie via a 303 redirect.
async function pruneStaleAuthCookies() {
  try {
    const cookies = await session.defaultSession.cookies.get({ domain: '127.0.0.1' })
    const stale = cookies.filter((cookie) => cookie.name.startsWith('dsh-auth-'))
    for (const cookie of stale) {
      await session.defaultSession.cookies
        .remove(`http://127.0.0.1${cookie.path}`, cookie.name)
        .catch(() => {})
    }
    if (stale.length > 0) log(`pruned ${stale.length} stale dsh-auth cookie(s)`)
  } catch (error) {
    log('failed to prune dsh-auth cookies:', error.message)
  }
}

async function loadApp() {
  if (!win || win.isDestroyed()) return
  await pruneStaleAuthCookies()
  const url = await startServer()
  await waitForHttp(url)
  serverUrl = url
  await win.loadURL(url)
  log('web ui loaded')
}

async function boot() {
  let bootError = null
  try {
    await loadApp()
  } catch (error) {
    bootError = error
    if (activeRuntime.source === 'managed') {
      log('managed runtime failed to start, falling back to bundled:', error.message)
      await stopServer().catch(() => {})
      await markRuntimeBroken(dataDir, activeRuntime.version).catch((markError) =>
        log('failed to mark runtime broken:', markError.message),
      )
      updateState.runtime = {
        ...(updateState.runtime || {}),
        brokenVersion: activeRuntime.version,
      }
      await persistUpdateState()
      useRuntime(resolveActiveRuntime({ bundledRoot: bundledProjectRoot, dataDir }))
      try {
        await loadApp()
        bootError = null
        log('fell back to bundled runtime:', activeRuntime.version)
      } catch (fallbackError) {
        bootError = fallbackError
      }
    }
  }

  if (!bootError) {
    // Only prune after a managed runtime has proven it can start. Pruning
    // before boot could delete a good rollback copy when `current` points at
    // a broken version.
    if (app.isPackaged && activeRuntime.source === 'managed') {
      await pruneRuntimeVersions(
        dataDir,
        [activeRuntime.version, updateState.runtime?.previousVersion].filter(Boolean),
      ).catch((error) => log('failed to prune runtime versions:', error.message))
    }
    if (smokePath) await runSmoke()
    else startAutoUpdateChecks()
    return
  }

  log('boot failed:', bootError)
  if (smokePath) {
    console.error('[smoke] failed:', bootError)
    await stopServer()
    app.exit(1)
    return
  }
  dialog.showErrorBox(
    'DeepSeek Harness 启动失败',
    `${bootError.message}\n\n日志：${serverLog}\n\n请检查 README 中的启动命令是否可用。`,
  )
  quitApp()
}

async function restartServer({ rethrow = false } = {}) {
  if (restarting) {
    if (rethrow) throw new Error('dsh 服务正在重启，请稍后重试。')
    return
  }
  restarting = true
  try {
    await stopServer()
    if (win && !win.isDestroyed()) await win.loadURL(pathToFileURL(splashFile).href)
    await loadApp()
  } catch (error) {
    log('restart failed:', error)
    if (rethrow) throw error
    dialog.showErrorBox('重启服务失败', `${error.message}\n\n日志：${serverLog}`)
  } finally {
    restarting = false
  }
}

async function runSmoke() {
  const timer = setTimeout(() => {
    console.error('[smoke] timeout')
    app.exit(1)
  }, 120_000)
  timer.unref()
  await delay(20000)
  const image = await win.webContents.capturePage()
  writeFileSync(smokePath, image.toPNG())
  clearTimeout(timer)
  log('[smoke] screenshot written to', smokePath)
  quitApp()
}

function quitApp() {
  app.quit()
}

app.on('before-quit', (event) => {
  if (cleanupDone) return
  event.preventDefault()
  if (quitting) return
  quitting = true
  stopServer().finally(() => {
    cleanupDone = true
    app.quit()
  })
})

app.on('window-all-closed', () => {
  // Keep the app alive in the tray until the user explicitly quits.
})

app.on('activate', showWindow)

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => quitApp())
}

async function acquireSingleInstanceLock() {
  const waitForPrevious = process.argv.includes(RELAUNCH_WAIT_FLAG)
  const deadline = Date.now() + (waitForPrevious ? 15_000 : 0)
  while (true) {
    if (app.requestSingleInstanceLock()) return true
    if (Date.now() >= deadline) return false
    await delay(200)
  }
}

const gotLock = await acquireSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', showWindow)
  app.whenReady().then(async () => {
    cleanupStaleUpdateFiles()
    await removeStaleRuntimeDirs(dataDir).catch((error) =>
      log('failed to clean stale runtime dirs:', error.message),
    )
    hydrateCachedUpdate()
    registerDesktopIpc()
    buildMenu()
    createTray()
    createWindow()
    refreshMenus()
    if (!smokePath) {
      powerMonitor.on('resume', () => {
        if (autoCheckEnabled()) checkForUpdates({ automatic: true, force: true })
      })
    }
    await boot()
  })
}
