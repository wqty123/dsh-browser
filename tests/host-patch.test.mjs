import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { gunzipSync } from 'node:zlib'
import { applyHostPatch, hostPatchStatus, patchText, restoreHostPatch } from '../dsh-host-patch/apply.mjs'
import { legacyBridgeSnippets } from '../dsh-host-patch/legacy-bridge.mjs'
import { hostPatchFixture } from './helpers/host-patch-fixture.mjs'

test('compressed release artifacts retain their full source-build bytes', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('./fixtures/dsh-host-patch/manifest.json', import.meta.url), 'utf8'))
  for (const [file, expected] of Object.entries(manifest)) {
    const bytes = gunzipSync(fs.readFileSync(new URL(`./fixtures/dsh-host-patch/${file}.gz`, import.meta.url)))
    assert.equal(bytes.length, expected.bytes, file)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256, file)
  }
})

test('compressed source patches retain their complete git format-patch bytes', () => {
  const root = new URL('../dsh-host-patch/sources/', import.meta.url)
  const manifest = JSON.parse(fs.readFileSync(new URL('manifest.json', root), 'utf8'))
  const series = JSON.parse(fs.readFileSync(new URL('series.json', root), 'utf8'))
  assert.deepEqual(Object.keys(manifest).sort(), Object.values(series.releases).flatMap(entry =>
    entry.patches.map(patch => patch.file.slice(0, -3))).sort())
  for (const [file, expected] of Object.entries(manifest)) {
    const bytes = gunzipSync(fs.readFileSync(new URL(`${file}.gz`, root)))
    assert.equal(bytes.length, expected.bytes, file)
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256, file)
  }
})

for (const release of ['rc3', 'rc5']) describe(release, () => {
const spec = JSON.parse(fs.readFileSync(new URL(`../dsh-host-patch/${release}.json`, import.meta.url), 'utf8'))
const fixture = (id, kind) => hostPatchFixture(id, kind, release)
const backupSuffix = '.before-dsh-host-patch'
function setup(t, ids = ['client', 'main']) {
  const root = fs.mkdtempSync(join(tmpdir(), 'dsh-host-patch-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const packages = ids.map(id => {
    const target = spec.targets.find(target => target.id === id)
    const directory = join(root, id)
    fs.mkdirSync(join(directory, 'lib'), { recursive: true })
    fs.writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: target.packageName, version: spec.version }))
    fs.writeFileSync(join(directory, target.file), fixture(id, 'before'))
    if (id === 'main') fs.writeFileSync(join(directory, 'lib/preload-app.cjs'), fixture('preload', 'before'))
    return directory
  })
  return { root, packages, file: id => id === 'preload' ? join(root, 'main/lib/preload-app.cjs') : join(root, id, id === 'client' ? 'lib/client.js' : 'lib/main.js') }
}

for (const target of spec.targets) {
  test(`${target.id}: runtime anchors produce the exact ${spec.version} patched artifact`, () => {
    assert.equal(patchText(fixture(target.id, 'before'), target), fixture(target.id, 'after'))
    assert.throws(() => patchText(fixture(target.id, 'after'), target), /already patched/)
  })
}

test('sidebar hashes are resolved from the target, including the laptop prefix and other modules', () => {
  const prefix = fixture('client', 'before').match(/\.([A-Za-z0-9_-]+)_session\{display:contents\}/)[1] + '_'
  const substitute = text => text.replaceAll(prefix, 'acoR2W_').replaceAll('_3o69ta_', 'otherGuide_').replaceAll('qifk2W_', 'otherExpand_')
  assert.equal(patchText(substitute(fixture('client', 'before')), spec.targets[0]), substitute(fixture('client', 'after')))
})

