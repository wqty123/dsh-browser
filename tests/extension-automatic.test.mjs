import * as extensionConstants from '../browser-extension/constants.mjs'
import { en } from '../browser-extension/locales.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, createPublicKey, randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, mkdtempSync, rmSync, renameSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PassThrough } from 'node:stream'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { EXTENSION_ID } from '../native-host/identity.mjs'
import { install, publishLauncher, launcherSource } from '../native-host/install.mjs'
import { serve, saveConfiguration } from '../native-host/host.mjs'
import { NativeBrowserClient } from '../native-host/client.mjs'
import { decoder, send, encode } from '../native-host/protocol.mjs'
import { PreferredBrowserViewHost, extensionReady } from '../lib/browser-electron/preferred-browser.js'
import { EXTENSION_ID as PLUGIN_EXTENSION_ID, installExtension, registrationStatus } from '../lib/browser-electron/extension-setup.js'
import { testTab, testScope } from './canonical-fixtures.mjs'
import { readRuntimeStatus } from '../lib/browser-electron/runtime-status.js'

function directory(t) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-auto-extension-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

test('Windows launcher flushes each stdin and stdout chunk before waiting for EOF', () => {
  const source = launcherSource('C:\\Program Files\\node.exe', 'C:\\plugin\\host.mjs', 'C:\\state\\config.json')
  assert.match(source, /while\(\(count=input\.Read\(buffer,0,buffer\.Length\)\)>0\)\s*\{\s*output\.Write\(buffer,0,count\);\s*output\.Flush\(\);\s*\}/)
  assert.ok(source.includes('Relay(Console.OpenStandardInput(),process.StandardInput.BaseStream)'))
  assert.ok(source.includes('Relay(process.StandardOutput.BaseStream,Console.OpenStandardOutput())'))
  assert.doesNotMatch(source, /OpenStandardInput\(\)\.CopyTo|StandardOutput\.BaseStream\.CopyTo/)
})

test('Windows launcher runs electron as node so Native Messaging never spawns a window', () => {
  // `install` passes process.execPath, which is electron.exe inside DSH Desktop. Without this the
  // launcher starts a GUI app on every connect and steals focus (issue #129).
  const source = launcherSource('C:\\Program Files\\node.exe', 'C:\\plugin\\host.mjs', 'C:\\state\\config.json')
  assert.match(source, /info\.EnvironmentVariables\["ELECTRON_RUN_AS_NODE"\]="1"/)
})

test('published Windows launcher answers a small hello while stdin remains open', { skip: process.platform !== 'win32' }, async t => {
  const dir = directory(t)
  const installed = install({ browser: 'edge', directory: dir, register: false })
  const manifest = JSON.parse(readFileSync(installed.manifestPath, 'utf8'))
  const child = spawn(manifest.path, [`chrome-extension://${EXTENSION_ID}/`], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const exited = new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve) })
  child.stdin.on('error', () => {})
  let timer
  try {
    const status = new Promise((resolve, reject) => {
      const frames = decoder(message => { if (message.type === 'status') resolve(message) }, reject)
      child.stdout.on('data', chunk => frames.push(chunk))
      child.once('error', reject)
      timer = setTimeout(() => reject(new Error('launcher did not answer hello within 2 seconds with stdin open')), 2000)
    })
    child.stdin.write(encode({ type: 'hello', browser: 'edge', installId: randomUUID() }))
    assert.equal((await status).state, 'connected')
    assert.equal(child.stdin.writableEnded, false)
    assert.equal(typeof JSON.parse(readFileSync(join(dir, extensionConstants.NATIVE_FILES.relay), 'utf8')).endpoint, 'string')
  } finally {
    clearTimeout(timer)
    child.stdin.end()
    const kill = setTimeout(() => child.kill(), 5000)
    try { await exited } finally { clearTimeout(kill) }
  }
})

