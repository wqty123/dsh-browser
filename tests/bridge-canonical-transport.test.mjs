import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EventEmitter, once } from 'node:events'
import { runInNewContext } from 'node:vm'
import { Context } from '@deepseek-ai/cordis'
import { BrowserRuntime } from '../lib/browser/runtime.js'
import { ElectronBrowserProvider } from '../lib/browser-electron/provider.js'
import { DesktopBridgeViewHost } from '../lib/browser-electron/desktop-bridge-host.js'
import { BridgeConnection } from '../lib/browser-electron/bridge-connection.js'
import { DEFAULT_SETTINGS } from '../lib/browser-electron/settings-store.js'
import { apply } from '../lib/tool-browser/index.js'
import { readTabHandle, resolveSessionHandle, tabWireId } from '../lib/browser/handles.js'

test('registered tools retain canonical identity through runtime, provider, host and actual bridge TCP dispatch', { timeout: 15000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'canonical-transport-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = directory
  const guests = new Map(), owners = new Map(), requests = [], commands = [], selections = []
  let refuseClose = false
  const addGuest = (owner, id, url = `https://page${id}.example/`) => {
    const guest = new EventEmitter()
    Object.assign(guest, { id, url, getType: () => 'webview', getURL: () => guest.url, getTitle: () => 'same title',
      isDestroyed: () => guests.get(id) !== guest, setWindowOpenHandler() {},
      debugger: { isAttached: () => true, sendCommand: async (method, params) => {
        commands.push({ id, method, params })
        if (method === 'Page.getNavigationHistory') return { currentIndex: 0, entries: [{ id: 1, url: guest.getURL() }] }
        if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: `frame-${id}`, loaderId: `document-${id}`, url: guest.getURL() } } }
        if (method === 'Page.createIsolatedWorld') return { executionContextId: id }
        if (method === 'Runtime.evaluate') return { result: { value: params.expression === 'document.readyState' ? 'complete'
          : params.expression === 'location.href' ? guest.getURL() : { url: guest.getURL(), title: 'Page', elements: [], truncated: false } } }
        return {}
      } } })
    guests.set(id, guest); owners.set(id, owner)
    return guest
  }
  const api = {
    panelProtocol: 5,
    panelGuests: owner => [...guests.keys()].filter(id => owners.get(id) === owner),
    initializePanel: async (owner, url, target) => {
      assert.equal(typeof target.viewId, 'string')
      const identity = readTabHandle(target.viewId)
      assert.equal(identity.owner, owner)
      const id = target.guestId ?? api.panelGuests(owner)[0]
      if (!api.panelGuests(owner).includes(id)) return { ok: false, reason: 'foreign guest' }
      if (url !== '') guests.get(id).url = url
      selections.push(id)
      return { ok: true, created: false, guestId: id, rendererNavigation: url !== '',
        initialization: { stage: 'attached', guestId: String(id) } }
    },
    closePanelGuest: (owner, id) => {
      if (refuseClose || owners.get(id) !== owner) return { ok: false, reason: 'fixture close refused' }
      guests.delete(id)
      return { ok: true, closed: 1 }
    },
  }
  const shell = { id: 1, getType: () => 'window', isDestroyed: () => false,
    executeJavaScript: expression => runInNewContext(expression, {
      globalThis: { __dshBuiltinBrowser: api }, document: { querySelector: () => ({ getAttribute: () => 'webview' }) },
    }) }
  globalThis.__canonicalElectron = { app: new EventEmitter(), webContents: {
    getAllWebContents: () => [shell, ...guests.values()], fromId: id => id === 1 ? shell : guests.get(id),
  } }
  const source = readFileSync(new URL('../desktop-bridge/plugin-browser-bridge.js', import.meta.url), 'utf8')
    .replace(/import \{([^}]+)\} from ['"]electron['"]/, 'const {$1} = globalThis.__canonicalElectron')
  writeFileSync(join(directory, 'bridge.mjs'), source)
  writeFileSync(join(directory, 'guest-proxy.mjs'), readFileSync(new URL('../desktop-bridge/guest-proxy.mjs', import.meta.url)))
  writeFileSync(join(directory, 'native-guests.mjs'), readFileSync(new URL('../desktop-bridge/native-guests.mjs', import.meta.url)))
  const bridge = await import(pathToFileURL(join(directory, 'bridge.mjs')))
  const server = bridge.start()
  t.after(() => bridge.stop())
  server.on('connection', socket => {
    let pending = ''
    socket.on('data', chunk => {
      pending += chunk
      let index
      while ((index = pending.indexOf('\n')) >= 0) {
        const request = JSON.parse(pending.slice(0, index)); pending = pending.slice(index + 1)
        if (request.op) requests.push(request)
      }
    })
  })
  await once(server, 'listening')
  const host = await DesktopBridgeViewHost.discover('session-a')
  assert.ok(host)
  const provider = new ElectronBrowserProvider(host, { history: { enabled: false },
    settings: () => ({ ...DEFAULT_SETTINGS, ui: { ...DEFAULT_SETTINGS.ui, closeWithSession: true } }),
  })
  const ctx = new Context()
  const runtime = new BrowserRuntime(ctx)
  runtime.registerBrowserProvider(provider)
  runtime.registerPanelProvider(async () => provider)
  const tools = new Map()
  apply({ tools: { register: tool => tools.set(tool.name, tool) }, systemPrompt: { section() {} }, effect() {},
    get: name => name === 'browser' ? runtime : undefined })
  const run = async (name, args = {}, owner = 'session-a') => JSON.parse(JSON.stringify(await tools.get(`dsh_browser_${name}`).execute(
    JSON.parse(JSON.stringify(args)), { signal: new AbortController().signal, agent: { id: owner } },
  )))
  const endpoint = JSON.parse(readFileSync(join(directory, 'dsh-builtin-browser-bridge.json'), 'utf8'))
  const wire = new BridgeConnection(endpoint)
  t.after(async () => {
    wire.close(); provider.dispose(); host.dispose(); bridge.stop()
    await ctx.fiber.dispose()
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    delete globalThis.__canonicalElectron
    rmSync(directory, { recursive: true, force: true })
  })

  addGuest('session-a', 2, 'about:blank')
  assert.equal((await run('open', { url: 'https://page2.example/' })).url, 'https://page2.example/')
  const initial = await run('list_tabs')
  assert.equal(initial.tabs.length, 1, 'the opened native tab is listed once')
  const session = (await run('session')).session
  assert.deepEqual(await host.listPages(session), [], 'empty native listing travels through real TCP')
  addGuest('session-a', 3); addGuest('session-b', 4, 'about:blank')
  const listed = await run('list_tabs')
  const id = listed.tabs.find(tab => tab.url === 'https://page3.example/').id
  assert.equal(readTabHandle(id).owner, 'session-a')
  assert.deepEqual(await run('switch_tab', { tabId: id }), { switched: true })
  assert.equal(selections.at(-1), 3, 'the real bridge selects the listed native page')
  assert.deepEqual((await run('session')).tabs, (await run('list_tabs')).tabs)
  await run('open', { url: 'https://page4.example/' }, 'session-b')
  await assert.rejects(run('switch_tab', { tabId: id }, 'session-b'), /owner\/session/)
  const bad = ['', '3', 'page:3', 'dsh-tab:v1:%', 'dsh-tab:v1:' + encodeURIComponent(JSON.stringify(Object.values(readTabHandle(id)), null, 1))]
  for (const tabId of bad) {
    await assert.rejects(run('switch_tab', { tabId }), /invalid|noncanonical/)
    assert.equal((await wire.call({ op: 'cdp', handle: tabId, method: 'Runtime.evaluate' })).code, 'BROWSER_HANDLE_INVALID')
  }
  for (const change of [{ owner: 'session-foreign' }, { session: 'foreign-session' }]) {
    const handle = tabWireId({ ...readTabHandle(id), ...change })
    await assert.rejects(run('close_tab', { tabId: handle }), /owner\/session/)
    assert.equal((await wire.call({ op: 'cdp', handle, method: 'Runtime.evaluate' })).code, 'BROWSER_HANDLE_STALE')
  }
  for (const op of ['cdp', 'download', 'showTab', 'closePage']) {
    assert.equal((await wire.call({ op, owner: 'session-a', id: 3 })).code, 'BROWSER_HANDLE_REQUIRED')
  }
  refuseClose = true
  await assert.rejects(run('close_tab', { tabId: id }), /close refused/)
  assert.ok((await run('list_tabs')).tabs.some(tab => tab.id === id))
  refuseClose = false
  assert.deepEqual(await run('close_tab', { tabId: id }), { closed: true })
  assert.equal(guests.has(3), false)
  await assert.rejects(run('close_tab', { tabId: id }), /stale|released/)
  addGuest('session-a', 5)
  const dead = (await run('list_tabs')).tabs.find(tab => tab.url === 'https://page5.example/').id
  guests.delete(5)
  await assert.rejects(run('switch_tab', { tabId: dead }), /stale/)
  assert.equal((await wire.call({ op: 'ensureSidebar', handle: dead })).code, 'BROWSER_HANDLE_STALE')
  refuseClose = true
  await assert.rejects(runtime.close(session), /close refused/)
  assert.equal(runtime.exists(session), false, 'a refused native close still retires the provider session')
  assert.equal(guests.has(2), true, 'close refusal is not reported as a successful native close')
  for (const op of ['ensureSidebar', 'adoptPage', 'cdp', 'closePage']) {
    assert.equal((await wire.call({ op, handle: id })).code, 'BROWSER_HANDLE_STALE')
  }
  assert.equal((await wire.call({ op: 'list', handle: session })).code, 'BROWSER_HANDLE_STALE')
  assert.ok(commands.some(command => command.id === 3 && command.method === 'Runtime.evaluate'))
  assert.ok(commands.some(command => command.id === 2 && command.method === 'Page.getFrameTree'))
  assert.ok(commands.some(command => command.id === 2 && command.method === 'Runtime.evaluate' && command.params.expression === 'document.readyState'))
  assert.ok(requests.some(request => request.op === 'releaseSession' && request.handle === session))
  for (const request of requests.filter(request => !Object.hasOwn(request, 'owner') && !bad.includes(request.handle))) {
    if (request.handle !== undefined) assert.match(request.handle, /^dsh-(?:tab|session):v1:/)
    for (const field of ['id', 'viewId', 'logicalViewId']) assert.equal(Object.hasOwn(request, field), false)
  }
  assert.equal(resolveSessionHandle(session).owner, 'session-a')
  refuseClose = false
  await runtime.close((await run('session', {}, 'session-b')).session)
  assert.equal(guests.has(4), false, 'normal release waits for the native close acknowledgement')
})
