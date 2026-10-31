import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs, { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { apply } from '../lib/browser-electron/entry.js'
import { SettingsStore, DEFAULT_SETTINGS } from '../lib/browser-electron/settings-store.js'
import { DesktopBridgeViewHost } from '../lib/browser-electron/desktop-bridge-host.js'

class Sidebar {
  disposed = false
  onLost(listener) { this.lost = listener }
  dispose() { this.disposed = true }
}

function harness(t, channel, discover = () => new Promise(() => {})) {
  const folder = mkdtempSync(join(tmpdir(), 'dsh-carrier-choice-'))
  const oldHome = process.env.DSH_HOME
  const oldChrome = process.env.DSH_BROWSER_CHROME_PATH
  process.env.DSH_HOME = folder
  process.env.DSH_BROWSER_CHROME_PATH = process.execPath
  mkdirSync(join(folder, 'dsh-builtin-browser-host'))
  let settings = { ...DEFAULT_SETTINGS, browser: { ...DEFAULT_SETTINGS.browser, channel } }
  t.mock.method(SettingsStore.prototype, 'get', () => settings)
  t.mock.method(SettingsStore.prototype, 'update', patch => {
    settings = { ...settings, browser: { ...settings.browser, ...patch.browser } }
    return settings
  })
  t.mock.method(DesktopBridgeViewHost, 'discover', discover)
  const registered = []
  const disposers = []
  let current, handler
  const routes = new Map()
  const ctx = {
    browser: { registerBrowserProvider(provider) {
      current = provider.host
      registered.push(current)
      return () => {}
    } },
    effect(fn) { const dispose = fn(); if (dispose) disposers.push(dispose) },
    logger: { info() {}, warn() {} },
    inject(_deps, callback) { callback({ effect(fn) { fn() }, webServer: {
      // The plugin registers more than one exact route now (settings, and the live-view frame
      // endpoint), so a single `handler` variable meant the second registration silently replaced
      // the first. Keyed by path, the settings request keeps reaching the settings handler.
      register(route) {
        routes.set(route.path, route.handler)
        if (route.path === '/dsh-builtin-browser/settings') handler = route.handler
        return () => { routes.delete(route.path) }
      },
    } }) },
  }
  const dispose = () => { for (const fn of disposers.splice(0).reverse()) fn() }
  t.after(() => {
    dispose()
    for (const host of registered) host.dispose?.()
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
    if (oldChrome === undefined) delete process.env.DSH_BROWSER_CHROME_PATH; else process.env.DSH_BROWSER_CHROME_PATH = oldChrome
    rmSync(folder, { recursive: true, force: true })
  })
  apply(ctx, {})
  return {
    get current() { return current }, registered, dispose,
    async choose(nextChannel) {
      const request = Readable.from([JSON.stringify({ browser: { channel: nextChannel } })])
      request.method = 'PUT'
      request.headers = { host: 'localhost:3000', origin: 'http://localhost:3000' }
      let response
      await handler(request, { writeHead() {}, end(text) { response = JSON.parse(text) } })
      assert.equal(response.ok, true)
      assert.equal(response.carrierRechosen, true)
    },
  }
}

test('switching from Chrome back to bundled installs a fresh self-hosted carrier', async t => {
  const h = harness(t, 'chrome')
  const previous = h.current
  await h.choose('bundled')
  assert.equal(h.current.constructor.name, 'RemoteElectronViewHost')
  assert.notEqual(h.current, h.registered[0], 'the initial self-hosted carrier was already released')
  assert.equal(previous.available(), false, 'the previous browser is released')
})

test('auto with no installed browser replaces a previous explicit carrier with bundled', async t => {
  const h = harness(t, 'chrome')
  const exists = t.mock.method(fs, 'existsSync', () => false)
  syncBuiltinESMExports()
  try { await h.choose('auto') } finally { exists.mock.restore(); syncBuiltinESMExports() }
  assert.equal(h.current.constructor.name, 'RemoteElectronViewHost')
})

test('a stale sidebar discovery cannot overwrite a newer explicit selection', async t => {
  let resolveDiscovery
  const h = harness(t, 'bundled', () => new Promise(resolve => { resolveDiscovery = resolve }))
  await h.choose('chrome')
  const selected = h.current
  const stale = new Sidebar()
  resolveDiscovery(stale)
  await new Promise(setImmediate)
  assert.equal(h.current, selected)
  assert.equal(stale.disposed, true, 'unused discovery results release their resources')
  assert.equal(selected.available(), true)
})

test('a late loss notification from a replaced sidebar cannot replace the current carrier', async t => {
  const sidebar = new Sidebar()
  const h = harness(t, 'bundled', async () => sidebar)
  await new Promise(setImmediate)
  assert.equal(h.current, sidebar)
  await h.choose('chrome')
  const selected = h.current
  sidebar.lost('shell-exited')
  await new Promise(setImmediate)
  assert.equal(h.current, selected)
})

test('disposing the plugin cancels pending discovery and releases the currently selected carrier', async t => {
  let resolveDiscovery
  const h = harness(t, 'bundled', () => new Promise(resolve => { resolveDiscovery = resolve }))
  h.dispose()
  const registrations = h.registered.length
  const stale = new Sidebar()
  resolveDiscovery(stale)
  await new Promise(setImmediate)
  assert.equal(h.registered.length, registrations, 'disposed contexts never register a replacement')
  assert.equal(stale.disposed, true)
})

test('disposing a plugin using Chrome releases Chrome too', t => {
  const h = harness(t, 'chrome')
  const selected = h.current
  h.dispose()
  assert.equal(selected.available(), false)
})

test('disposing the plugin cancels a scheduled sidebar retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let attempts = 0
  const h = harness(t, 'bundled', async () => { attempts += 1; return undefined })
  await new Promise(setImmediate)
  assert.equal(attempts, 1)
  h.dispose()
  t.mock.timers.tick(30_000)
  await new Promise(setImmediate)
  assert.equal(attempts, 1, 'a stopped plugin performs no further endpoint discovery')
})

test('a current sidebar loss installs a fallback that is also released at teardown', async t => {
  const sidebar = new Sidebar()
  const h = harness(t, 'bundled', async () => sidebar)
  await new Promise(setImmediate)
  sidebar.lost('shell-exited')
  await new Promise(setImmediate)
  const fallback = h.current
  assert.equal(fallback.constructor.name, 'RemoteElectronViewHost')
  assert.equal(sidebar.disposed, true)
  const registrations = h.registered.length
  h.dispose()
  sidebar.lost('shell-exited')
  assert.equal(h.registered.length, registrations)
  await assert.rejects(
    () => fallback.createView().sendCommand('Runtime.evaluate', { expression: '1' }),
    /disposed/,
    'the fallback is released and cannot restart a child',
  )
})
