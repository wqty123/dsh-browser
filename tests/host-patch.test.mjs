import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applyHostPatch, hostPatchStatus, patchText, restoreHostPatch } from '../dsh-host-patch/apply.mjs'

for (const release of ['rc3', 'rc5']) describe(release, () => {
const spec = JSON.parse(fs.readFileSync(new URL(`../dsh-host-patch/${release}.json`, import.meta.url), 'utf8'))
const fixture = (id, kind) => fs.readFileSync(new URL(`./fixtures/dsh-host-patch/${release === 'rc3' ? '' : release + '/'}${id}.${kind}.js`, import.meta.url), 'utf8')
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
    return directory
  })
  return { root, packages, file: id => join(root, id, id === 'client' ? 'lib/client.js' : 'lib/main.js') }
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

test('web package directory and hardlinked npm content are patched without changing the store inode', t => {
  const { root, packages, file } = setup(t, ['client'])
  const store = join(root, 'store.js')
  fs.linkSync(file('client'), store)
  assert.equal(applyHostPatch(packages[0]).status, 'applied')
  assert.equal(fs.readFileSync(store, 'utf8'), fixture('client', 'before'))
  assert.equal(fs.readFileSync(file('client'), 'utf8'), fixture('client', 'after'))
})

test('legacy bridge migration preserves exact restore bytes independently of the installer snippet version', t => {
  const { packages, file } = setup(t)
  const target = spec.targets.find(target => target.id === 'main')
  const pristine = fixture('main', 'before')
  const legacy = pristine.replace('export {};', `${target.legacyBridge.marker} pages.\napp.whenReady().then(() => import('./plugin-browser-bridge.js'));\nexport {};`)
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
  ['missing anchor', ({ file }) => fs.writeFileSync(file('client'), fixture('client', 'before').replace(spec.targets[0].edits[1].before, 'missing')), 'anchors mismatch'],
  ['ambiguous anchor', ({ file }) => fs.appendFileSync(file('client'), spec.targets[0].edits[1].before), 'anchors mismatch'],
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
  for (const id of ['client', 'main']) {
    assert.equal(fs.readFileSync(file(id), 'utf8'), fixture(id, 'before'))
    assert.equal(fs.existsSync(file(id) + backupSuffix), false)
    assert.deepEqual(fs.readdirSync(join(file(id), '..')), [id === 'client' ? 'client.js' : 'main.js'])
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
