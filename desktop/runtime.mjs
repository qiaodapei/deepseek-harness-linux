// Managed dsh runtime helpers.
//
// The AppImage ships a complete dsh runtime, but it lives on a read-only
// squashfs mount. To update dsh without downloading a new AppImage we install
// the npm package into a writable user directory and point `current` at it.
// The bundled runtime stays untouched as a fallback.

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { chmod, mkdir, readFile, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { compareVersions } from './updater.mjs'

export const DEFAULT_REGISTRY = 'https://registry.npmmirror.com'
export const FALLBACK_REGISTRY = 'https://registry.npmjs.org'

// Native modules and postinstall hooks required by dsh. pnpm only runs the
// lifecycle scripts of packages explicitly listed here.
export const BUILD_PACKAGES = [
  '@deepseek-ai/dsh-subprocess-local',
  'node-pty',
  'koffi',
  'protobufjs',
  '@google/genai',
  'sharp',
  'esbuild',
]

const DSH_LAUNCHER = `#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"
export PATH="$root/node_modules/.bin:$root/bin:\${PATH:-}"
exec node "$root/node_modules/@deepseek-ai/dsh/lib/bin.js" "$@"
`

const PNPM_LAUNCHER = `#!/usr/bin/env bash
set -euo pipefail
exec "\${DSH_PNPM_BIN:-pnpm}" "$@"
`

export function resolveDataDir(env = process.env) {
  return join(env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'deepseek-harness')
}

export function runtimeLayout(dataDir) {
  const root = join(dataDir, 'runtime')
  return {
    root,
    store: join(root, 'store'),
    versions: join(root, 'versions'),
    current: join(root, 'current'),
  }
}

export function readDshVersion(root) {
  try {
    const manifest = JSON.parse(
      readFileSync(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), 'utf8'),
    )
    return typeof manifest.version === 'string' && manifest.version ? manifest.version : ''
  } catch {
    return ''
  }
}

export function isValidRuntime(root) {
  if (!root) return false
  if (existsSync(join(root, '.broken'))) return false
  if (!readDshVersion(root)) return false
  return (
    existsSync(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')) &&
    existsSync(join(root, 'bin', 'dsh'))
  )
}

export function resolveActiveRuntime({ bundledRoot, dataDir }) {
  const layout = runtimeLayout(dataDir)
  const bundledVersion = readDshVersion(bundledRoot)
  const bundled = {
    root: bundledRoot,
    version: bundledVersion || 'unknown',
    source: 'bundled',
    layout,
  }
  try {
    const root = realpathSync(layout.current)
    if (!isValidRuntime(root)) return bundled
    const version = readDshVersion(root)
    // A freshly installed AppImage may bundle a newer dsh than the managed
    // runtime. In that case the bundled copy wins.
    if (bundledVersion && version) {
      try {
        if (compareVersions(bundledVersion, version) > 0) return bundled
      } catch {}
    }
    return { root, version, source: 'managed', layout }
  } catch {
    return bundled
  }
}

export async function writeLaunchers(root) {
  const binDir = join(root, 'bin')
  await mkdir(binDir, { recursive: true })
  await writeFile(join(binDir, 'dsh'), DSH_LAUNCHER, { mode: 0o755 })
  await writeFile(join(binDir, 'pnpm'), PNPM_LAUNCHER, { mode: 0o755 })
  await chmod(join(binDir, 'dsh'), 0o755)
  await chmod(join(binDir, 'pnpm'), 0o755)
}

function run(command, args, { cwd, env, timeoutMs = 10 * 60 * 1000, signal, onLine } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
    })
    let settled = false
    let output = ''
    let timer = null

    const finish = (error, code) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      if (error) reject(error)
      else resolve({ code, output })
    }
    const onAbort = () => {
      try {
        child.kill('SIGTERM')
      } catch {}
      setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {}
      }, 5000).unref?.()
      finish(new Error('已取消。'))
    }
    const feed = (chunk) => {
      const text = chunk.toString('utf8')
      output = (output + text).slice(-256 * 1024)
      for (const line of text.split(/\r?\n/)) {
        if (line.trim()) onLine?.(line.trim())
      }
    }

    timer = setTimeout(() => {
      try {
        child.kill('SIGKILL')
      } catch {}
      finish(new Error(`命令超时：${command} ${args.join(' ')}`))
    }, timeoutMs)
    timer.unref?.()

    if (signal) {
      if (signal.aborted) {
        onAbort()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    child.stdout.on('data', feed)
    child.stderr.on('data', feed)
    child.once('error', (error) => finish(error))
    child.once('exit', (code) => {
      if (settled) return
      if (code === 0) finish(null, code)
      else finish(new Error(`命令失败（exit=${code}）：${command} ${args.join(' ')}\n${output.slice(-4000)}`))
    })
  })
}

