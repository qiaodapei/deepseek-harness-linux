#!/usr/bin/env node
// Regression tests for the pure update helpers.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compareVersions,
  downloadAssetToFile,
  fetchLatestNpmVersion,
  fetchNpmDistTags,
  formatBytes,
  installAppImage,
  isStableChannelVersion,
  normalizeRelease,
  parseSha256,
  parseVersion,
  selectLatestNpmVersion,
  selectLatestRelease,
} from '../desktop/updater.mjs'
import {
  activateRuntime,
  clearRuntimeBroken,
  markRuntimeBroken,
  pruneRuntimeVersions,
  resolveActiveRuntime,
  runtimeLayout,
} from '../desktop/runtime.mjs'

const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
assert.equal(
  manifest.version,
  manifest.devDependencies['@deepseek-ai/dsh'],
  'package.json version must match the bundled dsh version',
)

assert.equal(parseVersion('v1.2.3').raw, '1.2.3')
assert.equal(parseVersion('dsh-v0.2.2-rc.3').raw, '0.2.2-rc.3')
assert.equal(parseVersion('1.2.3+linux').raw, '1.2.3')
assert.equal(parseVersion('not-a-version'), null)

assert.equal(compareVersions('1.0.0', '1.0.0'), 0)
assert.equal(compareVersions('1.0.1', '1.0.0'), 1)
assert.equal(compareVersions('1.0.0-rc.10', '1.0.0-rc.3'), 1)
assert.equal(compareVersions('1.0.0-rc.3', '1.0.0'), -1)
assert.equal(compareVersions('1.0.0-alpha', '1.0.0-beta'), -1)
assert.equal(compareVersions('1.0.0-rc.1', '1.0.0-rc.1.1'), -1)

const sha = 'a'.repeat(64)
const release = (tag, name, extra = {}) => ({
  tag_name: tag,
  name,
  body: `内置 dsh ${extra.dsh || '0.2.2-rc.3'}`,
  html_url: `https://example.test/releases/${tag}`,
  published_at: '2026-11-16T00:00:00Z',
  draft: false,
  prerelease: false,
  assets: [
    {
      name,
      size: 1234,
      url: `https://api.example.test/assets/${tag}/${name}`,
      browser_download_url: `https://example.test/download/${name}`,
    },
    {
      name: `${name}.sha256`,
      size: 105,
      url: `https://api.example.test/assets/${tag}/${name}.sha256`,
      browser_download_url: `https://example.test/download/${name}.sha256`,
    },
  ],
  ...extra,
})

assert.equal(
  normalizeRelease(release('v0.2.2-rc.3', 'DeepSeek-Harness-0.2.2-rc.3-x86_64.AppImage')),
  null,
)
const normalized = normalizeRelease(
  release('dsh-v0.2.2-rc.3', 'DeepSeek-Harness-0.2.2-rc.3-x86_64.AppImage'),
)
assert.equal(normalized.version, '0.2.2-rc.3')
assert.equal(normalized.appImage.name, 'DeepSeek-Harness-0.2.2-rc.3-x86_64.AppImage')
assert.equal(normalized.shaAsset.name.endsWith('.sha256'), true)

const mixedAssets = release('dsh-v0.2.2-rc.4', 'DeepSeek-Harness-0.2.2-rc.4-x86_64.AppImage')
mixedAssets.assets.unshift({
  name: 'DeepSeek-Harness-0.2.2-rc.3-x86_64.AppImage',
  size: 1234,
  url: 'https://api.example.test/assets/mixed/old.AppImage',
  browser_download_url: 'https://example.test/download/old.AppImage',
})
assert.equal(
  normalizeRelease(mixedAssets).appImage.name,
  'DeepSeek-Harness-0.2.2-rc.4-x86_64.AppImage',
)

const releases = [
  release('dsh-v0.2.2-rc.3', 'DeepSeek-Harness-0.2.2-rc.3-x86_64.AppImage'),
  release('dsh-v0.2.2-rc.4', 'DeepSeek-Harness-0.2.2-rc.4-x86_64.AppImage'),
  release('dsh-v0.2.3', 'DeepSeek-Harness-0.2.3-x86_64.AppImage'),
  release('dsh-v0.2.1', 'DeepSeek-Harness-0.2.1-x86_64.AppImage'),
  release('v1.1.0', 'DeepSeek-Harness-1.1.0-x86_64.AppImage'),
]
assert.equal(selectLatestRelease(releases, '0.2.1').version, '0.2.3')
assert.equal(selectLatestRelease(releases, '0.2.2-rc.2').version, '0.2.3')
assert.equal(selectLatestRelease(releases, '0.2.2-rc.3').version, '0.2.3')
assert.equal(selectLatestRelease(releases, '0.2.3'), null)
assert.equal(selectLatestRelease(releases, '0.2.4'), null)

