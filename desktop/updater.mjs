// Update helpers shared by the Electron main process and the updater tests.
// This module only uses Node APIs so it can be tested without launching Electron.

import { createHash } from 'node:crypto'
import { createWriteStream, readFileSync } from 'node:fs'
import { constants } from 'node:fs'
import {
  access,
  chmod,
  copyFile,
  mkdir,
  open,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const DEFAULT_REPO = 'qiaodapei/deepseek-harness-linux'
export const USER_AGENT = 'DeepSeek-Harness-Desktop'

export class UpdateError extends Error {
  constructor(message, { code = 'update-error', status, cause } = {}) {
    super(message, cause ? { cause } : undefined)
    this.name = 'UpdateError'
    this.code = code
    this.status = status
  }
}

export function parseVersion(input) {
  if (typeof input !== 'string') return null
  let text = input.trim()
  if (text.startsWith('dsh-v')) text = text.slice(5)
  else if (text.startsWith('v')) text = text.slice(1)
  text = text.split('+')[0]

  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(text)
  if (!match) return null

  const prerelease = match[4] ? match[4].split('.') : []
  if (prerelease.some((id) => !id || !/^[0-9A-Za-z-]+$/.test(id))) return null

  return {
    raw: text,
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  }
}

export function compareVersions(left, right) {
  const a = typeof left === 'string' ? parseVersion(left) : left
  const b = typeof right === 'string' ? parseVersion(right) : right
  if (!a || !b) throw new TypeError(`invalid version: ${String(left)} / ${String(right)}`)

  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] < b[key] ? -1 : 1
  }

  if (!a.prerelease.length && !b.prerelease.length) return 0
  if (!a.prerelease.length) return 1
  if (!b.prerelease.length) return -1

  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const aId = a.prerelease[index]
    const bId = b.prerelease[index]
    if (aId === undefined) return -1
    if (bId === undefined) return 1
    if (aId === bId) continue

    const aNumeric = /^\d+$/.test(aId)
    const bNumeric = /^\d+$/.test(bId)
    if (aNumeric && bNumeric) return Number(aId) < Number(bId) ? -1 : 1
    if (aNumeric) return -1
    if (bNumeric) return 1
    return aId < bId ? -1 : 1
  }
  return 0
}

export function formatBytes(bytes) {
  const value = Number(bytes)
  if (!Number.isFinite(value) || value < 0) return '未知大小'
  if (value < 1024) return `${value} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let size = value / 1024
  let unit = 0
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024
    unit += 1
  }
  return `${size >= 10 ? size.toFixed(0) : size.toFixed(1)} ${units[unit]}`
}

export function parseSha256(text) {
  const match = /\b([0-9a-f]{64})\b/i.exec(String(text || ''))
  return match ? match[1].toLowerCase() : null
}

export function readInstalledDshVersion(projectRoot, fallback = 'unknown') {
  try {
    const manifest = JSON.parse(
      readFileSync(join(projectRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'),
    )
    return typeof manifest.version === 'string' && manifest.version ? manifest.version : fallback
  } catch {
    return fallback
  }
}

export function readUpdateState(file) {
  const defaults = {
    autoCheck: true,
    lastAttempt: 0,
    lastCheck: 0,
    etag: '',
    latest: null,
    notifiedVersion: '',
    installedVersion: '',
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object') return defaults
    return {
      ...defaults,
      ...parsed,
      autoCheck: parsed.autoCheck !== false,
    }
  } catch {
    return defaults
  }
}

export async function writeUpdateState(file, state) {
  await mkdir(dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
  await rename(temporary, file)
}

export function normalizeRelease(raw, { repo = DEFAULT_REPO } = {}) {
  if (!raw || raw.draft) return null

  const tag = typeof raw.tag_name === 'string' ? raw.tag_name : ''
  const tagMatch = /^dsh-v(.+)$/i.exec(tag)
  if (!tagMatch) return null

  const version = parseVersion(tagMatch[1])
  if (!version) return null

  const assets = Array.isArray(raw.assets) ? raw.assets : []
  const appImages = assets.filter((asset) => {
    if (!asset || typeof asset.name !== 'string' || typeof asset.url !== 'string') return false
    return /\.AppImage$/i.test(asset.name) && !/\.sha256$/i.test(asset.name)
  })
  const archPattern = process.arch === 'arm64' ? /aarch64|arm64/i : /x86_64|amd64/i
  const archAssets = appImages.filter((asset) => archPattern.test(asset.name))
  const expectedName = `DeepSeek-Harness-${version.raw}-`
  const appImage =
    archAssets.find((asset) => asset.name.startsWith(expectedName)) || archAssets[0]
  if (!appImage) return null

  const shaAsset = assets.find((asset) => asset.name === `${appImage.name}.sha256`)
  if (!shaAsset || typeof shaAsset.url !== 'string') return null

  const notes = typeof raw.body === 'string' ? raw.body : ''
  return {
    tag,
    version: version.raw,
    name: typeof raw.name === 'string' && raw.name ? raw.name : tag,
    url: typeof raw.html_url === 'string' ? raw.html_url : `https://github.com/${repo}/releases/tag/${tag}`,
    notes,
    publishedAt: typeof raw.published_at === 'string' ? raw.published_at : null,
    prerelease: Boolean(raw.prerelease),
    appImage: {
      name: basename(appImage.name),
      size: Number(appImage.size) || 0,
      url: appImage.url,
      browserDownloadUrl:
        typeof appImage.browser_download_url === 'string' ? appImage.browser_download_url : '',
    },
    shaAsset: {
      name: basename(shaAsset.name),
      size: Number(shaAsset.size) || 0,
      url: shaAsset.url,
      browserDownloadUrl:
        typeof shaAsset.browser_download_url === 'string' ? shaAsset.browser_download_url : '',
    },
  }
}