test('validate is read-only; apply is idempotent; restore and reapply preserve the original backup', t => {
  const { packages, file } = setup(t)
  assert.deepEqual(hostPatchStatus(packages), { status: 'absent' })
  assert.equal(fs.existsSync(file('main') + backupSuffix), false)
  assert.deepEqual(applyHostPatch(packages), { status: 'applied', changed: true })
  assert.deepEqual(hostPatchStatus(packages), { status: 'applied' })
  assert.deepEqual(applyHostPatch(packages), { status: 'applied', changed: false })
  for (const id of ['client', 'main']) {
    assert.equal(fs.readFileSync(file(id), 'utf8'), fixture(id, 'after'))
    assert.equal(fs.readFileSync(file(id) + backupSuffix, 'utf8'), fixture(id, 'before'))
  }
  assert.deepEqual(restoreHostPatch(packages), { status: 'absent', changed: true })
  assert.deepEqual(restoreHostPatch(packages), { status: 'absent', changed: false })
  assert.equal(applyHostPatch(packages).status, 'applied')
  assert.equal(fs.readFileSync(file('main') + backupSuffix, 'utf8'), fixture('main', 'before'))
})

test('revision 1 upgrades main and preload while retaining the original restore bytes', t => {
  const { packages, file } = setup(t)
  const previous = JSON.parse(fs.readFileSync(new URL(`../dsh-host-patch/${release}-revision1.json`, import.meta.url), 'utf8'))
  for (const target of previous.targets) {
    fs.writeFileSync(file(target.id) + backupSuffix, fixture(target.id, 'before'))
    fs.writeFileSync(file(target.id), patchText(fixture(target.id, 'before'), target))
  }
  assert.match(hostPatchStatus(packages).reason, /revision 1/)
  assert.deepEqual(applyHostPatch(packages), { status: 'applied', changed: true })
  for (const id of ['client', 'main', 'preload']) {
    assert.equal(fs.readFileSync(file(id), 'utf8'), fixture(id, 'after'))
    assert.equal(fs.readFileSync(file(id) + backupSuffix, 'utf8'), fixture(id, 'before'))
  }
  assert.equal(restoreHostPatch(packages).status, 'absent')
  for (const id of ['client', 'main', 'preload']) assert.equal(fs.readFileSync(file(id), 'utf8'), fixture(id, 'before'))
})

test('a mismatched preload refuses the whole Desktop/sidebar plan without writes', t => {
  const { packages, file } = setup(t)
  fs.writeFileSync(file('preload'), 'unknown preload')
  assert.equal(applyHostPatch(packages).status, 'anchors mismatch')
  for (const id of ['client', 'main', 'preload']) assert.equal(fs.existsSync(file(id) + backupSuffix), false)
  for (const id of ['client', 'main']) assert.equal(fs.readFileSync(file(id), 'utf8'), fixture(id, 'before'))
})

for (const revision of [2, 3, 4, 5, 6, 7, 8]) for (const extraEdit of [false, true]) test(`revision ${revision} upgrades transactionally and restores originals (${extraEdit})`, t => {
  const { packages, file } = setup(t)
  const previous = JSON.parse(revision >= 3
    ? gunzipSync(fs.readFileSync(new URL(`../dsh-host-patch/${release}-revision${revision}.json.gz`, import.meta.url))).toString('utf8')
    : fs.readFileSync(new URL(`../dsh-host-patch/${release}-revision${revision}.json`, import.meta.url), 'utf8'))
  assert.equal(previous.revision, revision)
  for (const target of previous.targets) {
    fs.writeFileSync(file(target.id) + backupSuffix, fixture(target.id, 'before'))
    fs.writeFileSync(file(target.id), patchText(fixture(target.id, 'before'), target))
  }
  if (extraEdit) fs.appendFileSync(file('preload'), '\n// unrelated user edit\n')
  const before = ['client', 'main', 'preload'].map(id => fs.readFileSync(file(id)))
  if (extraEdit) {
    assert.equal(applyHostPatch(packages).status, 'anchors mismatch')
    for (const [index, id] of ['client', 'main', 'preload'].entries()) assert.deepEqual(fs.readFileSync(file(id)), before[index])
  } else {
    assert.match(hostPatchStatus(packages).reason, /revision 1 or 2/)
    assert.deepEqual(applyHostPatch(packages), { status: 'applied', changed: true })
    for (const id of ['client', 'main', 'preload']) assert.equal(fs.readFileSync(file(id), 'utf8'), fixture(id, 'after'))
    assert.deepEqual(restoreHostPatch(packages), { status: 'absent', changed: true })
    for (const id of ['client', 'main', 'preload']) assert.equal(fs.readFileSync(file(id), 'utf8'), fixture(id, 'before'))
  }
  for (const id of ['client', 'main', 'preload']) assert.equal(fs.readFileSync(file(id) + backupSuffix, 'utf8'), fixture(id, 'before'))
})

