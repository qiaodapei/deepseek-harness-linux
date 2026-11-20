// Sandboxed preload for the DeepSeek Harness desktop shell.
//
// This file must stay CommonJS: Electron loads sandboxed preloads outside the
// application's ESM graph. It owns two isolated capabilities:
//   1. the Windows-style caption menubar that opens native application/edit
//      menus without moving focus out of the active editor;
//   2. the `data-windows-titlebar` chrome marker the Web layout reserves space
//      for (40px caption row above the application frame).
const { contextBridge, ipcRenderer } = require('electron')

const WINDOWS_MENU = 'dsh-desktop:windows-menu'
const TITLEBAR_APPEARANCE = 'dsh-desktop:titlebar-appearance'
const TITLEBAR_HEIGHT = 40

// ---------------------------------------------------------------------------
// Window chrome marker
// ---------------------------------------------------------------------------
function installTitlebarMarker() {
  const root = document.documentElement
  if (root === null) return
  root.setAttribute('data-windows-titlebar', '')
  root.style.setProperty('--dsh-windows-titlebar-height', `${TITLEBAR_HEIGHT}px`)
  // Caption menus sit right of the app's own caption-strip controls (the
  // sidebar toggle and, in the collapsed-sidebar layout, the compact
  // new-session button). installStripWatcher() keeps this in sync.
  root.style.setProperty('--dsh-windows-menu-start', '52px')
}

// The Web app renders its own caption controls (sidebar toggle, compact
// new-session button) inside the reserved strip; their footprint changes with
// the sidebar state. Track the rightmost native control under the strip's
// left third and keep the menubar just right of it.
function installStripWatcher(host) {
  const root = document.documentElement
  let scheduled = false
  const reposition = () => {
    scheduled = false
    if (document.body === null) return
    let maxRight = 40 // sidebar toggle always occupies 12..40
    for (const element of document.body.querySelectorAll('button,[role=button]')) {
      if (host.contains(element)) continue
      const rect = element.getBoundingClientRect()
      if (rect.width === 0 || rect.height === 0) continue
      if (rect.top < 0 || rect.top > TITLEBAR_HEIGHT - 8) continue
      if (rect.left > 320) continue // window controls overlay lives at the right edge
      if (rect.right > maxRight) maxRight = rect.right
    }
    root.style.setProperty('--dsh-windows-menu-start', `${Math.round(maxRight + 12)}px`)
  }
  const schedule = () => {
    if (scheduled) return
    scheduled = true
    setTimeout(reposition, 120)
  }
  const observer = new MutationObserver(schedule)
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] })
  window.setInterval(schedule, 1000)
  schedule()
  return () => {
    observer.disconnect()
  }
}

if (document.documentElement !== null) installTitlebarMarker()
else document.addEventListener('DOMContentLoaded', installTitlebarMarker, { once: true })

// The caption strip's paint color lives on an application frame element (the
// theme tokens are declared on <body> but the strip itself is painted by the
// app shell), so sample the rendered background under the middle of the strip
// instead of guessing a token name.
function stripBackground() {
  if (document.body === null) return undefined
  const x = Math.max(200, Math.round(window.innerWidth / 2))
  const y = Math.round(TITLEBAR_HEIGHT / 2)
  let element = document.elementFromPoint(x, y)
  while (element !== null) {
    const background = getComputedStyle(element).backgroundColor
    if (background !== '' && background !== 'transparent' && !/rgba\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*,\s*0\s*\)/u.test(background)) {
      return background
    }
    element = element.parentElement
  }
  return undefined
}

function reportTitlebarAppearance() {
  const color = stripBackground()
  if (color === undefined) return
  const match = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/u.exec(color)
  if (match === null) return
  const luminance = (0.2126 * Number(match[1]) + 0.7152 * Number(match[2]) + 0.0722 * Number(match[3])) / 255
  ipcRenderer.send(TITLEBAR_APPEARANCE, color, luminance > 0.55 ? '#1a1d24' : '#e6e9f0')
}

// The Web client installs its palette after boot; sample a few times and then
// whenever the theme attributes on <html> or <body> change (colors may
// transition, so re-sample shortly after each change).
let appearanceTimer
let appearanceProbes = 0
function probeAppearance() {
  reportTitlebarAppearance()
  appearanceProbes += 1
  if (appearanceProbes >= 20) {
    clearInterval(appearanceTimer)
    appearanceTimer = undefined
  }
}

window.addEventListener('DOMContentLoaded', () => {
  appearanceTimer = setInterval(probeAppearance, 750)
  const observer = new MutationObserver(() => {
    reportTitlebarAppearance()
    setTimeout(reportTitlebarAppearance, 350)
    setTimeout(reportTitlebarAppearance, 900)
  })
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
  observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style', 'data-theme'] })
}, { once: true })

