import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const source = process.env.DSH_SOURCE_ROOT
if (!source) throw new Error('Set DSH_SOURCE_ROOT to the source-build Git checkout')
const root = fileURLToPath(new URL('../dsh-host-patch/sources/', import.meta.url))
const fixtures = fileURLToPath(new URL('../tests/fixtures/dsh-host-patch/sources/', import.meta.url))
const series = JSON.parse(readFileSync(join(root, 'series.json'), 'utf8'))
const manifest = {}
const git = (...args) => execFileSync('git', args, { cwd: source, maxBuffer: 64 * 1024 * 1024 })
const revision = name => git('rev-parse', name).toString().trim()
const record = bytes => ({ bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') })
mkdirSync(fixtures, { recursive: true })
for (const [release, entry] of Object.entries(series.releases)) {
  git('merge-base', '--is-ancestor', entry.baseCommit, entry.sourceCommit)
  const commits = git('rev-list', '--reverse', `${entry.baseCommit}..${entry.sourceCommit}`).toString().trim().split('\n')
  const directory = mkdtempSync(join(tmpdir(), 'dsh-host-source-series-'))
  try {
    const patches = git('format-patch', '--no-signature', '--full-index', '--binary', '--output-directory', directory,
      `${entry.baseCommit}..${entry.sourceCommit}`).toString().trim().split('\n')
    if (patches.length !== commits.length || !patches.length) throw new Error(`Incomplete ${release} source history`)
    for (const name of readdirSync(join(root, release))) {
      if (!/^\d+-.+\.patch(?:\.gz)?$/.test(name)) throw new Error(`Unexpected source file: ${release}/${name}`)
      unlinkSync(join(root, release, name))
    }
    entry.patches = patches.map((patch, index) => {
      const bytes = readFileSync(patch)
      if (!bytes.toString().startsWith(`From ${commits[index]} `)) throw new Error(`Unordered ${release} source history`)
      const name = `${release}/${patch.slice(directory.length + 1)}`
      writeFileSync(join(root, `${name}.gz`), gzipSync(bytes))
      manifest[name] = record(bytes)
      return { file: `${name}.gz`, commit: commits[index] }
    })
    const touched = new Set(commits.flatMap(commit => git('diff-tree', '--no-commit-id', '--name-only', '-r', '-z', commit)
      .toString().split('\0').filter(Boolean)))
    const entries = git('ls-tree', '-r', '-z', '--full-tree', entry.baseCommit).toString().split('\0').filter(Boolean)
    const fixture = { index: '', blobs: {} }
    for (const item of entries) {
      const tab = item.indexOf('\t')
      const [mode, type, oid] = item.slice(0, tab).split(' ')
      const path = item.slice(tab + 1)
      fixture.index += `${mode} ${oid}\t${path}\0`
      if (type === 'blob' && touched.has(path)) fixture.blobs[oid] = git('cat-file', 'blob', oid).toString('base64')
    }
    const bytes = Buffer.from(JSON.stringify(fixture))
    writeFileSync(join(fixtures, `${release}.base.json.gz`), gzipSync(bytes))
    entry.fixture = { file: `${release}.base.json.gz`, ...record(bytes) }
    entry.baseTree = revision(`${entry.baseCommit}^{tree}`)
    entry.sourceTree = revision(`${entry.sourceCommit}^{tree}`)
    console.log(`${release}: ${entry.patches.length} ordered format-patch commits; source tree ${entry.sourceTree}`)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
writeFileSync(join(root, 'series.json'), JSON.stringify(series, null, 2) + '\n')
writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
