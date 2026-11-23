/**
 * DSH Tauri sidebar persistence: its electron-rs main gives every sidebar guest an in-memory
 * `electron-browser-<uuid>` partition, so logins never survived a restart. The host patch moves the
 * guests to one persistent partition per owner profile and checkpoints the session cookies Chromium
 * drops at exit. These tests run the real v0.33.0 runtime/browser.cjs, before and after the patch.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import * as crypto from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { tmpdir } from 'node:os'
import { Readable } from 'node:stream'
import { applyHostPatch, hostPatchStatus, patchText, restoreHostPatch } from '../dsh-host-patch/apply.mjs'
import { tauriHostPatchSpec } from '../tools/generate-tauri-host-patch.mjs'
import { createHostPatchMaintenance } from '../src/browser-electron/host-patch-maintenance.ts'

const fixtureDir = new URL('./fixtures/dsh-host-patch/tauri-0.33.0/', import.meta.url)
const pristine = fs.readFileSync(new URL('browser.cjs', fixtureDir), 'utf8')
const metadata = fs.readFileSync(new URL('electron-rs.json', fixtureDir), 'utf8')
const spec = JSON.parse(fs.readFileSync(new URL('../dsh-host-patch/tauri.json', import.meta.url), 'utf8'))
const patched = patchText(pristine, spec.targets[0])

function temporary(t) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'dsh-tauri-patch-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return root
}

function runtimeDir(root, browser = pristine, identity = metadata) {
  const runtime = path.join(root, 'runtime', 'win32-x64')
  fs.mkdirSync(path.join(runtime, 'runtime'), { recursive: true })
  fs.writeFileSync(path.join(runtime, 'electron-rs.json'), identity)
  fs.writeFileSync(path.join(runtime, 'runtime', 'browser.cjs'), browser)
  return runtime
}

class FakeCookies extends EventEmitter {
  constructor() { super(); this.jar = new Map(); this.sets = []; this.flushes = 0 }
  async set(details) {
    this.sets.push(details)
    const host = new URL(details.url).hostname
    const cookie = { name: details.name, value: details.value, domain: details.domain ?? host, hostOnly: details.domain === undefined,
      path: details.path ?? '/', secure: details.secure === true, httpOnly: details.httpOnly === true,
      session: details.expirationDate === undefined, ...details.expirationDate === undefined ? {} : { expirationDate: details.expirationDate } }
    this.jar.set(`${cookie.name}|${cookie.domain}|${cookie.path}`, cookie)
    this.emit('changed', {}, cookie, 'explicit', false)
  }
  async flushStore() { this.flushes++ }
}

/** Electron's session/app surface that browser.cjs touches, with partitions stored under `root`. */
function fakeElectron(root) {
  const sessions = new Map()
  const fromPartition = name => {
    if (!sessions.has(name)) {
      const storagePath = name.startsWith('persist:') ? path.join(root, 'Partitions', name.slice(8)) : null
      if (storagePath !== null) fs.mkdirSync(storagePath, { recursive: true })
      sessions.set(name, Object.assign(new EventEmitter(), {
        name, storagePath, cookies: new FakeCookies(),
        setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, setDevicePermissionHandler() {}, setDisplayMediaRequestHandler() {},
        webRequest: { onBeforeRequest() {} },
      }))
    }
    return sessions.get(name)
  }
  const app = Object.assign(new EventEmitter(), { getPath: () => path.join(root, 'userData') })
  return { electron: { session: { fromPartition }, app }, sessions }
}

function loadGuests(source, electron) {
  const module = { exports: {} }
  const modules = { electron, 'node:crypto': crypto, 'node:fs': fs, 'node:path': path, './origin.cjs': { documentOrigin: url => new URL(url).origin } }
  new Function('exports', 'require', 'module', source)(module.exports, name => modules[name], module)
  return module.exports.BrowserGuests
}