// Alpha/beta releases are preview-only and must not be selected for the
// stable channel, even though semver sorts them above the current rc.
const previewReleases = [
  release('dsh-v0.2.2-rc.5', 'DeepSeek-Harness-0.2.2-rc.5-x86_64.AppImage'),
  release('dsh-v0.2.3-alpha.2', 'DeepSeek-Harness-0.2.3-alpha.2-x86_64.AppImage'),
]
assert.equal(selectLatestRelease(previewReleases, '0.2.2-rc.4').version, '0.2.2-rc.5')
assert.equal(
  selectLatestRelease(previewReleases, '0.2.2-rc.4', { stableOnly: false }).version,
  '0.2.3-alpha.2',
)

assert.equal(parseSha256(`${sha}  file.AppImage\n`), sha)
assert.equal(parseSha256('not a hash'), null)
assert.equal(formatBytes(0), '0 B')
assert.equal(formatBytes(355 * 1024 * 1024), '355 MB')

assert.equal(isStableChannelVersion('0.2.2-rc.5'), true)
assert.equal(isStableChannelVersion('0.2.3'), true)
assert.equal(isStableChannelVersion('0.2.3-alpha.2'), false)
assert.equal(isStableChannelVersion('0.2.3-beta.1'), false)
assert.equal(isStableChannelVersion('0.2.3-dev.1'), false)
assert.equal(isStableChannelVersion('not-a-version'), false)

// The stable channel is npm's `latest` tag only. Never promote a newer
// `next`/`beta`/`alpha` preview automatically.
assert.equal(selectLatestNpmVersion({ latest: '0.2.2-rc.1', next: '0.2.2-rc.5' }), '0.2.2-rc.1')
assert.equal(selectLatestNpmVersion({ latest: '0.2.2-rc.5', next: '0.2.2-rc.5' }), '0.2.2-rc.5')
assert.equal(
  selectLatestNpmVersion({ latest: '0.2.2-rc.5', next: '0.2.2-rc.5', alpha: '0.2.3-alpha.2' }),
  '0.2.2-rc.5',
)
assert.equal(selectLatestNpmVersion({ latest: '0.2.3' }), '0.2.3')
assert.equal(selectLatestNpmVersion({ latest: '0.2.3-alpha.2' }), null)
assert.equal(selectLatestNpmVersion({ latest: '0.2.3-beta.1' }), null)
assert.equal(selectLatestNpmVersion({ next: '0.2.2-rc.5' }), null)
assert.equal(selectLatestNpmVersion({ latest: 'not-a-version' }), null)
assert.equal(selectLatestNpmVersion({}), null)

async function withServer(handler, run) {
  const server = createServer(handler)
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  try {
    return await run(`http://127.0.0.1:${address.port}`)
  } finally {
    server.closeAllConnections?.()
    await new Promise((resolve) => server.close(resolve))
  }
}

function slowResponse(payload, intervalMs = 40) {
  return (_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': payload.length,
    })
    let offset = 0
    const timer = setInterval(() => {
      if (offset >= payload.length) {
        clearInterval(timer)
        response.end()
        return
      }
      response.write(payload.subarray(offset, offset + 4))
      offset += 4
    }, intervalMs)
    response.on('close', () => clearInterval(timer))
  }
}

