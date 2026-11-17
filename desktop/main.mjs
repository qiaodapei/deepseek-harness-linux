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
} from 'electron'
import { spawn } from 'node:child_process'
import {
  createWriteStream,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { format } from 'node:util'
import {
  DEFAULT_REPO,
  compareVersions,
  downloadAssetToFile,
  ensureFreeSpace,
  fetchAssetText,
  fetchReleases,
  formatBytes,
  installAppImage,
  isDirectoryWritable,
  parseSha256,
  readInstalledDshVersion,
  readUpdateState,
  selectLatestRelease,
  writeUpdateState,
} from './updater.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const runtimeDir = app.isPackaged ? join(process.resourcesPath, 'runtime') : ''
const projectRoot =
  process.env.DSH_DESKTOP_PROJECT_ROOT || (runtimeDir ? join(runtimeDir, 'app') : dirname(here))
const serverCwd = process.env.DSH_DESKTOP_CWD || (app.isPackaged ? homedir() : projectRoot)
const staticDir = app.isPackaged ? join(process.resourcesPath, 'app.asar.unpacked', 'desktop') : here
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
const updateCheckIntervalMs = 6 * 60 * 60 * 1000
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
  return process.env.DSH_UPDATE_CURRENT_VERSION || app.getVersion()
}

function getInstalledDshVersion() {
  if (!installedDshVersion) {
    installedDshVersion = readInstalledDshVersion(projectRoot, app.getVersion())
  }
  return installedDshVersion
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
}

