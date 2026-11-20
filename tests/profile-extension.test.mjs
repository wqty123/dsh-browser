import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { installedProfileExtension, profileExtensionCommand, repairProfileExtension, reconcileProfile, extensionHomeId, readHostExtensionStatus } from '../src/browser-electron/profile-extension.ts'
import { waitForRestartedBridge } from '../src/browser-electron/bridge-install.ts'
import { readBridgeStatus } from '../src/browser-electron/bridge-status.ts'
import { runMaintenanceLifecycle } from '../src/browser-electron/maintenance-lifecycle.ts'
import { writeAsar } from './fake-asar.mjs'

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'profile-extension-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const home = join(root, 'home'), app = join(root, 'desktop'), profile = join(home, 'profiles/desktop')
  const cli = join(app, 'resources/app/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js')
  mkdirSync(dirname(cli), { recursive: true }); writeFileSync(cli, 'supported CLI')
  const pnpm = join(app, 'resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs')
  mkdirSync(dirname(pnpm), { recursive: true }); writeFileSync(pnpm, 'bundled pnpm')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-builtin-browser': 'file:../../plugin.tgz', other: '1.0.0' } }))
  const resources = ['resources/app/lib/main.js', 'resources/app/lib/preload-app.cjs', 'resources/app.asar', 'resources/cli/dsh.cmd']
  for (const file of resources) { mkdirSync(dirname(join(app, file)), { recursive: true }); writeFileSync(join(app, file), 'original ' + file) }
  return { root, home, app, profile, cli, resources }
}

test('rollback reconciliation uses bounded bundled pnpm with a frozen offline profile and no ASAR or scripts', async t => {
  const f = fixture(t)
  let calls = 0
  await reconcileProfile(f.app, f.home, async (command, argv, env, timeout) => {
    calls++
    assert.equal(command, join(f.app, 'DeepSeek Harness.exe'))
    assert.deepEqual(argv, ['--expose-internals', join(f.app, 'resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs'),
      '--dir', f.profile, 'install', '--offline', '--frozen-lockfile', '--ignore-scripts', '--config.auto-install-peers=false'])
    assert.equal(env.ELECTRON_NO_ASAR, '1')
    assert.equal(env.ELECTRON_RUN_AS_NODE, '1')
    assert.equal(env.PNPM_CONFIG_OFFLINE, 'true')
    assert.equal(env.PNPM_CONFIG_IGNORE_SCRIPTS, 'true')
    assert.equal(env.PNPM_CONFIG_AUTO_INSTALL_PEERS, 'false')
    assert.equal(timeout, 60_000)
    return { code: 0, output: 'reconciled' }
  })
  assert.equal(calls, 1)
  await assert.rejects(reconcileProfile(f.app, f.home, async () => ({ code: 1, output: 'offline store missing' })), /REINSTALL_RECONCILE_FAILED: offline store missing/)
  rmSync(join(f.app, 'resources/runtime'), { recursive: true })
  await assert.rejects(reconcileProfile(f.app, f.home, async () => assert.fail('must not start')), { code: 'REINSTALL_RUNTIME_MISSING' })
})

test('profile repair and removal invoke the trusted CLI and do not change app resources, archive or launchers', async t => {
  const f = fixture(t)
  const before = f.resources.map(path => readFileSync(join(f.app, path)))
  const calls = []
  for (const action of ['install', 'uninstall']) {
    const result = await repairProfileExtension(action, f.app, f.home, async (command, argv, env) => {
      calls.push({ command, argv, env })
      assert.equal(command, join(f.app, 'DeepSeek Harness.exe'))
      assert.deepEqual(argv.slice(0, 3), ['--expose-internals', '--input-type=module', '--eval'])
      const args = argv.slice(argv.indexOf('--') + 1)
      assert.deepEqual(args.slice(0, 4), [f.cli, 'plugin', '--profile', 'desktop'])
      assert.equal(env.DSH_HOME, f.home); assert.equal(env.ELECTRON_RUN_AS_NODE, '1')
      assert.equal(args[4], action === 'install' ? 'add' : 'remove')
      assert.equal(args[5], action === 'install' ? `file:${join(f.home, 'plugin.tgz')}` : 'dsh-builtin-browser')
      assert.equal(env.npm_config_offline, 'true')
      assert.equal(env.npm_config_ignore_scripts, 'true')
      assert.equal(env.PNPM_CONFIG_OFFLINE, 'true')
      assert.equal(env.PNPM_CONFIG_IGNORE_SCRIPTS, 'true')
      assert.equal(env.PNPM_CONFIG_AUTO_INSTALL_PEERS, 'false')
      assert.equal(env.ELECTRON_NO_ASAR, '1')
      return { code: 0, output: 'profile package operation completed' }
    })
    assert.equal(result.ok, true); assert.equal(result.restarted, false)
  }
  assert.equal(calls.length, 2)
  f.resources.forEach((path, i) => assert.deepEqual(readFileSync(join(f.app, path)), before[i]))
  assert.equal(existsSync(join(f.app, 'resources/app/lib/main.js.before-bridge')), false)
})