test('bundled public key derives the same stable extension ID exported to the plugin and host', () => {
  const manifest = JSON.parse(readFileSync(new URL('../browser-extension/manifest.json', import.meta.url)))
  const key = Buffer.from(manifest.key, 'base64')
  createPublicKey({ key, type: 'spki', format: 'der' })
  const id = [...createHash('sha256').update(key).digest().subarray(0, 16)].flatMap(byte => [byte >> 4, byte & 15]).map(n => String.fromCharCode(97 + n)).join('')
  assert.equal(id, EXTENSION_ID)
  assert.equal(id, PLUGIN_EXTENSION_ID)
})

test('bundled registration is idempotent, tokenless and preserves explicit disablement', t => {
  const dir = directory(t), options = { browser: 'edge', directory: dir, register: false }
  const first = install(options)
  const before = readFileSync(join(dir, 'config.json'), 'utf8')
  assert.equal(first.token, undefined)
  install(options)
  assert.equal(readFileSync(join(dir, 'config.json'), 'utf8'), before)
  assert.deepEqual(JSON.parse(readFileSync(first.manifestPath)).allowed_origins, [`chrome-extension://${EXTENSION_ID}/`])
  install({ ...options, revoke: true }); install(options)
  const config = JSON.parse(readFileSync(join(dir, 'config.json')))
  assert.equal(config.disabled, true)
  assert.equal(config.pairDigest, undefined)
})

test('an identical running launcher is neither rebuilt, unlinked nor replaced when locked', t => {
  const executable = join(directory(t), 'native.exe')
  publishLauncher(executable, 'source', path => writeFileSync(path, 'binary'))
  const io = { readFileSync, renameSync() { throw Object.assign(new Error('locked'), { code: 'EPERM' }) }, unlinkSync(path) {
    assert.notEqual(path, executable); unlinkSync(path)
  } }
  publishLauncher(executable, 'source', () => assert.fail('identical launcher must not be rebuilt'), io)
  publishLauncher(executable, 'different source', path => writeFileSync(path, 'binary'), io)
  assert.throws(() => publishLauncher(executable, 'new source', path => writeFileSync(path, 'changed binary'), io), /locked/)
  assert.equal(readFileSync(executable, 'utf8'), 'binary')
})

test('automatic CLI registration defaults to the bundled ID and migrates a legacy directory', t => {
  const dir = directory(t)
  saveConfiguration(join(dir, 'config.json'), { browser: 'edge', extensionId: 'a'.repeat(32), installId: randomUUID(), secret: 'b'.repeat(64) })
  const result = JSON.parse(execFileSync(process.execPath, [fileURLToPath(new URL('../native-host/install.mjs', import.meta.url)), '--browser', 'edge', '--directory', dir, '--no-register'], { encoding: 'utf8' }))
  assert.equal(result.token, undefined)
  assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'))).installId, EXTENSION_ID)
  assert.deepEqual(JSON.parse(readFileSync(result.manifestPath)).allowed_origins, [`chrome-extension://${EXTENSION_ID}/`])
})

test('bundled origin connects without a token; foreign origins and disabled configurations are rejected', async t => {
  const dir = directory(t), configPath = join(dir, 'config.json')
  const config = { browser: 'edge', extensionId: EXTENSION_ID, installId: EXTENSION_ID, label: 'Edge', secret: 'b'.repeat(64) }
  saveConfiguration(configPath, config)
  for (const origin of [undefined, 'https://example.com/', `chrome-extension://${'a'.repeat(32)}/`]) {
    await assert.rejects(serve({ input: new PassThrough(), output: new PassThrough(), configPath, origin }), /origin/)
  }
  const input = new PassThrough(), output = new PassThrough()
  let ready
  const connected = new Promise(resolve => { ready = resolve })
  const frames = decoder(message => { if (message.state === 'connected') ready() }, error => assert.fail(error.message))
  output.on('data', data => frames.push(data))
  const host = await serve({ input, output, configPath, origin: `chrome-extension://${EXTENSION_ID}/` })
  t.after(host.stop)
  send(input, { type: 'hello', browser: 'edge', installId: randomUUID() })
  await connected
  const client = new NativeBrowserClient(dir, 'edge'); t.after(() => client.dispose())
  await client.connect(); assert.equal(client.status().connected, true)
  host.stop()
  saveConfiguration(configPath, { ...config, disabled: true })
  await assert.rejects(serve({ input: new PassThrough(), output: new PassThrough(), configPath, origin: `chrome-extension://${EXTENSION_ID}/` }), /origin/)
  await assert.rejects(new NativeBrowserClient(dir, 'edge').connect(), /disabled/)
})