const root = await mkdtemp(join(tmpdir(), 'dsh-updater-test-'))
try {
  const payload = Buffer.from('hello update payload')
  const payloadSha = createHash('sha256').update(payload).digest('hex')
  const source = join(root, 'downloads', 'update.AppImage')
  const dataUrl = `data:application/octet-stream;base64,${payload.toString('base64')}`
  let progress = 0
  const result = await downloadAssetToFile(
    { name: 'update.AppImage', url: dataUrl, browserDownloadUrl: '' },
    source,
    {
      expectedSha256: payloadSha,
      onProgress: (received) => {
        progress = received
      },
    },
  )
  assert.equal(result.size, payload.length)
  assert.equal(progress, payload.length)
  assert.deepEqual(await readFile(source), payload)
  assert.equal((await stat(source)).mode & 0o777, 0o755)

  await assert.rejects(
    downloadAssetToFile(
      { name: 'update.AppImage', url: dataUrl, browserDownloadUrl: '' },
      join(root, 'downloads', 'bad.AppImage'),
      { expectedSha256: '0'.repeat(64) },
    ),
    /SHA256/,
  )

  const slowPayload = Buffer.from('slow http update payload')
  const slowSha = createHash('sha256').update(slowPayload).digest('hex')

  // Headers arrive immediately, but the body takes longer than the header
  // timeout. The download must still succeed.
  await withServer(slowResponse(slowPayload), async (base) => {
    const slowTarget = join(root, 'downloads', 'slow.AppImage')
    const slowResult = await downloadAssetToFile(
      { name: 'slow.AppImage', url: `${base}/slow`, browserDownloadUrl: '' },
      slowTarget,
      { expectedSha256: slowSha, timeoutMs: 100 },
    )
    assert.equal(slowResult.size, slowPayload.length)
    assert.deepEqual(await readFile(slowTarget), slowPayload)
  })

  // A server that never sends headers should hit the timeout.
  await withServer(
    (_request, response) => {
      setTimeout(() => {
        if (response.destroyed) return
        response.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': slowPayload.length,
        })
        response.end(slowPayload)
      }, 300)
    },
    async (base) => {
      await assert.rejects(
        downloadAssetToFile(
          { name: 'slow.AppImage', url: `${base}/slow`, browserDownloadUrl: '' },
          join(root, 'downloads', 'timeout.AppImage'),
          { timeoutMs: 100 },
        ),
        /无法下载更新文件/,
      )
    },
  )

  // User cancellation during the body must be reported as aborted.
  await withServer(slowResponse(slowPayload), async (base) => {
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 50)
    await assert.rejects(
      downloadAssetToFile(
        { name: 'slow.AppImage', url: `${base}/slow`, browserDownloadUrl: '' },
        join(root, 'downloads', 'aborted.AppImage'),
        { signal: controller.signal, timeoutMs: 1000 },
      ),
      (error) => error.code === 'aborted',
    )
  })

  const target = join(root, 'apps', 'DeepSeek-Harness.AppImage')
  await mkdir(join(root, 'apps'), { recursive: true })
  await writeFile(target, 'old')
  await chmod(target, 0o755)
  await installAppImage({ source, target })
  assert.deepEqual(await readFile(target), payload)
  assert.equal((await stat(target)).mode & 0o777, 0o755)
  assert.equal(
    await readFile(source).then(
      () => false,
      () => true,
    ),
    true,
  )

  // npm dist-tags: only `latest` is the stable channel; alpha is ignored.
  await withServer(
    (request, response) => {
      if (!request.url?.includes('@deepseek-ai')) {
        response.writeHead(404)
        response.end()
        return
      }
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(
        JSON.stringify({
          'dist-tags': { latest: '0.2.2-rc.5', next: '0.2.2-rc.5', alpha: '0.2.3-alpha.2' },
        }),
      )
    },
    async (base) => {
      const tags = await fetchNpmDistTags({ registry: base })
      assert.equal(tags.tags.next, '0.2.2-rc.5')
      const latest = await fetchLatestNpmVersion({ registries: [base] })
      assert.equal(latest.version, '0.2.2-rc.5')
      assert.equal(latest.registry, base)
    },
  )

  // Managed runtime layout, activation, fallback and pruning.
  const dataDir = join(root, 'data')
  const bundledRoot = join(root, 'bundled')
  const fakeRuntime = async (version) => {
    const dir = join(runtimeLayout(dataDir).versions, version)
    await mkdir(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), { recursive: true })
    await mkdir(join(dir, 'bin'), { recursive: true })
    await writeFile(
      join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
      JSON.stringify({ version }),
    )
    await writeFile(join(dir, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '')
    await writeFile(join(dir, 'bin', 'dsh'), '#!/bin/sh\n')
    return dir
  }
  await fakeRuntime('0.2.2-rc.4')
  const rc5 = await fakeRuntime('0.2.2-rc.5')
  await mkdir(join(bundledRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib'), {
    recursive: true,
  })
  await mkdir(join(bundledRoot, 'bin'), { recursive: true })
  await writeFile(
    join(bundledRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    JSON.stringify({ version: '0.2.2-rc.3' }),
  )
  await writeFile(join(bundledRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'), '')
  await writeFile(join(bundledRoot, 'bin', 'dsh'), '#!/bin/sh\n')

  let resolved = resolveActiveRuntime({ bundledRoot, dataDir })
  assert.equal(resolved.source, 'bundled')
  assert.equal(resolved.version, '0.2.2-rc.3')

  await activateRuntime(dataDir, '0.2.2-rc.5')
  resolved = resolveActiveRuntime({ bundledRoot, dataDir })
  assert.equal(resolved.source, 'managed')
  assert.equal(resolved.version, '0.2.2-rc.5')
  assert.equal(resolved.root, rc5)

  await markRuntimeBroken(dataDir, '0.2.2-rc.5')
  assert.equal(resolveActiveRuntime({ bundledRoot, dataDir }).source, 'bundled')
  await clearRuntimeBroken(dataDir, '0.2.2-rc.5')
  assert.equal(resolveActiveRuntime({ bundledRoot, dataDir }).source, 'managed')

  const removed = await pruneRuntimeVersions(dataDir, ['0.2.2-rc.5'])
  assert.deepEqual(removed, ['0.2.2-rc.4'])
  assert.equal(resolveActiveRuntime({ bundledRoot, dataDir }).version, '0.2.2-rc.5')
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log('updater tests passed')