for (const layout of ['app', 'app.asar']) for (const legacy of [true, false]) {
  test(`${layout} profile add/remove uses the external runtime with the ${legacy ? 'rc.3' : 'current'} cold CLI API`, async t => {
    const f = fixture(t), owner = join(f.app, 'resources', layout)
    if (layout === 'app.asar') rmSync(join(f.app, 'resources/app.asar'))
    const cli = join(owner, 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js')
    mkdirSync(dirname(cli), { recursive: true })
    if (layout === 'app.asar') rmSync(f.cli)
    writeFileSync(join(owner, 'package.json'), JSON.stringify({ type: 'module' }))
    writeFileSync(cli, `import { join } from 'node:path'; import { execFileSync } from 'node:child_process';
      export async function runDesktopCli(${legacy ? 'runtimeDir, supportDir' : 'supportDir'}) {
        ${legacy ? `if (runtimeDir !== ${JSON.stringify(join(owner, 'dsh'))}) throw new Error('wrong DSH directory');` : ''}
        process.stdout.write(execFileSync(process.execPath, ['--expose-internals', join(supportDir, 'primary-runtime/dependencies/pnpm/bin/pnpm.mjs'), ...process.argv.slice(2)], {env: process.env}));
      }
      if (import.meta.main) throw new Error('must not use the unpacked CLI auto-entry runtime guess');`)
    const pnpm = join(f.app, 'resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs')
    writeFileSync(pnpm, `console.log(JSON.stringify({entry: import.meta.filename, args: process.argv.slice(2), home: process.env.DSH_HOME}))`)
    for (const action of ['install', 'uninstall']) {
      const result = await repairProfileExtension(action, f.app, f.home, async (_command, argv, env) => {
        const output = execFileSync(process.execPath, argv, { env, encoding: 'utf8' })
        const observed = JSON.parse(output)
        assert.equal(observed.entry, pnpm)
        assert.equal(observed.home, f.home)
        assert.deepEqual(observed.args.slice(0, 4), ['plugin', '--profile', 'desktop', action === 'install' ? 'add' : 'remove'])
        return { code: 0, output }
      })
      assert.equal(result.ok, true)
    }
    rmSync(pnpm)
    await assert.rejects(repairProfileExtension('uninstall', f.app, f.home, async () => assert.fail('must not spawn')), { code: 'REINSTALL_RUNTIME_MISSING' })
  })
}

test('missing profiles and missing package specs fail before starting any installer; CLI permission failures remain failures', async t => {
  const f = fixture(t)
  await assert.rejects(profileExtensionCommand('install', f.app, join(f.root, 'missing-home')), /ENOENT/)
  writeFileSync(join(f.profile, 'package.json'), '{}')
  await assert.rejects(profileExtensionCommand('install', f.app, f.home), { code: 'REINSTALL_DEPENDENCY_MISSING' })
  writeFileSync(join(f.profile, 'package.json'), JSON.stringify({ dependencies: { 'dsh-builtin-browser': '^0.7.42' } }))
  let calls = 0
  const result = await repairProfileExtension('install', f.app, f.home, async () => {
    calls++; return { code: 1, output: 'EACCES: profile is read-only' }
  })
  assert.equal(calls, 1); assert.equal(result.ok, false); assert.match(result.output, /EACCES/)
})

test('raw packed CLI discovery works with ASAR disabled in the maintenance worker', async t => {
  const f = fixture(t), entry = 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'
  writeAsar(join(f.app, 'resources/app.asar'), { [entry]: 'export const runDesktopCli = () => {}' })
  rmSync(f.cli)
  const previous = process.noAsar
  process.noAsar = true
  try {
    const args = await profileExtensionCommand('uninstall', f.app, f.home)
    assert.equal(args[0], join(f.app, 'resources/app.asar', entry))
  } finally { process.noAsar = previous }
})

test('a rejected profile command remains failed after Desktop recovery instead of reporting a repaired extension', async t => {
  const f = fixture(t)
  const phases = [], verified = []
  const result = await runMaintenanceLifecycle('install', {
    requestQuit: async () => {}, waitUntilClosed: async () => {},
    maintain: () => repairProfileExtension('install', f.app, f.home, async () => ({ code: 1, output: 'already-installed' })),
    restart: async () => 123,
    verify: async (_pid, action) => { verified.push(action) },
    publish: async state => { phases.push(state.phase) },
  })
  assert.equal(result.ok, false)
  assert.equal(result.phase, 'failed')
  assert.equal(result.restarted, true)
  assert.match(result.error, /already-installed/)
  assert.deepEqual(verified, ['uninstall'])
  assert.equal(phases.includes('completed'), false)
})

test('live package metadata includes same-version bridge replacements and keeps separate homes separate', async t => {
  const f = fixture(t)
  const directory = join(f.profile, 'node_modules/dsh-builtin-browser')
  mkdirSync(join(directory, 'desktop-bridge'), { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'dsh-builtin-browser', version: '1.0.0', dsh: { desktop: { main: './desktop-bridge/main.mjs' } } }))
  const bridge = join(directory, 'desktop-bridge/plugin-browser-bridge.js')
  writeFileSync(bridge, 'first')
  const first = await installedProfileExtension(f.home)
  writeFileSync(bridge, 'replacement')
  const second = await installedProfileExtension(f.home)
  assert.equal(first.version, second.version); assert.notEqual(first.build, second.build)
  assert.equal(second.build, createHash('sha256').update('replacement').digest('hex'))
  await assert.rejects(installedProfileExtension(join(f.root, 'other-home')), /ENOENT/)
  assert.notEqual(extensionHomeId(f.home), extensionHomeId(join(f.root, 'other-home')))
})

