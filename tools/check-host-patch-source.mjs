import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { patchText } from '../dsh-host-patch/apply.mjs'

const directory = process.argv[2]
if (!directory) throw new Error('usage: node tools/check-host-patch-source.mjs <release-source-build-artifacts>')
for (const release of ['rc3', 'rc5']) {
  const spec = JSON.parse(readFileSync(new URL(`../dsh-host-patch/${release}.json`, import.meta.url), 'utf8'))
  assert.equal(spec.revision, 8)
  for (const target of spec.targets) {
    const path = join(target.id === 'client' ? 'packages/client/ui-sidebar-right' : 'apps/desktop', target.file)
    const before = readFileSync(resolve(directory, release, 'unpatched', path), 'utf8')
    const expected = readFileSync(resolve(directory, release, 'patched', path))
    assert.deepEqual(Buffer.from(patchText(before, target)), expected, `${release}: ${target.file}`)
    console.log(`${release}: ${target.file}: runtime patch equals source build byte-for-byte (${expected.length} bytes)`)
  }
}
