import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EventEmitter, once } from 'node:events'
import vm from 'node:vm'
import { loadSettingsPanel } from '../src/client/settings/panel.ts'

const directory = mkdtempSync(join(tmpdir(), 'sidebar-rendering-'))
after(() => rmSync(directory, { recursive: true, force: true }))
const application = new EventEmitter()
const contents = []
globalThis.__electronStub__ = { app: application, webContents: { getAllWebContents: () => contents, fromId: id => contents.find(item => item.id === id) } }
const source = readFileSync(new URL('../desktop-bridge/plugin-browser-bridge.js', import.meta.url), 'utf8')
  .replace(/import \{([^}]+)\} from ['"]electron['"]/, 'const {$1} = globalThis.__electronStub__') + '\nexport { handle, claims };\n'
writeFileSync(join(directory, 'bridge.mjs'), source)
writeFileSync(join(directory, 'bridge-copy.mjs'), source)
writeFileSync(join(directory, 'guest-proxy.mjs'), readFileSync(new URL('../desktop-bridge/guest-proxy.mjs', import.meta.url)))
const bridge = await import(pathToFileURL(join(directory, 'bridge.mjs')))

function mount(t, { supported = true, selected = 'session-reader' } = {}) {
  t.mock.method(globalThis, 'setInterval', () => 0)
  const cleanups = []
  const held = new Set()
  const switched = []
  const tabs = []
  let released = 0
  const effect = run => { const cleanup = run(); if (typeof cleanup === 'function') cleanups.push(cleanup) }
  const sidebarRight = {
    screen: () => ({ sessionId: selected }),
    tabsIn: () => tabs,
    openTabIn: () => tabs.push({ id: 'tab-1', kind: 'browser' }),
    ...(supported ? { holdRendering: sessionId => {
      const entry = { sessionId }; held.add(entry)
      return () => { assert.equal(held.delete(entry), true); released++ }
    } } : {}),
  }
  const uiWorkspace = { openSession: sessionId => switched.push(sessionId) }
  loadSettingsPanel(() => ({})).apply({
    effect,
    locale: { register: () => {}, bind: () => key => key },
    slots: { inject: (_name, run) => run(), register: () => {} },
    inject: (names, callback) => {
      const scope = { sidebarRight, uiWorkspace, effect }
      if (names.some(name => scope[name] !== undefined)) callback(scope)
    },
  })
  const api = globalThis.__dshBuiltinBrowser
  t.after(() => { for (const cleanup of cleanups.reverse()) cleanup(); delete globalThis.document; delete globalThis.requestAnimationFrame })
  globalThis.requestAnimationFrame = callback => setImmediate(callback)
  globalThis.document = {
    querySelector: () => null,
    querySelectorAll: selector => selector === '[data-sidebar-right-background-rendering]'
      ? [...held].map(entry => ({ getAttribute: name => name === 'data-sidebar-right-session' ? entry.sessionId : null })) : [],
  }
  const shell = { id: 1, getType: () => 'window', isDestroyed: () => false,
    executeJavaScript: async expression => vm.runInThisContext(expression) }
  contents.splice(0, contents.length, shell)
  bridge.claims.clear()
  return { api, held, switched, cleanups, released: () => released }
}

test('background holds do not change selection, and release is idempotent and runs at disposal', t => {
  const state = mount(t)
  assert.equal(state.api.holdRendering('session-agent', 'one'), true)
  assert.equal(state.api.holdRendering('session-agent', 'two'), true)
  assert.equal(state.api.isBackgroundRendering('session-agent'), true)
  assert.equal(state.api.isBackgroundRendering('session-other'), false)
  state.api.openPanel('session-agent', 'https://example.com/')
  assert.deepEqual(state.switched, [])
  state.api.releaseRendering('one'); state.api.releaseRendering('one')
  assert.equal(state.held.size, 1)
  for (const cleanup of state.cleanups.splice(0).reverse()) cleanup()
  assert.equal(state.held.size, 0)
  assert.equal(state.released(), 2)
})

test('selected sessions and older sidebar services do not acquire a hold', t => {
  const state = mount(t, { supported: false })
  assert.equal(state.api.holdRendering('session-agent', 'one'), false)
  assert.equal(state.api.holdRendering('', 'two'), false)
  state.api.openPanel('session-agent', 'https://example.com/')
  assert.deepEqual(state.switched, ['session-agent'], 'legacy selection fallback is preserved')
  assert.equal(state.held.size, 0)
})

test('a CDP operation holds the background page until success or rejection, but never the selected page', async t => {
  const state = mount(t)
  let fail = false
  const guest = { id: 2, getType: () => 'webview', isDestroyed: () => false, debugger: {
    isAttached: () => true,
    sendCommand: async () => { assert.equal(state.held.size, 1); if (fail) throw new Error('CDP failed'); return { data: 'frame' } },
  } }
  contents.push(guest)
  state.api.panelGuests = () => [2]
  const request = { op: 'cdp', owner: 'session-agent', id: 2, method: 'Page.captureScreenshot' }
  assert.deepEqual((await bridge.handle(request)).result, { data: 'frame' })
  assert.equal(state.held.size, 0)
  fail = true
  await assert.rejects(bridge.handle(request), /CDP failed/)
  assert.equal(state.held.size, 0)
  assert.equal(state.released(), 2)
  assert.equal(state.api.holdRendering('session-reader', 'selected'), false)
})

test('held DOM backgrounds are accepted, while the unheld panel-not-displayed fallback remains', async t => {
  const state = mount(t)
  contents.push({ id: 2, getType: () => 'webview', isDestroyed: () => false })
  state.api.openPanel = () => ({ ok: true, panel: true, displayed: false, guestId: 2, url: '' })
  assert.equal((await bridge.handle({ op: 'ensureSidebar', owner: 'session-agent' })).id, 2)
  assert.equal(state.held.size, 0)
  state.api.holdRendering = () => false
  await assert.rejects(bridge.handle({ op: 'ensureSidebar', owner: 'session-agent' }), { code: 'panel-not-displayed' })
})

test('extension and legacy imports share one listener and honor the supplied DSH home', async () => {
  contents.splice(0)
  const copy = await import(pathToFileURL(join(directory, 'bridge-copy.mjs')))
  const server = bridge.start({ app: application, dshHome: directory })
  try {
    assert.equal(copy.start(), server)
    assert.equal(application.listenerCount('web-contents-created'), 1)
    assert.equal(application.listenerCount('will-quit'), 1)
    await once(server, 'listening')
    assert.equal(JSON.parse(readFileSync(join(directory, 'dsh-builtin-browser-bridge.json'), 'utf8')).pid, process.pid)
  } finally { bridge.stop() }
})