async function endpoint(t, home, answer) {
  const sockets = new Set()
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket))
    socket.on('error', error => assert.ok(['ECONNRESET', 'EPIPE'].includes(error.code), String(error)))
    let buffer = ''
    socket.on('data', data => {
      buffer += data
      while (buffer.includes('\n')) {
        const at = buffer.indexOf('\n'), request = JSON.parse(buffer.slice(0, at)); buffer = buffer.slice(at + 1)
        if (!request.op) continue
        const reply = request.op === 'version' ? answer() : { ok: true, protocol: 5 }
        socket.write(JSON.stringify({ ...reply, bridgeRequestId: request.bridgeRequestId }) + '\n')
      }
    })
  })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)) })
  const path = join(home, 'dsh-builtin-browser-bridge.json')
  writeFileSync(path, JSON.stringify({ pid: process.pid, port: server.address().port, token: 'private-test-token' }))
  return path
}

test('restart verification requires the host loaded status plus live bridge version/build under the correct home', async t => {
  const f = fixture(t), extension = { version: '1.0.0', build: 'build-new' }
  const valid = { ok: true, bridgeVersion: extension.version, bridgeBuild: extension.build, homeId: extensionHomeId(f.home),
    mainExtension: { state: 'loaded', version: extension.version, loadedAt: new Date().toISOString() } }
  let answer = valid
  const path = await endpoint(t, f.home, () => answer)
  const options = { endpointPath: path, timeoutMs: 40, pollMs: 1, home: f.home, extension }
  await waitForRestartedBridge(process.pid, options)
  assert.deepEqual(await readHostExtensionStatus(f.home), valid.mainExtension)
  for (const wrong of [
    { ...valid, bridgeVersion: 'old' }, { ...valid, bridgeBuild: 'old' }, { ...valid, homeId: extensionHomeId(join(f.root, 'other')) },
    ...['not-installed', 'pending-restart', 'failed'].map(state => ({ ...valid, mainExtension: { ...valid.mainExtension, state } })),
  ]) {
    answer = wrong
    await assert.rejects(waitForRestartedBridge(process.pid, options), /did not become ready/)
  }
  answer = valid
  await assert.rejects(waitForRestartedBridge(process.pid + 1, options), /did not become ready/)
  answer = { ok: true }
  assert.equal(await readHostExtensionStatus(f.home), undefined)
})

test('bridge status uses host status instead of file markers and reports unsupported hosts explicitly', () => {
  const root = join(tmpdir(), 'not-a-desktop')
  assert.equal(readBridgeStatus(root).code, 'DESKTOP_MAIN_EXTENSION_UNSUPPORTED')
  for (const [state, bridge] of [['loaded', 'installed'], ['not-installed', 'missing'], ['pending-restart', 'stale'], ['failed', 'stale']]) {
    const status = readBridgeStatus(root, { state, version: '1.0.0' })
    assert.equal(status.state, bridge); assert.equal(status.mainExtension.state, state)
    assert.notEqual(status.code, 'DESKTOP_MAIN_EXTENSION_UNSUPPORTED')
  }
})