// ---------------------------------------------------------------------------
// Caption menubar
// ---------------------------------------------------------------------------
function installWindowsMenu() {
  const host = document.createElement('div')
  host.dataset.windowsMenu = ''
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = `
    :host {
      position: fixed;
      top: 0;
      left: var(--dsh-windows-menu-start, 52px);
      z-index: 1100;
      height: var(--dsh-windows-titlebar-height, ${TITLEBAR_HEIGHT}px);
      display: flex;
      align-items: center;
      font-family: var(--dsw-font-family, system-ui, sans-serif);
      -webkit-app-region: no-drag;
    }
    [role=menubar] { display: flex; gap: 2px; }
    button {
      height: 28px;
      padding: 0 10px;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: var(--dsw-alias-label-secondary, #b6bdc9);
      font: inherit;
      font-size: 14px;
      cursor: default;
      -webkit-app-region: no-drag;
    }
    button:hover, button[aria-expanded=true] {
      background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.18));
      color: var(--dsw-alias-label-primary, #eef1f6);
    }
    button:focus-visible {
      outline: 2px solid var(--dsw-alias-state-business-primary, #4d8dff);
      outline-offset: -2px;
    }
  `
  const bar = document.createElement('div')
  bar.setAttribute('role', 'menubar')
  bar.setAttribute('aria-label', '应用菜单')

  let restoreEditor = () => {}
  const rememberEditor = (event) => {
    const target = event.composedPath()[0]
    if (!(target instanceof HTMLElement) || target === host || shadow.contains(target)) return
    if (!(target instanceof HTMLInputElement) && !(target instanceof HTMLTextAreaElement)
      && !target.matches('[contenteditable="true"]')) return
    const selection = document.getSelection()
    const ranges = selection === null
      ? []
      : Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange())
    const input = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement ? target : undefined
    const start = input?.selectionStart
    const end = input?.selectionEnd
    const direction = input?.selectionDirection
    restoreEditor = () => {
      if (!target.isConnected) return
      target.focus({ preventScroll: true })
      if (input !== undefined && start != null && end != null) input.setSelectionRange(start, end, direction ?? undefined)
      else if (selection !== null && ranges.length > 0) {
        selection.removeAllRanges()
        for (const range of ranges) selection.addRange(range)
      }
    }
  }
  document.addEventListener('focusout', rememberEditor, true)

  const buttons = []
  const createButton = (name, label) => {
    const index = buttons.length
    const button = document.createElement('button')
    button.type = 'button'
    button.setAttribute('role', 'menuitem')
    button.setAttribute('aria-haspopup', 'menu')
    button.setAttribute('aria-expanded', 'false')
    button.tabIndex = index === 0 ? 0 : -1
    button.textContent = label
    button.addEventListener('pointerdown', (event) => { event.preventDefault() })
    button.addEventListener('mousedown', (event) => { event.preventDefault() })
    const open = async () => {
      if (button.getAttribute('aria-expanded') === 'true') return
      const rect = button.getBoundingClientRect()
      button.setAttribute('aria-expanded', 'true')
      if (document.activeElement === host) restoreEditor()
      try {
        await ipcRenderer.invoke(WINDOWS_MENU, name, rect.left, rect.bottom)
      } catch (error) {
        console.error('Desktop caption menu failed', error)
      } finally {
        button.setAttribute('aria-expanded', 'false')
      }
    }
    button.addEventListener('click', () => { void open() })
    button.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        event.preventDefault()
        const step = event.key === 'ArrowLeft' ? -1 : 1
        const next = buttons[(index + step + buttons.length) % buttons.length]
        button.tabIndex = -1
        next.tabIndex = 0
        next.focus()
      } else if (event.key === 'ArrowDown') {
        event.preventDefault()
        void open()
      }
    })
    bar.append(button)
    buttons.push(button)
    return button
  }

  createButton('application', '应用')
  createButton('edit', '编辑')
  shadow.append(style, bar)

  const mount = () => {
    // AppFrame owns this seat; boot readiness alone precedes the rendered application.
    if (document.querySelector('[data-shell-overlay]') === null) return
    if (host.isConnected) return
    document.body.append(host)
    installStripWatcher(host)
    observer.disconnect()
  }
  const observer = new MutationObserver(mount)
  observer.observe(document.body, { childList: true, subtree: true })
  mount()

  return {
    dispose: () => {
      observer.disconnect()
      document.removeEventListener('focusout', rememberEditor, true)
      host.remove()
    },
  }
}

// ---------------------------------------------------------------------------
// In-window dialogs (update / about), rendered by preload on top of the page
// ---------------------------------------------------------------------------
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
})[char])