for (const extraEdit of [false, true]) test(`revision upgrade preserves a legacy original or refuses unrelated edits (${extraEdit})`, t => {
  const { packages, file } = setup(t)
  const previous = JSON.parse(fs.readFileSync(new URL(`../dsh-host-patch/${release}-revision1.json`, import.meta.url), 'utf8'))
  const pristine = fixture('main', 'before')
  const legacy = pristine.replace('export {};', legacyBridgeSnippets[0] + 'export {};')
  fs.writeFileSync(file('main') + '.before-bridge', pristine)
  for (const target of previous.targets) {
    fs.writeFileSync(file(target.id) + backupSuffix, target.id === 'main' ? legacy : fixture(target.id, 'before'))
    fs.writeFileSync(file(target.id), patchText(fixture(target.id, 'before'), target) + (target.id === 'main' && extraEdit ? '\n// unrelated edit' : ''))
  }
  const before = ['main', 'client', 'preload'].map(id => fs.readFileSync(file(id), 'utf8'))
  const result = applyHostPatch(packages)
  if (extraEdit) {
    assert.equal(result.status, 'anchors mismatch')
    for (const [index, id] of ['main', 'client', 'preload'].entries()) assert.equal(fs.readFileSync(file(id), 'utf8'), before[index])
    assert.equal(fs.existsSync(file('preload') + backupSuffix), false)
  } else {
    assert.equal(result.status, 'applied')
    assert.equal(restoreHostPatch(packages).status, 'absent')
    assert.equal(fs.readFileSync(file('main'), 'utf8'), legacy)
    for (const id of ['client', 'preload']) assert.equal(fs.readFileSync(file(id), 'utf8'), fixture(id, 'before'))
    assert.equal(applyHostPatch(packages).status, 'applied')
  }
})

test('a third-file commit failure rolls back all Desktop and sidebar bytes', t => {
  const { packages, file } = setup(t)
  let commits = 0
  const io = { ...fs, renameSync: (from, to) => {
    if (!from.endsWith('.original') && ++commits === 3) throw new Error('preload rename failed')
    fs.renameSync(from, to)
  } }
  assert.match(applyHostPatch(packages, { fs: io }).reason, /preload rename failed/)
  for (const id of ['client', 'main', 'preload']) {
    assert.equal(fs.readFileSync(file(id), 'utf8'), fixture(id, 'before'))
    assert.equal(fs.existsSync(file(id) + backupSuffix), false)
  }
})

test('web package directory and hardlinked npm content are patched without changing the store inode', t => {
  const { root, packages, file } = setup(t, ['client'])
  const store = join(root, 'store.js')
  fs.linkSync(file('client'), store)
  assert.equal(applyHostPatch(packages[0]).status, 'applied')
  assert.equal(fs.readFileSync(store, 'utf8'), fixture('client', 'before'))
  assert.equal(fs.readFileSync(file('client'), 'utf8'), fixture('client', 'after'))
})