function reportUpdateProgress(received, total) {
  updateStatus.progress = received
  if (total > 0) updateStatus.total = total
  const now = Date.now()
  if (now - lastUpdateUiAt >= 500) {
    lastUpdateUiAt = now
    refreshMenus()
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
  const { phase, latest, progress, total } = updateStatus
  if (phase === 'checking') return '正在检查更新…'
  if (phase === 'downloading') {
    if (total > 0) {
      return `正在下载更新… ${Math.min(100, Math.floor((progress / total) * 100))}%`
    }
    return `正在下载更新… ${formatBytes(progress)}`
  }
  if (phase === 'installing') return '正在安装更新…'
  if (phase === 'available' && latest) return `安装更新 v${latest.version}…`
  if (phase === 'error') return '重新检查更新…'
  return '检查更新…'
}

function updateMenuTemplate() {
  const { phase } = updateStatus
  const items = [
    {
      label: updateEntryLabel(),
      enabled: !['checking', 'installing', 'downloading'].includes(phase),
      click: () => {
        if (phase === 'available') showUpdateAvailableDialog()
        else if (!['checking', 'installing', 'downloading'].includes(phase)) {
          checkForUpdates({ manual: true, force: true })
        }
      },
    },
  ]
  if (phase === 'downloading') {
    items.push({ label: '取消下载', click: cancelUpdateDownload })
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

async function checkForUpdates({ manual = false, force = false } = {}) {
  if (manual) showWindow()
  if (updateStatus.phase === 'downloading' || updateStatus.phase === 'installing') {
    if (manual) {
      await showMessageBox({
        type: 'info',
        title: '更新正在进行中',
        message: '请等待当前更新完成。',
        buttons: ['确定'],
      })
    }
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

  checkPromise = (async () => {
    const token = readUpdateToken()
    const current = currentAppVersion()
    try {
      const result = await fetchReleases({
        repo: updateRepo,
        token,
        etag: manual || force ? '' : updateState.etag || '',
      })

      let latest = null
      if (result.notModified) {
        latest =
          updateState.latest && compareVersions(updateState.latest.version, current) > 0
            ? updateState.latest
            : null
      } else {
        updateState.etag = result.etag || ''
        updateState.latest = cacheRelease(selectLatestRelease(result.releases, '0.0.0'))
        latest = selectLatestRelease(result.releases, current)
      }

      updateState.lastCheck = Date.now()
      await persistUpdateState()

      log(
        'update check:',
        `current=v${current}`,
        latest ? `available=v${latest.version}` : 'up-to-date',
      )

      if (latest) {
        setUpdateStatus({ phase: 'available', latest, error: null })
        if (manual) {
          await showUpdateAvailableDialog()
        } else if (updateState.notifiedVersion !== latest.version) {
          updateState.notifiedVersion = latest.version
          await persistUpdateState()
          notify(
            '发现 DeepSeek Harness 更新',
            `v${latest.version} 可用，当前为 v${current}。点击查看并安装。`,
            () => {
              showWindow()
              showUpdateAvailableDialog()
            },
          )
        }
        return latest
      }

      setUpdateStatus({ phase: 'idle', latest: null, error: null })
      if (manual) await showUpToDateDialog()
      return null
    } catch (error) {
      log('update check failed:', error.message)
      let cached = null
      try {
        if (updateState.latest && compareVersions(updateState.latest.version, current) > 0) {
          cached = updateState.latest
        }
      } catch {}
      setUpdateStatus({ phase: 'error', latest: cached, error: error.message })
      if (manual) await showUpdateErrorDialog(error)
      return null
    }
  })()

  try {
    return await checkPromise
  } finally {
    checkPromise = null
  }
}

async function showUpdateAvailableDialog() {
  const latest = updateStatus.latest
  if (!latest) return
  showWindow()

  const current = currentAppVersion()
  const currentDsh = getInstalledDshVersion()
  const currentLabel =
    currentDsh && currentDsh !== current ? `${current}（内置 dsh ${currentDsh}）` : current
  const size = latest.appImage.size ? formatBytes(latest.appImage.size) : '未知大小'
  const lines = [
    `当前版本：${currentLabel}`,
    `新版本：${latest.version}`,
    `更新包：${latest.appImage.name}（${size}）`,
  ]
  if (latest.publishedAt) {
    lines.push(`发布日期：${new Date(latest.publishedAt).toLocaleString()}`)
  }
  lines.push('', '下载完成后会自动重启客户端。', '', '更新说明：', plainNotes(latest.notes))

  const { response } = await showMessageBox({
    type: 'info',
    title: '发现新版本',
    message: `DeepSeek Harness ${latest.version} 可用`,
    detail: lines.join('\n'),
    buttons: ['下载并安装', '稍后', '查看发布说明'],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  })

  if (response === 0) await downloadAndInstallUpdate()
  else if (response === 2) shell.openExternal(latest.url)
}

async function showUpToDateDialog() {
  showWindow()
  const current = currentAppVersion()
  const currentDsh = getInstalledDshVersion()
  const detail = [`当前版本：${current}`]
  if (currentDsh !== current) detail.push(`内置 dsh：${currentDsh}`)
  detail.push(`更新源：https://github.com/${updateRepo}/releases`)

  const { response } = await showMessageBox({
    type: 'info',
    title: '检查更新',
    message: '当前已是最新版本',
    detail: detail.join('\n'),
    buttons: ['确定', '打开 Release 页面'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  })
  if (response === 1) shell.openExternal(`https://github.com/${updateRepo}/releases`)
}

async function showUpdateErrorDialog(error) {
  showWindow()
  const token = readUpdateToken()
  const detail = [
    String(error?.message || error),
    '',
    `更新源：https://github.com/${updateRepo}/releases`,
    token
      ? '已读取 GitHub token。'
      : `未配置 GitHub token。如果仓库是私有的，请把只读 token 保存到：\n${updateTokenFile}`,
  ].join('\n')

  const { response } = await showMessageBox({
    type: 'error',
    title: '检查更新失败',
    message: '无法检查更新',
    detail,
    buttons: ['重试', '打开 Release 页面', '关闭'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  })
  if (response === 0) checkForUpdates({ manual: true, force: true })
  else if (response === 1) shell.openExternal(`https://github.com/${updateRepo}/releases`)
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
    title: '更新失败',
    message: '无法下载或安装更新',
    detail,
    buttons: ['重试', '打开 Release 页面', '关闭'],
    defaultId: 0,
    cancelId: 2,
    noLink: true,
  })
  if (response === 0) downloadAndInstallUpdate()
  else if (response === 1) {
    shell.openExternal(latest?.url || `https://github.com/${updateRepo}/releases`)
  }
}

function cancelUpdateDownload() {
  if (downloadController) downloadController.abort()
}

async function downloadAndInstallUpdate() {
  const latest = updateStatus.latest
  if (!latest || downloadController) return

  if (compareVersions(latest.version, currentAppVersion()) <= 0) {
    setUpdateStatus({ phase: 'idle', latest: null, progress: 0, total: 0 })
    await showMessageBox({
      type: 'info',
      title: '无需更新',
      message: '当前已是最新版本。',
      buttons: ['确定'],
    })
    return
  }

  if (!latest.shaAsset) {
    await showMessageBox({
      type: 'error',
      title: '更新失败',
      message: '该 Release 缺少 SHA256 校验文件，已中止下载。',
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
      notify('更新已取消', '下载已停止。', () => {
        showWindow()
        showUpdateAvailableDialog()
      })
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
  if (!cached || !cached.version || !cached.appImage?.url || !cached.shaAsset?.url) return
  try {
    if (compareVersions(cached.version, currentAppVersion()) > 0) {
      updateStatus = { ...updateStatus, phase: 'available', latest: cached }
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
    PATH: [
      join(projectRoot, 'node_modules', '.bin'),
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
    webPreferences: {
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
    ...updateMenuTemplate(),
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
  const lastCheck = updateState.lastCheck
    ? new Date(updateState.lastCheck).toLocaleString()
    : '尚未检查'
  const installedDsh = getInstalledDshVersion()
  const detail = [`Version: ${app.getVersion()}`]
  if (installedDsh !== app.getVersion()) detail.push(`dsh version: ${installedDsh}`)
  detail.push(
    `Update source: ${updateRepo}`,
    `Last update check: ${lastCheck}`,
    `Project: ${projectRoot}`,
    `Server: ${serverUrl || '(not running)'}`,
    `Server log: ${serverLog}`,
  )
  const options = {
    type: 'info',
    title: 'About DeepSeek Harness',
    message: 'DeepSeek Harness Desktop',
    detail: detail.join('\n'),
    buttons: ['OK'],
  }
  if (win && !win.isDestroyed()) dialog.showMessageBox(win, options)
  else dialog.showMessageBox(options)
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

async function loadApp() {
  if (!win || win.isDestroyed()) return
  const url = await startServer()
  await waitForHttp(url)
  serverUrl = url
  await win.loadURL(url)
  log('web ui loaded')
}

async function boot() {
  try {
    await loadApp()
    if (smokePath) await runSmoke()
    else startAutoUpdateChecks()
  } catch (error) {
    log('boot failed:', error)
    if (smokePath) {
      console.error('[smoke] failed:', error)
      await stopServer()
      app.exit(1)
      return
    }
    dialog.showErrorBox(
      'DeepSeek Harness 启动失败',
      `${error.message}\n\n日志：${serverLog}\n\n请检查 README 中的启动命令是否可用。`,
    )
    quitApp()
  }
}

async function restartServer() {
  if (restarting) return
  restarting = true
  try {
    await stopServer()
    if (win && !win.isDestroyed()) await win.loadURL(pathToFileURL(splashFile).href)
    await loadApp()
  } catch (error) {
    log('restart failed:', error)
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
    hydrateCachedUpdate()
    buildMenu()
    createTray()
    createWindow()
    refreshMenus()
    if (!smokePath) {
      powerMonitor.on('resume', () => {
        if (autoCheckEnabled()) checkForUpdates({ automatic: true })
      })
    }
    await boot()
  })
}
