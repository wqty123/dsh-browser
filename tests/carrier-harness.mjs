import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { apply } from '../lib/browser-electron/entry.js'
import { DEFAULT_SETTINGS, SettingsStore } from '../lib/browser-electron/settings-store.js'
import { DesktopBridgeViewHost } from '../lib/browser-electron/desktop-bridge-host.js'

export class Sidebar {
  disposed = false
  onLost(listener) { this.lose = listener }
  dispose() { this.disposed = true }
  createView(identity) { const owner = JSON.parse(decodeURIComponent(identity.slice('dsh-tab:v1:'.length)))[0]; return { id: identity, async sendCommand(method) { return { method, owner } } } }
  destroyView() {}
  showView() {}
}

export function carrierHarness(t, { channel = 'sidebar', discover = async () => new Sidebar(), viewHost } = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'dsh-carrier-contract-'))
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
  const registered = [], warnings = [], disposers = []
  let current, handler, panelFactory
  const ctx = {
    get(name) { if (name === 'connection') return { authorizeIndex() { return true } } },
    browser: {
      registerPanelProvider(factory) { panelFactory = factory; return () => { panelFactory = undefined } },
      registerBrowserProvider(provider) { current = provider.host; registered.push(current); return () => {} },
    },
    effect(fn) { const dispose = fn(); if (dispose) disposers.push(dispose) },
    logger: { info() {}, warn(message) { warnings.push(message) } },
    inject(_deps, callback) { callback({ effect(fn) { const dispose = fn(); if (dispose) disposers.push(dispose) }, webServer: {
      register(route) { if (route.path === '/dsh-builtin-browser/settings') handler = route.handler; return () => {} },
    } }) },
  }
  t.after(() => {
    for (const dispose of disposers.reverse()) dispose()
    for (const host of registered) host.dispose?.()
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
    if (oldChrome === undefined) delete process.env.DSH_BROWSER_CHROME_PATH; else process.env.DSH_BROWSER_CHROME_PATH = oldChrome
    rmSync(folder, { recursive: true, force: true })
  })
  apply(ctx, { viewHost })
  return {
    get current() { return current }, registered, warnings,
    openPanel: () => panelFactory?.(),
    async choose(nextChannel, systemProfile) {
      const request = Readable.from([JSON.stringify({ browser: { channel: nextChannel, ...systemProfile ? { systemProfile } : {} } })])
      request.method = 'PUT'
      request.headers = { host: 'localhost:3000', origin: 'http://localhost:3000' }
      let response
      await handler(request, { writeHead() {}, end(text) { response = JSON.parse(text) } })
      assert.equal(response.ok, true)
      return response
    },
  }
}
