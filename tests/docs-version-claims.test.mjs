// Documentation may not promise a DSH version range the manifest does not declare.
//
// The floor moved three times (0.1.1-rc.2 → 0.2.2-rc.3 → 0.2.3-alpha.2 → 0.2.2-rc.3) and two user
// documents kept the old value, so an operator reading `docs/limitations.md` installed a build the
// manifest then refused. CHANGELOG entries stay as written: they record what shipped, not what is
// supported now, so this check deliberately skips that file.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
const RANGE = /(?:>=|\^|~)\s*\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?\s*<\s*\d+\.\d+\.\d+/gu

function* docs(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) yield* docs(join(dir, entry.name))
    else if (entry.name.endsWith('.md')) yield join(dir, entry.name)
  }
}

const files = [
  join(ROOT, 'README.md'),
  join(ROOT, 'README.en.md'),
  ...[...docs(join(ROOT, 'docs'))],
]

test('every documented DSH range equals the manifest range', () => {
  const declared = manifest.engines.dsh.replace(/\s+/gu, '')
  const mismatches = []
  for (const file of files) {
    const path = relative(ROOT, file).split(sep).join('/')
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      for (const [found] of line.matchAll(RANGE)) {
        const claim = found.replace(/\s+/gu, '')
        if (claim !== declared) mismatches.push(`${path}:${index + 1} claims ${claim}, manifest says ${declared}`)
      }
    })
  }
  assert.deepEqual(mismatches, [], 'update the document, or change engines.dsh and every document with it')
})

test('the changelog is history and is not rewritten by this guard', () => {
  // Guard against someone widening the glob above: CHANGELOG keeps superseded ranges on purpose.
  const changelog = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8')
  assert.ok(changelog.includes('engines.dsh'), 'the changelog still records the range history')
  assert.ok(!files.some(file => file.endsWith(`CHANGELOG.md`)), 'CHANGELOG is not in the checked document set')
})

test('the manifest range keeps the verified lower bound', () => {
  assert.equal(manifest.engines.dsh, '>=0.2.2-rc.3 <0.3.0',
    'rc.3 is the oldest line CI assembles; raising it drops the official desktop, lowering it claims an unverified host')
})
