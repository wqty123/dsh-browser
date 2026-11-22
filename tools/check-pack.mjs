#!/usr/bin/env node
// CI-only: check what `npm pack` would publish from a built package, without writing a tarball.
//
//   node tools/check-pack.mjs   (from the package directory, after `node scripts/build.mjs`)
//
// Fails when electron is back among the installed dependencies, when the DSH source snapshots in
// dsh-host-patch/sources would ship, or when a published entry point is missing.
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const result = spawnSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  shell: process.platform === 'win32',
})
if (result.status !== 0) {
  console.error(result.stderr)
  process.exit(result.status ?? 1)
}
const [pack] = JSON.parse(result.stdout)
const files = new Set(pack.files.map(file => file.path.replaceAll('\\', '/')))
const manifest = JSON.parse(readFileSync('package.json', 'utf8'))

const problems = []
for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundleDependencies']) {
  const names = Array.isArray(manifest[field]) ? manifest[field] : Object.keys(manifest[field] ?? {})
  if (names.includes('electron')) problems.push(`electron is listed in ${field}`)
}
const sources = [...files].filter(path => path.startsWith('dsh-host-patch/sources/'))
if (sources.length > 0) problems.push(`dsh-host-patch/sources is packed (${String(sources.length)} files, e.g. ${sources[0]})`)
const entries = [manifest.publishConfig?.exports?.['.'], manifest.publishConfig?.exports?.['./client']]
for (const entry of entries.filter(entry => typeof entry === 'string')) {
  if (!files.has(entry.replace(/^\.\//, ''))) problems.push(`published entry ${entry} is not packed`)
}

console.log(`[pack] ${pack.filename}: ${String(pack.entryCount)} files, ${String(pack.size)} bytes`)
if (problems.length > 0) {
  for (const problem of problems) console.error(`[pack] ${problem}`)
  process.exit(1)
}
console.log('[pack] no electron dependency, no dsh-host-patch/sources, entry points present')
