import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gunzipSync } from 'node:zlib'

const root = new URL('../dsh-host-patch/sources/', import.meta.url)
const series = JSON.parse(readFileSync(new URL('series.json', root), 'utf8'))
assert.equal(series.version, 1)
assert.deepEqual(Object.keys(series.releases).sort(), ['main', 'rc3', 'rc5'])
const git = (cwd, args, input) => {
  const result = spawnSync('git', args, { cwd, input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}
for (const [release, entry] of Object.entries(series.releases)) {
  test(`${release}: complete shipped source series reconstructs the source-build tree`, t => {
    const cwd = mkdtempSync(join(tmpdir(), 'dsh-source-series-'))
    t.after(() => rmSync(cwd, { recursive: true, force: true }))
    git(cwd, ['init', '--quiet'])
    const bytes = gunzipSync(readFileSync(new URL(`./fixtures/dsh-host-patch/sources/${entry.fixture.file}`, import.meta.url)))
    assert.equal(bytes.length, entry.fixture.bytes)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.fixture.sha256)
    const fixture = JSON.parse(bytes)
    for (const [oid, data] of Object.entries(fixture.blobs)) {
      assert.equal(git(cwd, ['hash-object', '-w', '--stdin'], Buffer.from(data, 'base64')), oid)
    }
    git(cwd, ['update-index', '-z', '--index-info'], fixture.index)
    assert.equal(git(cwd, ['write-tree', '--missing-ok']), entry.baseTree)
    assert.ok(entry.patches.length > 0)
    assert.equal(entry.patches.at(-1).commit, entry.sourceCommit)
    const last = gunzipSync(readFileSync(new URL(entry.patches.at(-1).file, root)))
    const outOfOrder = spawnSync('git', ['apply', '--cached', '--check', '-'], { cwd, input: last })
    assert.notEqual(outOfOrder.status, 0, 'last patch must not apply to the unpatched base')
    assert.equal(git(cwd, ['write-tree', '--missing-ok']), entry.baseTree)
    for (const patch of entry.patches) {
      const raw = gunzipSync(readFileSync(new URL(patch.file, root)))
      assert.ok(raw.toString().startsWith(`From ${patch.commit} `), patch.file)
      git(cwd, ['apply', '--cached', '--check', '-'], raw)
      git(cwd, ['apply', '--cached', '-'], raw)
    }
    assert.equal(git(cwd, ['write-tree', '--missing-ok']), entry.sourceTree)
    console.log(`${release}: ${entry.patches.length} shipped patches apply in order; source-build tree ${entry.sourceTree}: PASS`)
  })
}
