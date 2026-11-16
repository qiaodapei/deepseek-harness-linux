#!/usr/bin/env node
// Regression tests for the pure update helpers.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compareVersions,
  downloadAssetToFile,
  formatBytes,
  installAppImage,
  normalizeRelease,
  parseSha256,
  parseVersion,
  selectLatestRelease,
} from '../desktop/updater.mjs'

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

assert.equal(normalizeRelease(release('dsh-v0.2.2-rc.3', 'DeepSeek-Harness-1.0.0-x86_64.AppImage')), null)
const normalized = normalizeRelease(release('v1.1.0', 'DeepSeek-Harness-1.1.0-x86_64.AppImage'))
assert.equal(normalized.version, '1.1.0')
assert.equal(normalized.appImage.name, 'DeepSeek-Harness-1.1.0-x86_64.AppImage')
assert.equal(normalized.shaAsset.name.endsWith('.sha256'), true)

const releases = [
  release('dsh-v0.2.2-rc.3', 'DeepSeek-Harness-1.0.0-x86_64.AppImage'),
  release('v1.1.0', 'DeepSeek-Harness-1.1.0-x86_64.AppImage'),
  release('v1.2.0', 'DeepSeek-Harness-1.2.0-x86_64.AppImage'),
  release('v1.0.9', 'DeepSeek-Harness-1.0.9-x86_64.AppImage'),
]
assert.equal(selectLatestRelease(releases, '1.0.0').version, '1.2.0')
assert.equal(selectLatestRelease(releases, '1.2.0'), null)
assert.equal(selectLatestRelease(releases, '1.3.0'), null)

assert.equal(parseSha256(`${sha}  file.AppImage\n`), sha)
assert.equal(parseSha256('not a hash'), null)
assert.equal(formatBytes(0), '0 B')
assert.equal(formatBytes(355 * 1024 * 1024), '355 MB')

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
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log('updater tests passed')
