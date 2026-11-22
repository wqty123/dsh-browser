import { test } from 'node:test'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync, readdirSync, symlinkSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { preflightReinstall, inspectReinstallHost, runReinstallTransaction, stageReinstallRuntime } from '../lib/browser-electron/automatic-maintenance.js'
import { runMaintenanceLifecycle } from '../lib/browser-electron/maintenance-lifecycle.js'
import { profileExtensionCommand, repairProfileExtension, reconcileProfile } from '../lib/browser-electron/profile-extension.js'
import { readBridgeStatus } from '../lib/browser-electron/bridge-status.js'
import { applyHostPatch, restoreHostPatch } from '../dsh-host-patch/apply.mjs'
import { hostPatchFixture } from './helpers/host-patch-fixture.mjs'
import { writeAsar } from './fake-asar.mjs'
import { createInstallerSandbox } from './helpers/installer-sandbox.mjs'

function fixture(t, parent = tmpdir(), bundle = false) {
  const directory = mkdtempSync(join(parent, 'reinstall-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const root = join(directory, bundle ? 'Desktop.app' : 'desktop'), home = join(directory, 'home')
  const resources = join(root, bundle ? 'Contents/Resources' : 'resources'), app = join(resources, 'app')
  if (bundle) {
    mkdirSync(join(root, 'Contents/MacOS'), { recursive: true })
    writeFileSync(join(root, 'Contents/Info.plist'), '<plist/>')
    writeFileSync(join(root, 'Contents/MacOS/DeepSeek Harness'), '')
  }
  const sidebar = join(app, 'dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar-right')
  const files = {
    'package.json': JSON.stringify({ name: '@deepseek-ai/dsh-desktop', version: '0.2.2-rc.3', main: 'lib/main.js' }),
    'lib/main.js': hostPatchFixture('main', 'before'),
    'lib/preload-app.cjs': hostPatchFixture('preload', 'before'),
    'dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar-right/package.json': JSON.stringify({ name: '@deepseek-ai/dsh-client-ui-sidebar-right', version: '0.2.2-rc.3' }),
    'dsh/node_modules/@deepseek-ai/dsh-client-ui-sidebar-right/lib/client.js': hostPatchFixture('client', 'before'),
    'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js': 'trusted CLI',
  }
  for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(app, path)), { recursive: true }); writeFileSync(join(app, path), content) }
  const manifest = join(home, 'profiles/desktop/package.json')
  mkdirSync(dirname(manifest), { recursive: true })
  const spec = 'file:../../plugin.tgz'
  writeFileSync(join(home, 'plugin.tgz'), 'preserved dependency archive')
  writeFileSync(manifest, JSON.stringify({ dependencies: { 'dsh-builtin-browser': spec, other: '^1' } }))
  const pnpm = join(resources, 'runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs')
  mkdirSync(dirname(pnpm), { recursive: true }); writeFileSync(pnpm, 'bundled pnpm')
  return { directory, root, home, resources, app, sidebar, files, manifest, spec, packages: [app, sidebar] }
}