test('extension readiness is bounded for missing or unresponsive hosts', async () => {
  assert.equal(await extensionReady(async () => {}, 20), true)
  assert.equal(await extensionReady(async () => { throw Error('missing') }, 20), false)
  assert.equal(await extensionReady(() => new Promise(() => {}), 20), false)
})

test('registration status, including failures, is visible even when no extension carrier is selected', () => {
  for (const registration of [{}, { edge: { registered: true, detail: 'Registered' } }, { chrome: { registered: false, detail: 'Permission denied' } }]) {
    const report = readRuntimeStatus({ channel: () => 'sidebar', nativeHostRegistration: () => registration,
      hasBinary: () => false, provision: () => ({ state: 'idle', detail: '', at: '' }), bridge: () => undefined, endpoint: () => undefined })
    assert.deepEqual(report.nativeHostRegistration, registration)
    assert.equal(report.resolvedCarrier, 'sidebar')
  }
})

for (const state of ['extension-missing', 'not-connected', 'disabled']) test(`CDP fallback status retains the reason and never claims the personal profile: ${state}`, () => {
  const report = readRuntimeStatus({ channel: () => 'edge', systemProfile: () => 'user', selectedCarrier: () => 'cdp',
    fallbackReason: () => state === 'extension-missing' ? 'extension-not-installed' : state,
    hasBinary: () => false, provision: () => ({ state: 'idle', detail: '', at: '' }), bridge: () => undefined, endpoint: () => undefined,
    detectBrowser: () => ({ kind: 'edge', path: 'edge.exe' }), systemConnection: () => ({ connected: true, detail: 'Managed CDP ready' }),
    extensionConnection: () => ({ state, connected: false, browser: 'edge', detail: state }) })
  assert.equal(report.resolvedCarrier, 'cdp')
  assert.equal(report.controlledProfile, 'plugin')
  assert.equal(report.readiness, 'ready')
  assert.equal(report.fallbackReason, state === 'extension-missing' ? 'extension-not-installed' : state)
})

test('session routing pins a live CDP session and selects a later extension for the next session', async t => {
  let connected = false
  const client = {
    status: () => ({ connected, state: connected ? 'connected' : 'not-connected', browser: 'edge', epoch: 'epoch', detail: 'test' }),
    connect: async () => { if (!connected) throw Error('not connected') },
    onEvent: () => () => {}, dispose() {},
    request: async operation => operation.kind === 'create' ? { lease: operation.view, tabId: 1 } : { carrier: 'extension' },
  }
  const fallback = { createView: id => ({ id, sendCommand: async () => ({ carrier: 'cdp' }) }), destroyView() {}, dispose() {} }
    const host = new PreferredBrowserViewHost('edge', fallback, client, 10); t.after(() => host.dispose())
  const first = host.createView(testTab('first'))
  assert.equal((await first.sendCommand('Runtime.evaluate', {})).carrier, 'cdp')
  assert.equal(host.fallbackReason, 'not-connected')
  assert.equal(host.referenceOverlayOwnerFor(testScope('first')), undefined)
  connected = true
  assert.equal((await first.sendCommand('Runtime.evaluate', {})).carrier, 'cdp')
  const sameSession = host.createView(testTab('first'))
  assert.equal((await sameSession.sendCommand('Runtime.evaluate', {})).carrier, 'cdp')
  const second = host.createView(testTab('second'))
  assert.equal((await second.sendCommand('Runtime.evaluate', {})).carrier, 'extension')
  assert.equal(host.activeCarrier(), 'extension')
  assert.equal(host.fallbackReason, undefined)
  assert.equal(host.referenceOverlayOwnerFor(testScope('second')), 'client')
})