export function selectLatestRelease(releases, currentVersion) {
  const current = parseVersion(currentVersion)
  if (!current) return null

  let latest = null
  for (const raw of Array.isArray(releases) ? releases : []) {
    const release = normalizeRelease(raw)
    if (!release) continue
    if (compareVersions(release.version, current) <= 0) continue
    if (!latest || compareVersions(release.version, latest.version) > 0) latest = release
  }
  return latest
}

function requestHeaders(token, accept) {
  const headers = {
    Accept: accept,
    'User-Agent': USER_AGENT,
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (token) headers.Authorization = `Bearer ${token}`
  return headers
}

async function apiError(response, repo, hasToken) {
  let detail = ''
  try {
    const body = await response.json()
    if (body && typeof body.message === 'string') detail = body.message
  } catch {}

  if (response.status === 404) {
    return new UpdateError(
      hasToken
        ? `更新源不存在，或 token 无权访问：${repo}`
        : `更新源不可访问（HTTP 404）。如果仓库是私有的，请配置只读 GitHub token，或把仓库设为公开。`,
      { code: 'github-api', status: 404 },
    )
  }
  if (response.status === 401) {
    return new UpdateError('GitHub token 无效或已过期。', { code: 'github-auth', status: 401 })
  }
  if (response.status === 403 && /rate limit/i.test(detail)) {
    return new UpdateError('GitHub API 速率限制已用尽，请稍后再试或配置 token。', {
      code: 'rate-limit',
      status: 403,
    })
  }
  if (response.status === 403) {
    return new UpdateError(
      `GitHub 拒绝访问（HTTP 403${detail ? `：${detail}` : ''}）。请检查 token 权限。`,
      { code: 'github-auth', status: 403 },
    )
  }
  return new UpdateError(
    `GitHub API 请求失败（HTTP ${response.status}${detail ? `：${detail}` : ''}）`,
    { code: 'github-api', status: response.status },
  )
}

export async function fetchReleases({ repo = DEFAULT_REPO, token = '', etag = '', timeoutMs = 30_000 } = {}) {
  let response
  try {
    response = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=100`, {
      headers: {
        ...requestHeaders(token, 'application/vnd.github+json'),
        ...(etag ? { 'If-None-Match': etag } : {}),
      },
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (error) {
    throw new UpdateError(`无法连接更新源：${error.message}`, { code: 'network', cause: error })
  }

  if (response.status === 304) {
    return { notModified: true, etag, releases: [] }
  }
  if (!response.ok) {
    throw await apiError(response, repo, Boolean(token))
  }

  let releases
  try {
    releases = await response.json()
  } catch (error) {
    throw new UpdateError('更新源返回了无效的 JSON。', { code: 'invalid-response', cause: error })
  }
  if (!Array.isArray(releases)) {
    throw new UpdateError('更新源返回了无效的 Release 列表。', { code: 'invalid-response' })
  }

  return {
    notModified: false,
    etag: response.headers.get('etag') || '',
    releases,
  }
}

// Apply the timeout to the request until response headers arrive. Once fetch()
// resolves, the body may legitimately take minutes to download (the AppImage is
// ~355 MB), so the timer is cleared and only the caller-provided abort signal
// remains active.
async function fetchWithHeaderTimeout(url, options, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('请求更新源超时')), timeoutMs)
  timer.unref?.()
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal
  try {
    return await fetch(url, { ...options, signal })
  } finally {
    clearTimeout(timer)
  }
}

async function openAsset(asset, token, { signal, timeoutMs = 60_000 } = {}) {
  if (!asset || typeof asset.url !== 'string' || !asset.url) {
    throw new UpdateError('更新包缺少下载地址。', { code: 'invalid-asset' })
  }

  const direct = !token && asset.browserDownloadUrl
  const url = direct || asset.url
  const headers = direct
    ? { 'User-Agent': USER_AGENT }
    : requestHeaders(token, 'application/octet-stream')

  let response
  try {
    response = await fetchWithHeaderTimeout(url, { headers, redirect: 'manual', signal }, timeoutMs)
  } catch (error) {
    if (signal?.aborted) {
      throw new UpdateError('下载已取消。', { code: 'aborted', cause: error })
    }
    throw new UpdateError(`无法下载更新文件：${error.message}`, { code: 'network', cause: error })
  }

  if ([301, 302, 303, 307, 308].includes(response.status)) {
    const location = response.headers.get('location')
    try {
      await response.body?.cancel()
    } catch {}
    if (!location) {
      throw new UpdateError('更新源返回了无效的下载重定向。', { code: 'invalid-response' })
    }

    try {
      response = await fetchWithHeaderTimeout(
        location,
        { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow', signal },
        timeoutMs,
      )
    } catch (error) {
      if (signal?.aborted) {
        throw new UpdateError('下载已取消。', { code: 'aborted', cause: error })
      }
      throw new UpdateError(`无法下载更新文件：${error.message}`, { code: 'network', cause: error })
    }
  }

  if (!response.ok) {
    throw new UpdateError(`下载更新文件失败（HTTP ${response.status}）。`, {
      code: 'download',
      status: response.status,
    })
  }
  return response
}

export async function fetchAssetText(asset, { token = '', signal, timeoutMs = 30_000 } = {}) {
  const response = await openAsset(asset, token, { signal, timeoutMs })
  const length = Number(response.headers.get('content-length')) || 0
  if (length > 1024 * 1024) {
    throw new UpdateError('校验文件异常（超过 1 MB）。', { code: 'invalid-asset' })
  }
  const text = await response.text()
  if (Buffer.byteLength(text) > 1024 * 1024) {
    throw new UpdateError('校验文件异常（超过 1 MB）。', { code: 'invalid-asset' })
  }
  return text
}

export async function ensureFreeSpace(directory, requiredBytes) {
  await mkdir(directory, { recursive: true })
  const info = await statfs(directory)
  const free = Number(info.bavail) * Number(info.bsize)
  const needed = Number(requiredBytes) || 0
  if (free < needed * 1.1) {
    throw new UpdateError(
      `磁盘空间不足：更新包约 ${formatBytes(needed)}，可用空间 ${formatBytes(free)}。`,
      { code: 'disk-space' },
    )
  }
}

export async function downloadAssetToFile(
  asset,
  destination,
  { token = '', expectedSha256 = '', onProgress, signal, timeoutMs = 60_000 } = {},
) {
  await mkdir(dirname(destination), { recursive: true })
  const temporary = `${destination}.part`
  await rm(temporary, { force: true })

  const response = await openAsset(asset, token, { signal, timeoutMs })
  if (!response.body) {
    throw new UpdateError('更新包没有可读取的数据流。', { code: 'download' })
  }

  const total = Number(response.headers.get('content-length')) || 0
  const hash = createHash('sha256')
  let received = 0
  const source = Readable.fromWeb(response.body)
  source.on('data', (chunk) => {
    received += chunk.length
    hash.update(chunk)
    try {
      onProgress?.(received, total)
    } catch {}
  })

  const output = createWriteStream(temporary, { mode: 0o755 })
  try {
    await pipeline(source, output)
  } catch (error) {
    await rm(temporary, { force: true })
    if (error?.name === 'AbortError') {
      throw new UpdateError('下载已取消。', { code: 'aborted', cause: error })
    }
    throw new UpdateError(`下载更新文件失败：${error.message}`, { code: 'download', cause: error })
  }

  const sha256 = hash.digest('hex')
  if (expectedSha256 && sha256 !== expectedSha256.toLowerCase()) {
    await rm(temporary, { force: true })
    throw new UpdateError('SHA256 校验失败，更新文件已删除。', { code: 'sha256-mismatch' })
  }

  try {
    await chmod(temporary, 0o755)
    const handle = await open(temporary, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, destination)
  } catch (error) {
    await rm(temporary, { force: true })
    throw new UpdateError(`保存更新文件失败：${error.message}`, { code: 'write-failed', cause: error })
  }

  return { path: destination, size: received, sha256 }
}

export async function isDirectoryWritable(directory) {
  try {
    await access(directory, constants.W_OK)
    return true
  } catch {
    return false
  }
}

export async function installAppImage({ source, target }) {
  const targetInfo = await stat(target)
  if (!targetInfo.isFile()) {
    throw new UpdateError(`当前 AppImage 路径不是文件：${target}`, { code: 'invalid-target' })
  }

  const directory = dirname(target)
  if (!(await isDirectoryWritable(directory))) {
    throw new UpdateError(`没有写入权限：${directory}`, { code: 'permission' })
  }

  const sameDirectory = dirname(source) === directory
  const temporary = join(directory, `.${basename(target)}.install-${process.pid}`)

  try {
    if (sameDirectory) {
      await chmod(source, 0o755)
      await rename(source, target)
      return { target }
    }

    const sourceInfo = await stat(source)
    await ensureFreeSpace(directory, sourceInfo.size)
    await copyFile(source, temporary)
    await chmod(temporary, 0o755)
    const handle = await open(temporary, 'r+')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, target)
    await rm(source, { force: true })
    return { target }
  } catch (error) {
    await rm(temporary, { force: true })
    if (error instanceof UpdateError) throw error
    throw new UpdateError(`无法替换当前 AppImage：${error.message}`, {
      code: 'install-failed',
      cause: error,
    })
  }
}