for (const packed of [false, true]) test(`macOS ${packed ? 'packed' : 'unpacked'} reinstall uses bundle resources and executable`, async t => {
  const f = fixture(t, tmpdir(), true)
  if (packed) { writeAsar(join(f.resources, 'app.asar'), f.files); rmSync(f.app, { recursive: true }) }
  assert.equal(inspectReinstallHost(f.root).status, 'absent')
  assert.equal(await preflightReinstall(f.root, f.home), f.spec)
  assert.equal(readBridgeStatus(f.root).present, true)
  const cli = join(f.resources, packed ? 'app.asar' : 'app', 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js')
  assert.equal((await profileExtensionCommand('install', f.root, f.home))[0], cli)
  for (const action of ['install', 'uninstall']) {
    assert.equal((await repairProfileExtension(action, f.root, f.home, async (command, argv) => {
      assert.equal(command, join(f.root, 'Contents/MacOS/DeepSeek Harness'))
      assert.ok(argv.includes(cli))
      assert.ok(argv.includes('remove') || argv.includes('add'))
      return { code: 0, output: '' }
    })).ok, true)
  }
  await reconcileProfile(f.root, f.home, async (command, argv) => {
    assert.equal(command, join(f.root, 'Contents/MacOS/DeepSeek Harness'))
    assert.equal(argv[1], join(f.resources, 'runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs'))
    return { code: 0, output: '' }
  })
})

function snapshot(path) {
  return Object.fromEntries(readdirSync(path, { withFileTypes: true }).flatMap(entry => {
    const file = join(path, entry.name)
    return entry.isDirectory() ? Object.entries(snapshot(file)) : [[file, readFileSync(file).toString('base64')]]
  }))
}

for (const packed of [false, true]) test(`rc.3 ${packed ? 'packed' : 'unpacked'} runtime preflight checks the sibling payload without writes`, async t => {
  const f = fixture(t), pnpm = join(f.root, 'resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs')
  if (packed) { writeAsar(join(f.root, 'resources/app.asar'), f.files); rmSync(f.app, { recursive: true }) }
  assert.equal(await preflightReinstall(f.root, f.home), f.spec)
  rmSync(pnpm)
  const misleading = join(f.app, 'runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs')
  mkdirSync(dirname(misleading), { recursive: true }); writeFileSync(misleading, 'wrong location')
  const before = snapshot(f.directory)
  await assert.rejects(preflightReinstall(f.root, f.home), { code: 'REINSTALL_RUNTIME_MISSING' })
  assert.deepEqual(snapshot(f.directory), before)
})

test('read-only preflight admits clean and installed hosts, preserving restore baselines', async t => {
  const f = fixture(t)
  const original = snapshot(f.directory)
  assert.equal(await preflightReinstall(f.root, f.home), f.spec)
  assert.deepEqual(snapshot(f.directory), original)
  assert.equal(applyHostPatch(f.packages).status, 'applied')
  const installed = snapshot(f.directory)
  assert.equal(await preflightReinstall(f.root, f.home), f.spec)
  assert.deepEqual(snapshot(f.directory), installed)
  assert.equal(restoreHostPatch(f.packages).status, 'absent')
  assert.equal(await preflightReinstall(f.root, f.home), f.spec)
  for (const file of ['lib/main.js', 'lib/preload-app.cjs']) assert.equal(readFileSync(join(f.app, file), 'utf8'), f.files[file])
})

test('packed preflight probes archives without Electron caching and restores noAsar', async t => {
  const f = fixture(t)
  writeAsar(join(f.root, 'resources/app.asar'), f.files)
  const original = fs.existsSync, previous = process.noAsar, probes = []
  fs.existsSync = path => {
    if (String(path).endsWith('app.asar')) {
      probes.push(process.noAsar)
      assert.equal(process.noAsar, true)
    }
    return original(path)
  }
  syncBuiltinESMExports()
  try {
    assert.equal(await preflightReinstall(f.root, f.home), f.spec)
    assert.ok(probes.length > 0)
    assert.equal(process.noAsar, previous)
  } finally { fs.existsSync = original; syncBuiltinESMExports(); process.noAsar = previous }
})

test('missing dependency refuses with a structured error and zero writes', async t => {
  const f = fixture(t)
  for (const dependencies of [undefined, {}, { 'dsh-builtin-browser': '' }]) {
    writeFileSync(f.manifest, JSON.stringify({ dependencies }))
    const before = snapshot(f.directory)
    await assert.rejects(preflightReinstall(f.root, f.home), { code: 'REINSTALL_DEPENDENCY_MISSING' })
    assert.deepEqual(snapshot(f.directory), before)
  }
})

test('an external link source survives profile-link removal and can be captured again', async t => {
  const f = fixture(t), source = join(f.directory, 'external-checkout')
  mkdirSync(source)
  writeFileSync(join(source, 'package.json'), JSON.stringify({ name: 'dsh-builtin-browser', version: '0.7.42' }))
  const spec = `link:${source}`, installed = join(f.home, 'profiles/desktop/node_modules/dsh-builtin-browser')
  mkdirSync(dirname(installed), { recursive: true })
  symlinkSync(source, installed, 'junction')
  writeFileSync(f.manifest, JSON.stringify({ dependencies: { 'dsh-builtin-browser': spec } }))
  assert.equal(await preflightReinstall(f.root, f.home), spec)
  rmSync(installed)
  assert.ok(existsSync(join(source, 'package.json')))
  assert.equal(await preflightReinstall(f.root, f.home), spec)
})

test('packed preflight uses the authoritative archive rather than a stale extraction', async t => {
  const f = fixture(t)
  writeAsar(join(f.root, 'resources/app.asar'), f.files)
  writeFileSync(join(f.app, 'lib/main.js'), 'stale extraction with wrong anchors')
  const before = snapshot(f.directory)
  assert.equal(await preflightReinstall(f.root, f.home), f.spec)
  assert.deepEqual(snapshot(f.directory), before)
  writeAsar(join(f.root, 'resources/app.asar'), { ...f.files, 'lib/main.js': 'invalid authoritative main' })
  await assert.rejects(preflightReinstall(f.root, f.home), { code: 'REINSTALL_HOST_CONFLICT' })
})

test('conflicting host and archive backups refuse before any writes', async t => {
  const f = fixture(t)
  writeFileSync(join(f.app, 'lib/main.js.before-dsh-host-patch'), 'foreign baseline')
  const before = snapshot(f.directory)
  await assert.rejects(preflightReinstall(f.root, f.home), { code: 'REINSTALL_HOST_CONFLICT' })
  assert.deepEqual(snapshot(f.directory), before)
  writeAsar(join(f.root, 'resources/app.asar'), f.files)
  writeFileSync(join(f.root, 'resources/app.asar.before-bridge'), 'conflicting archive')
  await assert.rejects(preflightReinstall(f.root, f.home), { code: 'REINSTALL_BACKUP_CONFLICT' })
})

test('an applied patch without every restore baseline refuses before profile removal', async t => {
  const f = fixture(t)
  assert.equal(applyHostPatch(f.packages).status, 'applied')
  rmSync(join(f.app, 'lib/preload-app.cjs.before-dsh-host-patch'))
  const before = snapshot(f.directory)
  await assert.rejects(preflightReinstall(f.root, f.home), { code: 'REINSTALL_BACKUP_CONFLICT' })
  assert.deepEqual(snapshot(f.directory), before)
})

test('captured file dependency survives removal and is used instead of a replacement source', async t => {
  const f = fixture(t), captured = await preflightReinstall(f.root, f.home)
  const archive = readFileSync(join(f.home, 'plugin.tgz'))
  writeFileSync(f.manifest, JSON.stringify({ dependencies: { other: '^1' } }))
  const command = await profileExtensionCommand('install', f.root, f.home, captured)
  assert.equal(command.at(-1), `file:${join(f.home, 'plugin.tgz')}`)
  assert.deepEqual(readFileSync(join(f.home, 'plugin.tgz')), archive)
})

test('unreadable local dependency and missing authoritative CLI refuse before writes', async t => {
  const f = fixture(t)
  rmSync(join(f.home, 'plugin.tgz'))
  const before = snapshot(f.directory)
  await assert.rejects(preflightReinstall(f.root, f.home), { code: 'REINSTALL_DEPENDENCY_UNAVAILABLE' })
  assert.deepEqual(snapshot(f.directory), before)
  writeFileSync(join(f.home, 'plugin.tgz'), 'source')
  rmSync(join(f.app, 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'))
  await assert.rejects(preflightReinstall(f.root, f.home), { code: 'REINSTALL_CLI_MISSING' })
})

test('a local dependency inside the package being removed is refused, not replaced', async t => {
  const f = fixture(t), packageDirectory = join(f.home, 'profiles/desktop/node_modules/dsh-builtin-browser')
  mkdirSync(packageDirectory, { recursive: true })
  writeFileSync(join(packageDirectory, 'source.tgz'), 'would be deleted')
  writeFileSync(f.manifest, JSON.stringify({ dependencies: { 'dsh-builtin-browser': 'file:node_modules/dsh-builtin-browser/source.tgz' } }))
  const before = snapshot(f.directory)
  await assert.rejects(preflightReinstall(f.root, f.home), { code: 'REINSTALL_DEPENDENCY_UNSAFE' })
  assert.deepEqual(snapshot(f.directory), before)
})

test('conflicting legacy CLI and preserved archive baselines are read-only refusals', async t => {
  const f = fixture(t), cli = join(f.app, 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js')
  writeFileSync(cli + '.before-bridge', 'foreign CLI baseline')
  const before = snapshot(f.directory)
  await assert.rejects(preflightReinstall(f.root, f.home), { code: 'REINSTALL_BACKUP_CONFLICT' })
  assert.deepEqual(snapshot(f.directory), before)
  rmSync(cli + '.before-bridge')
  writeAsar(join(f.root, 'resources/app.asar.before-bridge'), { ...f.files, 'lib/main.js': 'different build' })
  await assert.rejects(preflightReinstall(f.root, f.home), { code: 'REINSTALL_BACKUP_CONFLICT' })
})

test('preflight accepts the actual installer CLI backups without changing them', async t => {
  const sandbox = createInstallerSandbox()
  t.after(() => sandbox.close())
  const f = fixture(t, sandbox.root)
  const cli = join(f.app, 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js')
  writeFileSync(cli, '\tawait runDesktopCli(runtimeDir, join(dirname(runtimeArchivePath(runtimeDir) ?? runtimeDir), "runtime"));\n')
  const shim = join(f.root, 'resources/runtime/cli/bin/dsh.cmd')
  mkdirSync(dirname(shim), { recursive: true })
  writeFileSync(shim, '@echo off\r\nsetlocal\r\nnode "%~dp0..\\..\\..\\app.asar\\dsh\\cli.js"\r\n')
  const output = execFileSync(process.execPath, [fileURLToPath(new URL('../desktop-bridge/install.mjs', import.meta.url)), f.root], { env: sandbox.env(), encoding: 'utf8' })
  assert.match(output, /"status":"applied"/)
  assert.ok(existsSync(cli + '.before-bridge'))
  assert.ok(existsSync(shim + '.before-bridge'))
  const before = snapshot(f.directory)
  assert.equal(await preflightReinstall(f.root, f.home), f.spec)
  assert.deepEqual(snapshot(f.directory), before)
})

test('real host apply/remove cycles retain exact restore bytes and the local dependency archive', async t => {
  const f = fixture(t), archive = readFileSync(join(f.home, 'plugin.tgz'))
  const original = f.packages.flatMap((path, index) => (index === 0 ? ['lib/main.js', 'lib/preload-app.cjs'] : ['lib/client.js']).map(file => [join(path, file), readFileSync(join(path, file))]))
  for (let run = 0; run < 2; run++) {
    const captured = await preflightReinstall(f.root, f.home)
    const operations = {
      absent: async () => !JSON.parse(readFileSync(f.manifest)).dependencies['dsh-builtin-browser'],
      remove: async () => { writeFileSync(f.manifest, JSON.stringify({ dependencies: { other: '^1' } })); return answer('removed') },
      revert: async () => { const hostPatch = restoreHostPatch(f.packages); return { ...answer('reverted', hostPatch), ok: hostPatch.status === 'absent' } },
      hostAbsent: () => inspectReinstallHost(f.root).status === 'absent',
      apply: async () => { const hostPatch = applyHostPatch(f.packages); return { ...answer('applied', hostPatch), ok: hostPatch.status === 'applied' } },
      add: async () => { writeFileSync(f.manifest, JSON.stringify({ dependencies: { 'dsh-builtin-browser': captured, other: '^1' } })); return answer('added') },
    }
    assert.equal((await runReinstallTransaction(operations)).ok, true)
    assert.equal(JSON.parse(readFileSync(f.manifest)).dependencies['dsh-builtin-browser'], f.spec)
    for (const [path, bytes] of original) assert.deepEqual(readFileSync(path + '.before-dsh-host-patch'), bytes)
  }
  assert.deepEqual(readFileSync(join(f.home, 'plugin.tgz')), archive)
})

test('staged compiled coordinator imports without the installed package or its node_modules', async t => {
  const f = fixture(t), destination = join(f.directory, 'job')
  mkdirSync(destination)
  const worker = await stageReinstallRuntime(destination)
  for (const file of ['assets/browser-policy.mjs', 'desktop-bridge/install.mjs', 'dsh-host-patch/apply.mjs', 'dsh-host-patch/rc3.json']) {
    assert.ok(existsSync(join(destination, 'runtime', file)))
  }
  assert.equal(existsSync(join(destination, 'runtime/node_modules')), false)
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(pathToFileURL(worker).href)}); console.log('staged runtime loaded')`], { encoding: 'utf8', cwd: destination }).trim(), 'staged runtime loaded')
  await assert.rejects(stageReinstallRuntime(destination, destination), /outside the removed package/)
})

const answer = (output = 'done', hostPatch) => ({ ok: true, code: 0, command: 'fixture', output, restarted: false, ...(hostPatch ? { hostPatch } : {}) })
function steps({ absent = false, fail } = {}) {
  const calls = []
  let removed = absent, patched = !absent
  const step = (name, operation) => async () => { calls.push(name); if (fail === name) return { ...answer(name + ' rejected'), ok: false, code: 1 }; return operation() }
  return { calls, operations: {
    absent: async () => removed,
    remove: step('remove', () => { removed = true; return answer('removed') }),
    revert: step('revert', () => { patched = false; return answer('reverted') }),
    hostAbsent: () => !patched,
    apply: step('apply', () => { patched = true; return answer('applied', { status: 'applied' }) }),
    add: step('add', () => { removed = false; return answer('added') }),
  } }
}

for (const absent of [false, true]) test(`reinstall is repeatable from an ${absent ? 'absent' : 'installed'} state`, async () => {
  const f = steps({ absent })
  assert.equal((await runReinstallTransaction(f.operations)).ok, true)
  assert.deepEqual(f.calls, absent ? ['revert', 'apply', 'add'] : ['remove', 'revert', 'apply', 'add'])
  f.calls.length = 0
  assert.equal((await runReinstallTransaction(f.operations)).ok, true)
  assert.deepEqual(f.calls, ['remove', 'revert', 'apply', 'add'])
})

for (const fail of [undefined, 'remove', 'revert', 'apply', 'add']) test(`one exit, one restart and durable ${fail ?? 'successful'} outcome`, async () => {
  const f = steps({ fail }), states = [], lifecycle = []
  const result = await runMaintenanceLifecycle('reinstall', {
    requestQuit: async () => { lifecycle.push('quit') }, waitUntilClosed: async () => { lifecycle.push('closed') },
    maintain: () => runReinstallTransaction(f.operations), restart: async () => { lifecycle.push('restart'); return 456 },
    verify: async (_pid, action) => { lifecycle.push(action) }, publish: async state => { states.push(JSON.parse(JSON.stringify(state))) },
  })
  assert.equal(result.phase, fail ? 'failed' : 'completed')
  assert.deepEqual(lifecycle, ['quit', 'closed', 'restart', fail ? 'uninstall' : 'reinstall'])
  assert.deepEqual(states.at(-1), result)
  if (fail) assert.match(result.error, /REINSTALL_.*_FAILED/)
  assert.equal(result.restarted, true)
})

test('cancellation never removes, reverts, applies, adds or restarts', async () => {
  const f = steps()
  const result = await runMaintenanceLifecycle('reinstall', {
    requestQuit: async () => {}, waitUntilClosed: async () => { throw new Error('cancelled by operator') },
    maintain: () => runReinstallTransaction(f.operations), restart: async () => { throw new Error('must not restart') }, verify: async () => {}, publish: async () => {},
  })
  assert.equal(result.phase, 'cancelled')
  assert.deepEqual(f.calls, [])
})

test('only verified absence with the exact no-op revert verdict is accepted, never access failures', async () => {
  const f = steps({ absent: true })
  f.operations.revert = async () => ({ ...answer('nothing to revert in fixture'), ok: false, code: 1 })
  assert.equal((await runReinstallTransaction(f.operations)).ok, true)
  const rejected = steps({ absent: true })
  rejected.operations.revert = async () => ({ ...answer('EACCES'), ok: false, code: 1 })
  await assert.rejects(runReinstallTransaction(rejected.operations), /REINSTALL_REVERT_FAILED/)
  assert.deepEqual(rejected.calls, [])
})
