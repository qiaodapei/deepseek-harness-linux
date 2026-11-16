#!/usr/bin/env node
// Update the pinned dsh version in package.json and every version reference in
// README.md. The lockfile and node_modules are refreshed by `npm install`
// afterwards.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const [current, next] = process.argv.slice(2)

if (!current || !next) {
  console.error('usage: node scripts/update-dsh-version.mjs <current> <next>')
  process.exit(1)
}

if (!/^[0-9A-Za-z.+-]+$/.test(current) || !/^[0-9A-Za-z.+-]+$/.test(next)) {
  console.error(`invalid version string: current=${current} next=${next}`)
  process.exit(1)
}

if (current === next) {
  console.log(`dsh is already at ${current}; nothing to update`)
  process.exit(0)
}

function replaceAll(file, from, to, minCount = 1) {
  const path = join(root, file)
  const source = readFileSync(path, 'utf8')
  const count = source.split(from).length - 1
  if (count < minCount) {
    throw new Error(`${file}: expected at least ${minCount} occurrence(s) of ${from}, found ${count}`)
  }
  writeFileSync(path, source.split(from).join(to))
  console.log(`${file}: updated ${count} occurrence(s)`)
}

try {
  replaceAll('package.json', `"@deepseek-ai/dsh": "${current}"`, `"@deepseek-ai/dsh": "${next}"`)
  replaceAll(
    'package.json',
    `@deepseek-ai/dsh-subprocess-local@${current}`,
    `@deepseek-ai/dsh-subprocess-local@${next}`,
  )
  replaceAll('README.md', current, next, 2)
  console.log(`dsh version updated: ${current} -> ${next}`)
} catch (error) {
  console.error(error.message)
  process.exit(1)
}