function runtimeEnv(nodeBin) {
  const nodeDir = nodeBin ? join(nodeBin, '..') : ''
  return {
    ...process.env,
    PATH: [nodeDir, process.env.PATH || '/usr/local/bin:/usr/bin:/bin'].filter(Boolean).join(':'),
    npm_config_update_notifier: 'false',
  }
}

export async function installRuntimeVersion({
  dataDir,
  version,
  pnpmBin,
  nodeBin,
  registry = DEFAULT_REGISTRY,
  signal,
  onLine,
  timeoutMs = 20 * 60 * 1000,
}) {
  const layout = runtimeLayout(dataDir)
  await mkdir(layout.versions, { recursive: true })
  await mkdir(layout.store, { recursive: true })

  const target = join(layout.versions, version)
  if (isValidRuntime(target) && readDshVersion(target) === version) {
    return { root: target, version, reused: true, registry }
  }
  if (existsSync(target)) await rm(target, { recursive: true, force: true })

  const temp = join(layout.versions, `.tmp-${version}-${process.pid}-${Date.now()}`)
  await mkdir(temp, { recursive: true })
  await writeFile(
    join(temp, 'package.json'),
    `${JSON.stringify({ name: 'deepseek-harness-runtime', private: true }, null, 2)}\n`,
  )

  try {
    const args = [
      'add',
      `@deepseek-ai/dsh@${version}`,
      '--store-dir',
      layout.store,
      '--registry',
      registry,
      '--reporter=append-only',
      '--prefer-offline',
      '--config.confirmModulesPurge=false',
      ...BUILD_PACKAGES.map((name) => `--allow-build=${name}`),
    ]
    onLine?.(`install ${version} from ${registry}`)
    await run(pnpmBin, args, {
      cwd: temp,
      env: runtimeEnv(nodeBin),
      timeoutMs,
      signal,
      onLine,
    })

    const installed = readDshVersion(temp)
    if (installed !== version) {
      throw new Error(`安装后的 dsh 版本为 ${installed || '未知'}，期望 ${version}`)
    }

    await run(nodeBin || 'node', [join(temp, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '--version'], {
      cwd: temp,
      env: runtimeEnv(nodeBin),
      timeoutMs: 120_000,
      signal,
      onLine,
    })

    await writeLaunchers(temp)
    await rename(temp, target)
    return { root: target, version, reused: false, registry }
  } catch (error) {
    await rm(temp, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

export async function activateRuntime(dataDir, version) {
  const layout = runtimeLayout(dataDir)
  const target = join(layout.versions, version)
  if (!isValidRuntime(target)) {
    throw new Error(`dsh ${version} 的 runtime 不完整：${target}`)
  }
  const temporary = join(layout.root, `.current-${process.pid}-${Date.now()}`)
  await mkdir(layout.root, { recursive: true })
  await symlink(target, temporary)
  try {
    // rename() atomically replaces the previous symlink.
    await rename(temporary, layout.current)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
  return target
}

export async function markRuntimeBroken(dataDir, version) {
  const layout = runtimeLayout(dataDir)
  const root = join(layout.versions, version)
  if (!existsSync(root)) return
  await writeFile(join(root, '.broken'), `${new Date().toISOString()}\n`)
}

export async function clearRuntimeBroken(dataDir, version) {
  const layout = runtimeLayout(dataDir)
  await rm(join(layout.versions, version, '.broken'), { force: true })
}

export async function pruneRuntimeVersions(dataDir, keep = []) {
  const layout = runtimeLayout(dataDir)
  const keepSet = new Set(keep.filter(Boolean))
  try {
    const current = realpathSync(layout.current)
    keepSet.add(current.slice(current.lastIndexOf('/') + 1))
  } catch {}
  let entries = []
  try {
    entries = await readdir(layout.versions, { withFileTypes: true })
  } catch {
    return []
  }
  const removed = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    if (keepSet.has(entry.name)) continue
    await rm(join(layout.versions, entry.name), { recursive: true, force: true })
    removed.push(entry.name)
  }
  return removed
}

export async function removeStaleRuntimeDirs(dataDir) {
  const layout = runtimeLayout(dataDir)
  let entries = []
  try {
    entries = await readdir(layout.versions, { withFileTypes: true })
  } catch {
    entries = []
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.tmp-')) {
      await rm(join(layout.versions, entry.name), { recursive: true, force: true })
    }
  }
  try {
    for (const name of await readdir(layout.root)) {
      if (name.startsWith('.current-')) await rm(join(layout.root, name), { force: true })
    }
  } catch {}
}

export async function readRuntimeManifest(dataDir, version) {
  try {
    return JSON.parse(await readFile(join(runtimeLayout(dataDir).versions, version, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}