function owner(profileStorage) {
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, getURL: () => 'http://127.0.0.1:4567/', mainFrame: {}, session: { storagePath: profileStorage },
  })
  return Object.assign(new EventEmitter(), { id: 1, contents, trustedOrigin: 'http://127.0.0.1:4567', trustedNavigationPending: false })
}

async function boot(source, root, profile = 'profile-desktop-main') {
  const { electron, sessions } = fakeElectron(root)
  const BrowserGuests = loadGuests(source, electron)
  const guests = new BrowserGuests({ send() {} })
  const host = owner(path.join(root, 'Partitions', profile))
  guests.bind(host)
  return { guests, host, sessions, electron }
}

const settle = () => new Promise(resolve => setTimeout(resolve, 300))

test('the committed tauri.json is generated from sidebar-session.cjs and the pristine runtime', () => {
  assert.deepEqual(spec, tauriHostPatchSpec())
  assert.equal(spec.targets[0].sha256, crypto.createHash('sha256').update(pristine).digest('hex'))
  assert.throws(() => patchText(patched, spec.targets[0]), /already patched/)
})

test('unpatched DSH Tauri gives each workspace a fresh in-memory partition (the bug)', async t => {
  const root = temporary(t)
  const first = await boot(pristine, root)
  const lease = first.guests.acquire(first.host, 'cwd:/project')
  assert.match(lease.partition, /^electron-browser-[0-9a-f-]{36}$/)
  const restarted = await boot(pristine, root)
  assert.notEqual(restarted.guests.acquire(restarted.host, 'cwd:/project').partition, lease.partition)
})

test('patched: one persistent partition per owner profile, stable across restarts and workspaces', async t => {
  const root = temporary(t)
  const first = await boot(patched, root)
  const a = await first.guests.acquire(first.host, 'cwd:/project')
  const b = await first.guests.acquire(first.host, 'session:other')
  assert.match(a.partition, /^persist:dsh-sidebar-browser-[0-9a-f]{32}$/)
  assert.equal(b.partition, a.partition)
  assert.notEqual(b.lease, a.lease)
  const restarted = await boot(patched, root)
  assert.equal((await restarted.guests.acquire(restarted.host, 'cwd:/project')).partition, a.partition)
  const otherProfile = await boot(patched, root, 'profile-web-main')
  assert.notEqual((await otherProfile.guests.acquire(otherProfile.host, 'cwd:/project')).partition, a.partition)
  await assert.rejects(Promise.resolve().then(() => first.guests.acquire(first.host, '')), /invalid workspace/)
})

test('patched: session cookies are checkpointed and restored before the next guest is leased', async t => {
  const root = temporary(t)
  const first = await boot(patched, root)
  const { partition } = await first.guests.acquire(first.host, 'cwd:/project')
  const jar = first.sessions.get(partition).cookies
  await jar.set({ url: 'https://the-internet.herokuapp.com/', name: 'rack.session', value: 'signed-in', httpOnly: true, secure: true })
  await jar.set({ url: 'https://www.saucedemo.com/', name: 'session-username', value: 'standard_user', domain: '.saucedemo.com' })
  await jar.set({ url: 'https://example.com/', name: 'remember', value: 'long', expirationDate: Date.now() / 1000 + 3600 })
  await jar.set({ url: 'https://example.com/', name: 'gone', value: 'x' })
  const gone = [...jar.jar.values()].find(cookie => cookie.name === 'gone')
  jar.emit('changed', {}, gone, 'explicit', true)
  await settle()
  assert.ok(jar.flushes > 0, 'persistent cookies are flushed to disk as they change')
  const file = path.join(first.sessions.get(partition).storagePath, 'dsh-sidebar-session-cookies.json')
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.deepEqual(saved.map(cookie => cookie.name).sort(), ['rack.session', 'session-username'])

  const restarted = await boot(patched, root)
  await restarted.guests.acquire(restarted.host, 'cwd:/project')
  const restored = restarted.sessions.get(partition).cookies.sets
  assert.deepEqual(restored.map(cookie => [cookie.url, cookie.name, cookie.value, cookie.domain, cookie.httpOnly, cookie.secure]).sort(), [
    ['http://saucedemo.com/', 'session-username', 'standard_user', '.saucedemo.com', false, false],
    ['https://the-internet.herokuapp.com/', 'rack.session', 'signed-in', undefined, true, true],
  ])
  await settle()
})

