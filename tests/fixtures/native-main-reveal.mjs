import assert from 'node:assert/strict'
import { EventEmitter, once } from 'node:events'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import { BrowserRuntime } from '../../lib/browser/runtime.js'
import { DesktopBridgeViewHost } from '../../lib/browser-electron/desktop-bridge-host.js'
import { ElectronBrowserProvider } from '../../lib/browser-electron/provider.js'
import { createReferenceRouteHandlers } from '../../lib/browser-electron/reference-route.js'
import { createReferenceService } from '../../lib/browser-reference/service.js'
import { ReferenceStore, manifestHashOf } from '../../lib/browser-reference/store.js'

export async function nativeMainReveal(snapshot, live, guestId = 2, evaluate) {
  const folder = mkdtempSync(join(process.cwd(), '.native-main-reveal-'))
  const home = join(folder, 'home')
  mkdirSync(home)
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const ctx = new Context()
  new BrowserRuntime(ctx)
  ctx.browser.registerBrowserProvider({ id: 'default', available: () => true, exists: () => false })
  const providers = [], hosts = [], commands = [], posts = [], outcomes = []
  const owner = `session-${snapshot.owner.sessionId}`
  const selected = snapshot.parts[0]?.anchor
  const pageText = selected === undefined ? '' : selected.prefix + selected.exact + selected.suffix
  const app = new EventEmitter()
  const shell = new EventEmitter()
  Object.assign(shell, {
    id: 1, getType: () => 'window', getURL: () => 'dsh-app://app', getTitle: () => 'DSH',
    isDestroyed: () => false,
    executeJavaScript: async source => runInNewContext(source, {
      document: { querySelector: () => ({ getAttribute: () => 'webview' }) },
      __dshBuiltinBrowser: { panelGuests: task => task === owner ? [guestId] : [] },
    }),
  })
  const guest = new EventEmitter()
  Object.assign(guest, {
    id: guestId, getType: () => 'webview', getURL: () => live.url, getTitle: () => 'Source',
    isDestroyed: () => false, setWindowOpenHandler() {},
    debugger: {
      isAttached: () => true, detach() {},
      async sendCommand(method, params) {
        commands.push({ method, params })
        assert.equal(method, 'Runtime.evaluate', 'binding must not navigate or replace the visible guest')
        assert.equal(live.ready, true, 'the client must await the current document')
        if (evaluate !== undefined) return evaluate(method, params)
        const expression = params.expression
        let value
        if (expression.includes('return JSON.stringify(highlightText(spec))')) {
          live.highlighted = true
          value = { ok: true, rects: 1, scrolled: true }
        } else if (expression.includes('text: map.text, truncated: map.truncated')) value = { ok: true, text: pageText }
        else value = { ok: true, url: live.url }
        return { result: { value: JSON.stringify(value) } }
      },
    },
  })
  const webContents = { getAllWebContents: () => [shell, guest] }
  ctx.browser.registerPanelProvider(async () => {
    const host = await DesktopBridgeViewHost.discover(owner)
    if (host === undefined) return undefined
    hosts.push(host)
    const provider = new ElectronBrowserProvider(host)
    providers.push(provider)
    return provider
  })
  const store = new ReferenceStore(join(home, 'references.jsonl'))
  if (snapshot.referenceId !== undefined) store.append({ ...snapshot, manifestHash: manifestHashOf(snapshot) })
  const service = createReferenceService(ctx.browser, {
    store, assetDir: join(home, 'assets'),
    sourceSession: (task, page) => ctx.browser.bindPanelPage(`session-${task}`, page),
  })
  const routes = createReferenceRouteHandlers({ service })
  let stop
  return {
    commands, posts, outcomes, home, app,
    get: referenceId => store.get(referenceId),
    async post(body, capture = false) {
      posts.push(body)
      const request = Readable.from([JSON.stringify(body)])
      request.method = 'POST'
      request.headers = { host: 'localhost:3180', origin: 'http://localhost:3180' }
      request.socket = { remoteAddress: '127.0.0.1' }
      let outcome
      await (capture ? routes.capture : routes.reveal)(request, {
        writeHead(status) { assert.equal(status, 200) },
        end(json) { outcome = JSON.parse(json); outcomes.push(outcome) },
      })
      return outcome
    },
    async start() {
      const manifest = JSON.parse(readFileSync('package.json', 'utf8'))
      assert.equal(manifest.dsh.desktop?.main, './desktop-bridge/main.mjs')
      assert.ok(manifest.files.includes('desktop-bridge'))
      const entry = join(folder, manifest.dsh.desktop.main)
      mkdirSync(dirname(entry), { recursive: true })
      writeFileSync(join(folder, 'package.json'), '{"type":"module"}')
      writeFileSync(entry, readFileSync(manifest.dsh.desktop.main))
      let bridge = readFileSync('desktop-bridge/plugin-browser-bridge.js', 'utf8')
      bridge = bridge.replace(/import \{([^}]+)\} from ['"]electron['"]/, 'const {$1} = globalThis.__nativeMainElectron')
      writeFileSync(join(dirname(entry), 'plugin-browser-bridge.js'), bridge)
      writeFileSync(join(dirname(entry), 'guest-proxy.mjs'), readFileSync('desktop-bridge/guest-proxy.mjs'))
      writeFileSync(join(dirname(entry), 'native-guests.mjs'), readFileSync('desktop-bridge/native-guests.mjs'))
      globalThis.__nativeMainElectron = { app, webContents }
      const extension = await import(pathToFileURL(entry).href)
      // Main's supplied home is authoritative even when its environment differs from Host's.
      process.env.DSH_HOME = join(folder, 'wrong-home')
      try {
        stop = extension.start({ app, webContents, mainWindow: () => ({ webContents: shell }), dshHome: home })
        const server = globalThis[Symbol.for('dsh-builtin-browser.bridge.active')].server
        await once(server, 'listening')
      } finally {
        process.env.DSH_HOME = home
        delete globalThis.__nativeMainElectron
      }
      assert.ok(readFileSync(join(home, 'dsh-builtin-browser-bridge.json'), 'utf8'))
    },
    async close() {
      for (const provider of providers) provider.dispose()
      for (const host of hosts) host.dispose()
      await ctx.fiber.dispose()
      stop?.()
      if (oldHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = oldHome
      rmSync(folder, { recursive: true, force: true })
    },
  }
}