// Shared look for all in-window dialogs: backdrop, card, headings and buttons.
const DIALOG_STYLE = `
    :host {
      position: fixed;
      inset: 0;
      z-index: 1200;
      display: flex;
      align-items: center;
      justify-content: center;
      background: rgba(8, 10, 14, 0.42);
      font-family: var(--dsw-font-family, system-ui, sans-serif);
      -webkit-app-region: no-drag;
    }
    .card {
      width: min(440px, calc(100vw - 48px));
      max-height: calc(100vh - 96px);
      overflow: auto;
      background: var(--dsw-alias-bg-base, #fff);
      color: var(--dsw-alias-label-primary, #1f2328);
      border-radius: var(--dsw-radius-lg, 14px);
      box-shadow: 0 18px 48px rgba(0, 0, 0, 0.28), 0 2px 8px rgba(0, 0, 0, 0.18);
      padding: 20px 22px 18px;
    }
    h2 { margin: 0 0 10px; font-size: 16px; font-weight: 600; }
    p.muted { margin: 0 0 10px; font-size: 13px; color: var(--dsw-alias-label-secondary, #61666b); }
    pre.notes {
      margin: 0 0 12px;
      padding: 10px 12px;
      background: var(--dsw-alias-bg-layer-1, rgba(127, 127, 127, 0.08));
      color: var(--dsw-alias-label-secondary, #61666b);
      border-radius: var(--dsw-radius-md, 8px);
      font: 12px/1.55 var(--dsw-font-family, system-ui, sans-serif);
      white-space: pre-wrap;
      word-break: break-word;
      max-height: 180px;
      overflow: auto;
    }
    .row { display: flex; justify-content: flex-end; gap: 10px; margin-top: 6px; }
    button {
      min-width: 88px;
      height: 32px;
      padding: 0 14px;
      border-radius: var(--dsw-radius-sm, 8px);
      border: 1px solid var(--dsw-alias-border-l2, #e2e5ea);
      background: transparent;
      color: var(--dsw-alias-label-primary, #1f2328);
      font: 13px var(--dsw-font-family, system-ui, sans-serif);
      cursor: pointer;
    }
    button:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.1)); }
    button.primary {
      background: var(--dsw-alias-state-business-primary, #4d8dff);
      border-color: transparent;
      color: #fff;
    }
    button.primary:hover { filter: brightness(1.06); }
    .bar {
      height: 6px;
      border-radius: 999px;
      background: var(--dsw-alias-interactive-bg-hover, rgba(127, 127, 127, 0.16));
      overflow: hidden;
      margin: 4px 0 14px;
    }
    .fill {
      height: 100%;
      border-radius: 999px;
      background: var(--dsw-alias-state-business-primary, #4d8dff);
      transition: width 0.25s ease;
    }
`

const UPDATE_ACTION = 'dsh-desktop:update-action'
const UPDATE_DIALOG = 'dsh-desktop:update-dialog'
const UPDATE_STATUS = 'dsh-desktop:update-status'