test('patched: a pending checkpoint is written synchronously when the app quits', async t => {
  const root = temporary(t)
  const first = await boot(patched, root)
  const { partition } = await first.guests.acquire(first.host, 'cwd:/project')
  await first.sessions.get(partition).cookies.set({ url: 'https://www.saucedemo.com/', name: 'session-username', value: 'standard_user' })
  first.electron.app.emit('will-quit')
  const file = path.join(first.sessions.get(partition).storagePath, 'dsh-sidebar-session-cookies.json')
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8'))[0].value, 'standard_user')
  await settle()
})

test('apply.mjs patches a DSH Tauri runtime by electron-rs identity and pristine sha256, and restores it', t => {
  const runtime = runtimeDir(temporary(t))
  const file = path.join(runtime, 'runtime', 'browser.cjs')
  assert.equal(hostPatchStatus(runtime).status, 'absent')
  assert.deepEqual(applyHostPatch(runtime), { status: 'applied', changed: true })
  assert.equal(fs.readFileSync(file, 'utf8'), patched)
  assert.equal(fs.readFileSync(file + '.before-dsh-host-patch', 'utf8'), pristine)
  assert.equal(hostPatchStatus(runtime).status, 'applied')
  assert.deepEqual(applyHostPatch(runtime), { status: 'applied', changed: false })
  assert.deepEqual(restoreHostPatch(runtime), { status: 'absent', changed: true })
  assert.equal(fs.readFileSync(file, 'utf8'), pristine)
})

test('apply.mjs refuses an unknown Tauri runtime build and a different electron-rs app', t => {
  const unknown = runtimeDir(temporary(t), pristine.replace('browser guest: invalid lease', 'browser guest: bad lease'))
  const status = hostPatchStatus(unknown)
  assert.equal(status.status, 'unsupported version')
  assert.match(status.reason, /unsupported DSH Tauri runtime: runtime\/browser\.cjs sha256 [0-9a-f]{64} \(supported releases: 0\.33\.0\)/)
  assert.equal(applyHostPatch(unknown).changed, false)
  const other = runtimeDir(temporary(t), pristine, JSON.stringify({ ...JSON.parse(metadata), identifier: 'some-other-app' }))
  assert.match(hostPatchStatus(other).reason, /unsupported electron-rs runtime: some-other-app/)
})

test('settings maintains the running DSH Tauri runtime and asks for a Tauri restart', async t => {
  const runtime = runtimeDir(temporary(t))
  const handler = createHostPatchMaintenance({ modules: () => undefined, desktop: () => true, tauri: () => runtime })
  const request = async (method, action) => {
    const req = Readable.from([JSON.stringify({ action })])
    req.method = method
    req.headers = { host: '127.0.0.1:3456', origin: 'http://127.0.0.1:3456' }
    req.socket = { remoteAddress: '127.0.0.1' }
    const res = Object.assign(new EventEmitter(), { setHeader() {}, writeHead(code) { this.statusCode = code }, end(body) { this.body = JSON.parse(body) } })
    await handler(req, res)
    return res
  }
  const status = (await request('GET')).body.hostPatch
  assert.deepEqual([status.surface, status.status, status.canInstall, status.canRestore], ['tauri', 'absent', true, false])
  const applied = await request('POST', 'install')
  assert.equal(applied.statusCode, 200)
  assert.deepEqual([applied.body.hostPatch.status, applied.body.hostPatch.restartRequired, applied.body.hostPatch.canRestore], ['applied', true, true])
  const restored = await request('POST', 'restore')
  assert.equal(restored.body.hostPatch.status, 'absent')
  assert.equal(fs.readFileSync(path.join(runtime, 'runtime', 'browser.cjs'), 'utf8'), pristine)
})