for (const [variant, snippet] of legacyBridgeSnippets.entries()) test(`recognized legacy bridge ${variant} preserves exact restore bytes`, t => {
  const { packages, file } = setup(t)
  const pristine = fixture('main', 'before')
  const legacy = pristine.replace('export {};', snippet + 'export {};')
  assert.notEqual(legacy, pristine)
  fs.writeFileSync(file('main'), legacy)
  fs.writeFileSync(file('main') + '.before-bridge', pristine)
  const store = file('main') + '.store'
  fs.linkSync(file('main'), store)
  assert.deepEqual(hostPatchStatus(packages), { status: 'absent' })
  assert.deepEqual(applyHostPatch(packages), { status: 'applied', changed: true })
  assert.equal(fs.readFileSync(file('main'), 'utf8'), fixture('main', 'after'))
  assert.equal(fs.readFileSync(file('main') + backupSuffix, 'utf8'), legacy)
  assert.equal(fs.readFileSync(store, 'utf8'), legacy)
  assert.deepEqual(hostPatchStatus(packages), { status: 'applied' })
  assert.deepEqual(applyHostPatch(packages), { status: 'applied', changed: false })
  assert.deepEqual(restoreHostPatch(packages), { status: 'absent', changed: true })
  assert.equal(fs.readFileSync(file('main'), 'utf8'), legacy)
  assert.equal(fs.readFileSync(file('client'), 'utf8'), fixture('client', 'before'))
  assert.deepEqual(restoreHostPatch(packages), { status: 'absent', changed: false })
  assert.deepEqual(applyHostPatch(packages), { status: 'applied', changed: true })
})

for (const mutation of ['extra edit', 'edited block', 'unknown block', 'duplicate block']) test(`legacy ${mutation} refuses with no writes`, t => {
  const { packages, file } = setup(t)
  const pristine = fixture('main', 'before')
  const snippet = legacyBridgeSnippets[1]
  let legacy = pristine.replace('export {};', snippet + 'export {};')
  if (mutation === 'extra edit') legacy += '\n// unrelated edit\n'
  if (mutation === 'edited block') legacy = legacy.replace('bridge.start();', 'bridge.start({ custom: true });')
  if (mutation === 'unknown block') legacy = pristine.replace('export {};', spec.targets.find(target => target.id === 'main').legacyBridge.marker + '\nunknownBridge();\nexport {};')
  if (mutation === 'duplicate block') legacy = legacy.replace('export {};', snippet + 'export {};')
  fs.writeFileSync(file('main'), legacy)
  fs.writeFileSync(file('main') + '.before-bridge', pristine)
  let writes = 0
  const io = { ...fs, writeFileSync: (...args) => { writes++; fs.writeFileSync(...args) } }
  const result = applyHostPatch([...packages].reverse(), { fs: io })
  assert.equal(result.status, 'anchors mismatch')
  assert.equal(result.changed, false)
  assert.match(result.reason, /refusing to discard other edits/)
  assert.equal(writes, 0)
  assert.equal(fs.readFileSync(file('main'), 'utf8'), legacy)
  assert.equal(fs.readFileSync(file('main') + '.before-bridge', 'utf8'), pristine)
  assert.equal(fs.readFileSync(file('client'), 'utf8'), fixture('client', 'before'))
  for (const id of ['main', 'client']) assert.equal(fs.existsSync(file(id) + backupSuffix), false)
})

test('legacy migration validates sidebar anchors before changing either file or creating backups', t => {
  const { packages, file } = setup(t)
  const marker = spec.targets.find(target => target.id === 'main').legacyBridge.marker
  const legacy = fixture('main', 'before') + '\n' + marker + '\n'
  fs.writeFileSync(file('main'), legacy)
  fs.writeFileSync(file('main') + '.before-bridge', fixture('main', 'before'))
  fs.writeFileSync(file('client'), 'unknown client build')
  assert.equal(applyHostPatch(packages).status, 'anchors mismatch')
  assert.equal(fs.readFileSync(file('main'), 'utf8'), legacy)
  assert.equal(fs.readFileSync(file('client'), 'utf8'), 'unknown client build')
  for (const id of ['main', 'client']) assert.equal(fs.existsSync(file(id) + backupSuffix), false)
})