function installUpdateDialog() {
  const host = document.createElement('div')
  host.dataset.windowsUpdate = ''
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = DIALOG_STYLE
  const card = document.createElement('div')
  card.className = 'card'
  shadow.append(style, card)
  document.body.append(host)

  let open = false
  let status = null
  let lastPhase = null

  const buttonsHtml = (list) => `<div class="row">${list
    .map((item) => `<button class="${item.primary ? 'primary' : ''}" data-action="${item.action}">${esc(item.label)}</button>`)
    .join('')}</div>`

  function viewFor(state) {
    const phase = state?.phase ?? 'idle'
    if (phase === 'checking') {
      return { title: '检查更新', body: '<p class="muted">正在检查更新…</p>', buttons: [] }
    }
    if (phase === 'downloading') {
      const pct = state?.total > 0 ? Math.min(100, Math.floor((state.progress / state.total) * 100)) : null
      return {
        title: '正在下载更新',
        body: `<p class="muted">正在下载 dsh ${esc(state?.latest?.version ?? '')}…${pct === null ? '' : ` ${pct}%`}</p>
          <div class="bar"><div class="fill" style="width:${pct ?? 4}%"></div></div>`,
        buttons: [{ label: '取消', action: 'cancel' }],
      }
    }
    if (phase === 'installing') {
      return {
        title: '正在安装更新',
        body: '<p class="muted">正在安装 dsh，完成后服务会自动重启…</p>',
        buttons: [],
      }
    }
    if (phase === 'error') {
      return {
        title: state?.latest ? '更新失败' : '检查更新失败',
        body: `<p class="muted">${esc(state?.error || '未知错误')}</p>`,
        buttons: [
          { label: '关闭', action: 'close' },
          { label: '重试', action: 'check', primary: true },
        ],
      }
    }
    if (phase === 'available' && state?.latest) {
      const latest = state.latest
      const notes = latest.notes
        ? `<pre class="notes">${esc(String(latest.notes).slice(0, 1200))}</pre>`
        : ''
      return {
        title: `发现新版本 ${esc(latest.version)}`,
        body: `<p class="muted">当前版本 v${esc(state.current)} → 新版本 v${esc(latest.version)}</p>${notes}`,
        buttons: [
          { label: '稍后', action: 'close' },
          { label: '立即更新', action: 'install', primary: true },
        ],
      }
    }
    return {
      title: '检查更新',
      body: `<p class="muted">当前已是最新版本（v${esc(state?.current ?? '')}）。</p>`,
      buttons: [{ label: '确定', action: 'close', primary: true }],
    }
  }

  function render() {
    if (!open) {
      host.style.display = 'none'
      return
    }
    host.style.display = ''
    const view = viewFor(status)
    card.innerHTML = `<h2>${esc(view.title)}</h2>${view.body}${buttonsHtml(view.buttons)}`
    for (const button of card.querySelectorAll('button[data-action]')) {
      button.addEventListener('click', () => {
        const action = button.dataset.action
        if (action === 'close') {
          open = false
          render()
          return
        }
        ipcRenderer.send(UPDATE_ACTION, action)
      })
    }
  }

  ipcRenderer.on(UPDATE_DIALOG, (_event, payload) => {
    open = Boolean(payload?.open)
    if (open && payload?.status) status = payload.status
    render()
  })
  window.addEventListener(
    'keydown',
    (event) => {
      if (!open || event.key !== 'Escape') return
      event.stopPropagation()
      open = false
      render()
    },
    true,
  )
  ipcRenderer.on(UPDATE_STATUS, (_event, next) => {
    status = next
    const phase = next?.phase ?? 'idle'
    // The install flow ends by returning to idle (success or rollback) — close
    // the dialog so the result is surfaced through the tray notification.
    if (phase === 'idle' && (lastPhase === 'installing' || lastPhase === 'downloading')) {
      open = false
    }
    lastPhase = phase
    render()
  })

  render()
}

// ---------------------------------------------------------------------------
// In-window about dialog
// ---------------------------------------------------------------------------
const ABOUT_DIALOG = 'dsh-desktop:about-dialog'

function installAboutDialog() {
  const host = document.createElement('div')
  host.dataset.windowsAbout = ''
  const shadow = host.attachShadow({ mode: 'open' })
  const style = document.createElement('style')
  style.textContent = DIALOG_STYLE + `
    :host { z-index: 1210; }
    .about { text-align: center; }
    .logo {
      width: 72px;
      height: 72px;
      display: block;
      margin: 4px auto 12px;
      border-radius: 16px;
    }
    .about h2 { margin: 0 0 4px; font-size: 17px; }
    .about p.muted { margin: 2px 0; }
    .about p.copyright { margin-top: 12px; font-size: 12px; }
  `
  const card = document.createElement('div')
  card.className = 'card'
  shadow.append(style, card)
  document.body.append(host)

  let open = false

  function render(info) {
    if (!open) {
      host.style.display = 'none'
      return
    }
    host.style.display = ''
    const logo = info?.icon ? `<img class="logo" src="${info.icon}" alt="">` : ''
    const rows = [
      `<h2>${esc(info?.name ?? 'DeepSeek Harness')}</h2>`,
      info?.tagline ? `<p class="muted">${esc(info.tagline)}</p>` : '',
      info?.version ? `<p class="muted">版本 v${esc(info.version)}</p>` : '',
      info?.dshVersion ? `<p class="muted">dsh v${esc(info.dshVersion)}</p>` : '',
      `<p class="muted copyright">${esc(info?.copyright ?? '')}</p>`,
    ].join('')
    card.innerHTML = `<div class="about">${logo}${rows}</div><div class="row"><button class="primary" data-action="close">确定</button></div>`
    card.querySelector('button[data-action="close"]')?.addEventListener('click', () => {
      open = false
      render(null)
    })
  }

  ipcRenderer.on(ABOUT_DIALOG, (_event, info) => {
    open = true
    render(info)
  })
  // Clicking the backdrop (anything inside :host but outside .card) dismisses.
  host.addEventListener('click', (event) => {
    if (!open || event.target !== host) return
    open = false
    render(null)
  })
  window.addEventListener(
    'keydown',
    (event) => {
      if (!open || event.key !== 'Escape') return
      event.stopPropagation()
      open = false
      render(null)
    },
    true,
  )

  render(null)
}

window.addEventListener('DOMContentLoaded', () => {
  installWindowsMenu()
  installUpdateDialog()
  installAboutDialog()
}, { once: true })