test('worker auto-connects at boot, install and startup without opening Options; pause is respected', async () => {
  for (const paused of [false, true]) {
    const callbacks = {}, ports = []
    let releases = 0
    const event = name => ({ addListener(fn) { callbacks[name] = fn } })
    const api = { storage: { local: { get: async key => key === 'paused' ? { paused } : { installId: randomUUID() }, set: async () => {} } },
      runtime: { onInstalled: event('installed'), onStartup: event('startup'), onMessage: event('message'), connectNative() {
        const port = { onMessage: event('native-message'), onDisconnect: event('disconnect'), postMessage() {} }
        ports.push(port); return port
      } }, debugger: { onDetach: event('detach') }, alarms: { onAlarm: event('alarm'), create: async () => {}, clear: async () => {} } }
    const source = readFileSync(new URL('../browser-extension/worker.mjs', import.meta.url), 'utf8').replace(/^import[^\n]+\n/gm, '')
    runInNewContext(source, { ...extensionConstants, en, chrome: api, navigator: { userAgent: 'Edg/' }, crypto: { randomUUID }, ExtensionController: class { async release() { releases++ } }, TextEncoder, setTimeout, clearTimeout })
    await new Promise(setImmediate)
    assert.equal(ports.length, paused ? 0 : 1)
    if (!paused) callbacks.disconnect()
    callbacks.installed(); await new Promise(setImmediate)
    assert.equal(ports.length, paused ? 0 : 2)
    if (!paused) callbacks.disconnect()
    callbacks.startup(); await new Promise(setImmediate)
    assert.equal(ports.length, paused ? 0 : 3)
    assert.equal(releases, paused ? 0 : 2, 'every native disconnect releases debugger ownership')
    if (!paused) {
      callbacks['native-message']({ type: 'release' })
      assert.equal(releases, 3, 'plugin transport closure releases ownership')
      callbacks.detach({ tabId: 1 }, 'canceled_by_user')
      assert.equal(ports.length, 3, 'Cancel does not reconnect or attach')
    }
  }
})

test('one-click setup registers then opens only the chosen browser and folder, or just reports connected', async () => {
  registrationStatus.clear()
  for (const platform of ['win32', 'darwin', 'linux']) {
    const calls = []
    const deps = { register: async () => { calls.push('register') }, detect: () => ({ path: 'browser.exe', kind: 'edge' }),
      launch: async (...args) => { calls.push(args) }, platform, storeUrl: '' }
    assert.equal((await installExtension('edge', true, deps)).detail, '已连接')
    assert.deepEqual(calls, ['register']); calls.length = 0
    const result = await installExtension('edge', false, deps)
    assert.match(result.detail, /加载解压缩的扩展/)
    assert.deepEqual(calls[1], ['browser.exe', ['edge://extensions']])
    assert.equal(calls[2][0], platform === 'win32' ? 'explorer.exe' : platform === 'darwin' ? 'open' : 'xdg-open')
    calls.length = 0
    await installExtension('chrome', false, { ...deps, storeUrl: 'https://example.com/extension' })
    assert.deepEqual(calls, ['register', ['browser.exe', ['https://example.com/extension']]])
    assert.equal((await installExtension('edge', false, { ...deps, detect: () => undefined })).ok, false)
    await assert.rejects(installExtension('edge', false, { ...deps, launch: async () => { throw Error('launch failed') } }), /launch failed/)
    registrationStatus.set('edge', { registered: false, detail: 'Permission denied' })
    assert.equal((await installExtension('edge', false, deps)).detail, 'Permission denied')
    registrationStatus.clear()
  }
})
