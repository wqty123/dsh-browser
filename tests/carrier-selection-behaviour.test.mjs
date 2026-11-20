import { testTab, testScope, tabIn } from './canonical-fixtures.mjs'
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
import { SystemBrowserViewHost } from '../lib/browser-electron/system-browser.js'

class Sidebar {
  disposed = false
  onLost(listener) { this.lost = listener }
  dispose() { this.disposed = true }
  createView(identity) { const owner = JSON.parse(decodeURIComponent(identity.slice('dsh-tab:v1:'.length)))[0]; return { id: identity, async sendCommand(method) { return { method, owner } } } }
  destroyView() {}
  showView() {}
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
    settings = { ...settings, browser: { ...settings.browser, ...patch.browser },
      cookies: { ...settings.cookies, ...patch.cookies }, ui: { ...settings.ui, ...patch.ui } }
    return settings
  })
  t.mock.method(DesktopBridgeViewHost, 'discover', discover)
  const registered = []
  const disposers = []
  let current, handler, panelFactory, failRegistration = false
  const routes = new Map()
  const ctx = {
    get(name) {
      if (name === 'connection') return {
        authorizeIndex(request, response) {
          if (request.headers.cookie === 'dsh_test_session=authenticated') return true
          response.writeHead(401)
          response.end(JSON.stringify({ ok: false, error: 'unauthorized' }))
          return false
        },
      }
      return undefined
    },
    browser: { registerPanelProvider(factory) {
      panelFactory = factory
      return () => { panelFactory = undefined }
    }, registerBrowserProvider(provider) {
      if (failRegistration) { failRegistration = false; throw new Error('registration failed') }
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
    get current() { return current }, get panelFactory() { return panelFactory }, registered, dispose,
    failNextRegistration() { failRegistration = true },
    async status() {
      let body
      await routes.get('/dsh-builtin-browser/runtime-status')({ method: 'GET', headers: {
        host: 'localhost:3000', origin: 'http://localhost:3000', cookie: 'dsh_test_session=authenticated',
      } }, { writeHead() {}, end(text) { body = JSON.parse(text) } })
      assert.equal(body.ok, true)
      return body.runtime
    },
    diskPatch(patch) {
      SettingsStore.prototype.update(patch)
      const file = join(folder, 'dsh-builtin-browser-host', 'settings.json')
      fs.writeFileSync(file, JSON.stringify(settings))
      const time = Date.now() / 1000 + registered.length + 1
      fs.utimesSync(file, time, time)
    },
    async patch(patch) {
      const request = Readable.from([JSON.stringify(patch)])
      request.method = 'PUT'
      request.headers = { host: 'localhost:3000', origin: 'http://localhost:3000', cookie: 'dsh_test_session=authenticated' }
      let response
      await handler(request, { writeHead() {}, end(text) { response = JSON.parse(text) } })
      assert.equal(response.ok, true)
      return response
    },
    async choose(nextChannel) {
      const request = Readable.from([JSON.stringify({ browser: { channel: nextChannel } })])
      request.method = 'PUT'
      request.headers = { host: 'localhost:3000', origin: 'http://localhost:3000', cookie: 'dsh_test_session=authenticated' }
      let response
      await handler(request, { writeHead() {}, end(text) { response = JSON.parse(text) } })
      assert.equal(response.ok, true)
      assert.equal(response.carrierRechosen, true)
    },
  }
}

for (const source of ['PUT', 'disk']) test(`${source} replaces the carrier for profile, headless, persistence and channel changes only`, async t => {
  let poll
  const interval = globalThis.setInterval
  t.mock.method(globalThis, 'setInterval', (fn, ms, ...args) => {
    if (ms === 5000) { poll = fn; return { unref() {} } }
    return interval(fn, ms, ...args)
  })
  const h = harness(t, 'chrome')
  for (const patch of [
    { browser: { systemProfile: 'user' } }, { browser: { systemProfile: 'plugin' } },
    { browser: { headless: 'windowed' } }, { cookies: { persist: false } },
    { browser: { channel: 'sidebar' } },
  ]) {
    const previous = h.current
    if (source === 'PUT') assert.equal((await h.patch(patch)).carrierRechosen, true)
    else h.diskPatch(patch)
    poll()
    assert.notEqual(h.current, previous)
    assert.equal(previous.available?.() ?? !previous.disposed, false)
    const count = h.registered.length
    poll()
    assert.equal(h.registered.length, count, 'polling does not replace a carrier twice')
  }
  const previous = h.current
  const unrelated = { ui: { quiet: true } }
  if (source === 'PUT') assert.equal((await h.patch(unrelated)).carrierRechosen, undefined)
  else h.diskPatch(unrelated)
  poll()
  assert.equal(h.current, previous, 'unrelated changes leave the carrier intact')
})

test('the installed runtime route reads the selected system carrier connection and launch error', async t => {
  let state = { connected: false, detail: 'Not launched yet' }
  t.mock.method(SystemBrowserViewHost.prototype, 'connectionStatus', () => state)
  const h = harness(t, 'chrome')
  assert.equal((await h.status()).readiness, 'blocked')
  state = { connected: true, detail: 'Live CDP' }
  assert.equal((await h.status()).readiness, 'ready')
  state = { connected: false, detail: 'Default-profile debugging refused' }
  assert.equal((await h.status()).readiness, 'blocked')
  assert.equal((await h.status()).systemBrowser.detail, state.detail)
  await h.patch({ browser: { systemProfile: 'user' } })
  assert.equal((await h.status()).readiness, 'blocked')
  assert.equal((await h.status()).resolvedCarrier, 'system')
})

test('persistence changes in user-profile mode leave the selected profile carrier intact', async t => {
  let poll
  const interval = globalThis.setInterval
  t.mock.method(globalThis, 'setInterval', (fn, ms, ...args) => {
    if (ms === 5000) { poll = fn; return { unref() {} } }
    return interval(fn, ms, ...args)
  })
  const h = harness(t, 'chrome')
  await h.patch({ browser: { systemProfile: 'user' } })
  const previous = h.current
  assert.equal((await h.patch({ cookies: { persist: false } })).carrierRechosen, undefined)
  poll()
  assert.equal(h.current, previous)
  h.diskPatch({ cookies: { persist: true } })
  poll()
  assert.equal(h.current, previous)
})

test('switching from Chrome to legacy bundled installs only a reconnectable sidebar', async t => {
  const h = harness(t, 'chrome')
  const previous = h.current
  await h.choose('bundled')
  assert.equal(h.current.constructor.name, 'SidebarOnlyHost')
  assert.notEqual(h.current, h.registered[0], 'the initial sidebar was released by explicit Chrome selection')
  assert.equal(previous.available(), false, 'the previous browser is released')
})

test('legacy auto with no installed browser replaces an explicit carrier with the sidebar', async t => {
  const h = harness(t, 'chrome')
  const exists = t.mock.method(fs, 'existsSync', () => false)
  syncBuiltinESMExports()
  try { await h.choose('auto') } finally { exists.mock.restore(); syncBuiltinESMExports() }
  assert.equal(h.current.constructor.name, 'SidebarOnlyHost')
})

test('a stale sidebar discovery cannot overwrite a newer explicit selection', async t => {
  let resolveDiscovery
  const h = harness(t, 'bundled', () => new Promise(resolve => { resolveDiscovery = resolve }))
  const pending = h.current.createView(testTab('task')).sendCommand('Runtime.evaluate')
  const rejected = assert.rejects(pending, /disposed/)
  await new Promise(setImmediate)
  await h.choose('chrome')
  const selected = h.current
  const stale = new Sidebar()
  resolveDiscovery(stale)
  await rejected
  await new Promise(setImmediate)
  assert.equal(h.current, selected)
  assert.equal(stale.disposed, true, 'unused discovery results release their resources')
  assert.equal(selected.available(), true)
})

test('a late loss notification from a replaced sidebar cannot replace the current carrier', async t => {
  const sidebar = new Sidebar()
  const h = harness(t, 'bundled', async () => sidebar)
  await h.current.createView(testTab('task')).sendCommand('Runtime.evaluate')
  assert.equal(h.current.constructor.name, 'SidebarOnlyHost')
  await h.choose('chrome')
  const selected = h.current
  sidebar.lost('shell-exited')
  await new Promise(setImmediate)
  assert.equal(h.current, selected)
})

test('disposing the plugin cancels pending discovery and releases the currently selected carrier', async t => {
  let resolveDiscovery
  const h = harness(t, 'bundled', () => new Promise(resolve => { resolveDiscovery = resolve }))
  const pending = h.current.createView(testTab('task')).sendCommand('Runtime.evaluate')
  const rejected = assert.rejects(pending, /disposed/)
  await new Promise(setImmediate)
  h.dispose()
  const registrations = h.registered.length
  const stale = new Sidebar()
  resolveDiscovery(stale)
  await rejected
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
  const pending = h.current.createView(testTab('task')).sendCommand('Runtime.evaluate')
  const rejected = assert.rejects(pending, /abort/iu)
  await new Promise(setImmediate)
  assert.equal(attempts, 1)
  h.dispose()
  await rejected
  t.mock.timers.tick(30_000)
  await new Promise(setImmediate)
  assert.equal(attempts, 1, 'a stopped plugin performs no further endpoint discovery')
})

test('a current sidebar loss reconnects the same handles without replacing the provider', async t => {
  const sidebar = new Sidebar()
  const recovered = new Sidebar()
  let discoveries = 0
  const h = harness(t, 'bundled', async () => ++discoveries === 1 ? sidebar : recovered)
  const selected = h.current
  const view = selected.createView(testTab('task'))
  await view.sendCommand('Runtime.evaluate')
  sidebar.lost('shell-exited')
  assert.equal(h.current, selected)
  assert.equal(sidebar.disposed, false)
  await new Promise(setImmediate)
  assert.equal(sidebar.disposed, true)
  assert.deepEqual(await view.sendCommand('Runtime.evaluate'), { method: 'Runtime.evaluate', owner: 'task' })
  assert.equal(discoveries, 2)
  const registrations = h.registered.length
  h.dispose()
  assert.equal(recovered.disposed, true)
  sidebar.lost('shell-exited')
  assert.equal(h.registered.length, registrations)
  await assert.rejects(
    async () => selected.createView(testTab()).sendCommand('Runtime.evaluate', { expression: '1' }),
    /disposed/,
    'the disposed sidebar cannot discover or start another carrier',
  )
})

for (const channel of ['sidebar', 'bundled', 'auto']) {
  test(`${channel} stays inert until needed and refuses an iframe sidebar without a fallback`, async t => {
    let discoveries = 0
    const h = harness(t, channel, async () => { discoveries++; return undefined })
    t.mock.method(DesktopBridgeViewHost, 'refusedIframePanel', () => true)
    assert.equal(discoveries, 0)
    assert.equal(h.current.constructor.name, 'SidebarOnlyHost')
    await assert.rejects(h.current.createView(testTab('task')).sendCommand('Runtime.evaluate'), /sidebar is an iframe.*cannot support CDP tools.*host-provided sidebar\/webview.*No standalone browser/s)
    assert.equal(discoveries, 1)
    assert.ok(h.registered.every(host => host.constructor.name === 'SidebarOnlyHost'))
  })
}

test('a failed explicit carrier registration restores only the sidebar', async t => {
  const h = harness(t, 'sidebar')
  h.failNextRegistration()
  await h.choose('chrome')
  assert.equal(h.current.constructor.name, 'SidebarOnlyHost')
  assert.ok(h.registered.every(host => host.constructor.name !== 'RemoteElectronViewHost'))
})

test('the panel provider uses a discovered sidebar independently of an explicit Chrome carrier', async t => {
  const sidebar = new Sidebar()
  let discoveries = 0
  const h = harness(t, 'chrome', async () => { discoveries += 1; return sidebar })
  const selected = h.current
  const panel = await h.panelFactory('task-1')
  assert.equal(panel.host, sidebar)
  assert.equal(h.current, selected, 'opening the panel does not replace the explicit carrier')
  assert.equal(await h.panelFactory('task-2'), panel, 'one sidebar provider owns isolated per-task sessions')
  assert.equal(discoveries, 1)
  h.dispose()
  await new Promise(setImmediate)
  assert.equal(sidebar.disposed, true)
})

test('unsupported panel discovery never returns Chrome, and a later explicit open may rediscover', async t => {
  let discoveries = 0
  const h = harness(t, 'chrome', async () => { discoveries += 1; return undefined })
  const selected = h.current
  assert.equal(await h.panelFactory('task'), undefined)
  assert.equal(await h.panelFactory('task'), undefined)
  assert.equal(discoveries, 2)
  assert.equal(h.current, selected)
})
