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
} from 'electron'
import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

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

const log = (...args) => console.log(`[${new Date().toISOString()}]`, ...args)
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
  output.write(`\n===== ${new Date().toISOString()} starting dsh web =====\n`)

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
      output.write(chunk)
      process.stdout.write(text)
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
      output.write(`===== ${new Date().toISOString()} exited code=${code} signal=${signal} =====\n`)
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
      output.write(`spawn error: ${error.stack || error}\n`)
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

function createTray() {
  const image = nativeImage.createFromPath(trayIconFile)
  tray = new Tray(image)
  tray.setToolTip('DeepSeek Harness')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开主窗口', click: showWindow },
      { label: '在浏览器中打开', click: openInBrowser },
      { type: 'separator' },
      { label: '重启服务', click: () => restartServer() },
      { type: 'separator' },
      { label: '关于', click: showAbout },
      { label: '退出', click: quitApp },
    ]),
  )
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
      submenu: [{ label: '关于 DeepSeek Harness', click: showAbout }],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function showAbout() {
  const options = {
    type: 'info',
    title: 'About DeepSeek Harness',
    message: 'DeepSeek Harness Desktop',
    detail: [
      `Shell version: ${app.getVersion()}`,
      `Project: ${projectRoot}`,
      `Server: ${serverUrl || '(not running)'}`,
      `Server log: ${serverLog}`,
    ].join('\n'),
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

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', showWindow)
  app.whenReady().then(async () => {
    buildMenu()
    createTray()
    createWindow()
    await boot()
  })
}