for (const [name, mutate, status] of [
  ['unsupported version', ({ packages }) => fs.writeFileSync(join(packages[1], 'package.json'), JSON.stringify({ name: spec.targets[1].packageName, version: '0.2.2-rc.4' })), 'unsupported version'],
  ['missing anchor', ({ file }) => fs.writeFileSync(file('client'), fixture('client', 'before').replace(spec.targets[0].edits[0].before, 'missing')), 'anchors mismatch'],
  ['ambiguous anchor', ({ file }) => fs.appendFileSync(file('client'), spec.targets[0].edits[0].before), 'anchors mismatch'],
  ['ambiguous CSS prefix', ({ file }) => fs.appendFileSync(file('client'), '.other_session{display:contents}'), 'anchors mismatch'],
  ['main pristine hash mismatch', ({ file }) => fs.appendFileSync(file('main'), '\n'), 'anchors mismatch'],
  ['stale backup', ({ file }) => fs.writeFileSync(file('main') + backupSuffix, 'stale'), 'anchors mismatch'],
  ['partial patch', ({ file }) => fs.writeFileSync(file('client'), fixture('client', 'after')), 'anchors mismatch'],
]) {
  test(`${name} refuses all targets without creating backups or modifying files`, t => {
    const state = setup(t)
    mutate(state)
    const before = ['client', 'main'].map(id => fs.readFileSync(state.file(id), 'utf8'))
    assert.equal(applyHostPatch(state.packages).status, status)
    assert.deepEqual(['client', 'main'].map(id => fs.readFileSync(state.file(id), 'utf8')), before)
    assert.equal(fs.existsSync(state.file('client') + backupSuffix), false)
  })
}

test('a commit failure rolls back earlier renames and new backups', t => {
  const { packages, file } = setup(t)
  let commits = 0
  const io = { ...fs, renameSync: (from, to) => {
    if (!from.endsWith('.original') && ++commits === 2) throw new Error('injected rename failure')
    fs.renameSync(from, to)
  } }
  const result = applyHostPatch(packages, { fs: io })
  assert.equal(result.changed, false)
  assert.match(result.reason, /injected rename failure/)
  for (const id of ['client', 'main', 'preload']) {
    assert.equal(fs.readFileSync(file(id), 'utf8'), fixture(id, 'before'))
    assert.equal(fs.existsSync(file(id) + backupSuffix), false)
    assert.deepEqual(fs.readdirSync(join(file(id), '..')).sort(), id === 'client' ? ['client.js'] : ['main.js', 'preload-app.cjs'])
  }
})

test('restore refuses unrelated edits instead of overwriting them', t => {
  const { packages, file } = setup(t)
  applyHostPatch(packages)
  fs.appendFileSync(file('main'), '\n// another tool\n')
  assert.equal(restoreHostPatch(packages).status, 'anchors mismatch')
  assert.equal(fs.readFileSync(file('client'), 'utf8'), fixture('client', 'after'))
})

test('empty targets and missing package paths report a reason', () => {
  for (const input of [[], '/no-such-dsh-package']) {
    assert.equal(applyHostPatch(input).status, 'anchors mismatch')
    assert.ok(hostPatchStatus(input).reason)
  }
})

test('a linked target cannot escape its package', t => {
  const { packages, file, root } = setup(t, ['client'])
  const outside = join(root, 'outside.js')
  fs.writeFileSync(outside, fixture('client', 'before'))
  fs.unlinkSync(file('client'))
  fs.symlinkSync(outside, file('client'))
  assert.match(applyHostPatch(packages).reason, /outside its package/)
  assert.equal(fs.readFileSync(outside, 'utf8'), fixture('client', 'before'))
})

test('a staging failure changes neither targets nor backups', t => {
  const { packages, file } = setup(t)
  const result = applyHostPatch(packages, { fs: { ...fs, writeFileSync: () => { throw new Error('read-only installation') } } })
  assert.match(result.reason, /read-only installation/)
  for (const id of ['client', 'main']) {
    assert.equal(fs.readFileSync(file(id), 'utf8'), fixture(id, 'before'))
    assert.equal(fs.existsSync(file(id) + backupSuffix), false)
  }
})
})
