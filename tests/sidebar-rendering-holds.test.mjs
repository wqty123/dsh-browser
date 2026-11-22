import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { EventEmitter, once } from 'node:events'
import { connect } from 'node:net'
import vm from 'node:vm'
import { loadSettingsPanel } from '../src/client/settings/panel.ts'
import { legacyBridgeSnippet } from '../dsh-host-patch/legacy-bridge.mjs'
import { testTab } from './canonical-fixtures.mjs'

const wire = testTab('session-agent', 'v')

const directory = mkdtempSync(join(tmpdir(), 'sidebar-rendering-'))
after(() => rmSync(directory, { recursive: true, force: true }))
const application = new EventEmitter()
const contents = []
globalThis.__electronStub__ = { app: application, webContents: { getAllWebContents: () => contents, fromId: id => contents.find(item => item.id === id) } }
const source = readFileSync(new URL('../desktop-bridge/plugin-browser-bridge.js', import.meta.url), 'utf8')
  .replace(/import \{([^}]+)\} from ['"]electron['"]/, 'const {$1} = globalThis.__electronStub__') + '\nexport { handle, handles, bindGuest };\n'
writeFileSync(join(directory, 'bridge.mjs'), source)
writeFileSync(join(directory, 'bridge-copy.mjs'), source)
writeFileSync(join(directory, 'guest-proxy.mjs'), readFileSync(new URL('../desktop-bridge/guest-proxy.mjs', import.meta.url)))
writeFileSync(join(directory, 'native-guests.mjs'), readFileSync(new URL('../desktop-bridge/native-guests.mjs', import.meta.url)))
const bridge = await import(pathToFileURL(join(directory, 'bridge.mjs')))

function mount(t, { supported = true, selected = 'session-reader', marker = true, reader = { protocolVersion: 1, read() {}, wait() {} } } = {}) {
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
      const scope = { sidebarRight, uiWorkspace, effect, sidebarBrowserInitialization: reader }
      if (names.some(name => scope[name] !== undefined)) callback(scope)
    },
  })
  const api = globalThis.__dshBuiltinBrowser
  t.after(() => { for (const cleanup of cleanups.reverse()) cleanup(); delete globalThis.document; delete globalThis.requestAnimationFrame })
  globalThis.requestAnimationFrame = callback => setImmediate(callback)
  globalThis.document = {
    querySelector: () => null,
    querySelectorAll: selector => marker && selector === '[data-sidebar-right-background-rendering]'
      ? [...held].map(entry => ({ getAttribute: name => name === 'data-sidebar-right-session' ? entry.sessionId : null })) : [],
  }
  const shell = { id: 1, getType: () => 'window', isDestroyed: () => false,
    executeJavaScript: async expression => vm.runInThisContext(expression) }
  contents.splice(0, contents.length, shell)
  bridge.handles.clear()
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

test('rendering holds expire without selection changes and expired acquisitions are refused', async t => {
  const state = mount(t)
  assert.equal(state.api.holdRendering('session-agent', 'expired', Date.now() - 1), false)
  assert.equal(state.api.holdRendering('session-agent', 'bounded', Date.now() + 20), true)
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(state.held.size, 0)
  assert.equal(state.released(), 1)
  state.api.releaseRendering('bounded')
  assert.equal(state.released(), 1)
  assert.deepEqual(state.switched, [])
})

for (const stalledReply of [false, true]) test(`a hung rendering release cannot block the request deadline (reply only=${stalledReply})`, async t => {
  let started
  const waiting = new Promise(resolve => { started = resolve })
  const reader = { protocolVersion: 1, read() {}, wait(_query, signal) {
    started()
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
  } }
  const state = mount(t, { reader })
  const shell = contents[0]
  const execute = shell.executeJavaScript
  shell.executeJavaScript = async expression => {
    if (expression.includes('releaseRendering?.')) {
      if (stalledReply) await execute(expression)
      return new Promise(() => {})
    }
    return execute(expression)
  }
  state.api.openPanel = () => ({ ok: true, created: true, panel: true, guestId: null, tabId: 'tab-1' })
  const controller = new AbortController()
  const began = Date.now()
  const pending = bridge.handle({ op: 'ensureSidebar', handle: wire, transactionId: 'release-hang', deadline: Date.now() + 500 }, controller.signal)
  const rejected = assert.rejects(pending, { code: 'BROWSER_DOCUMENT_TIMEOUT' })
  await waiting
  await rejected
  assert.ok(Date.now() - began < 1000)
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.equal(state.held.size, 0)
  assert.equal(state.released(), 1)
  assert.deepEqual(state.switched, [])
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
  bridge.bindGuest(wire, guest)
  state.api.panelGuests = () => [2]
  const request = { op: 'cdp', handle: wire, method: 'Page.captureScreenshot' }
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
  assert.equal((await bridge.handle({ op: 'ensureSidebar', handle: wire })).id, wire)
  assert.equal(state.held.size, 0)
  state.api.holdRendering = () => false
  await assert.rejects(bridge.handle({ op: 'ensureSidebar', handle: wire }), { code: 'panel-not-displayed' })
})

test('a minimized window dispatches held commands without animation frames', async t => {
  const state = mount(t)
  globalThis.requestAnimationFrame = () => assert.fail('minimized windows do not produce animation frames')
  state.api.openPanel = () => ({ ok: true, panel: true, displayed: false, guestId: 2, url: '' })
  contents.push({ id: 2, getType: () => 'webview', isDestroyed: () => false })
  assert.equal((await bridge.handle({ op: 'ensureSidebar', handle: wire })).id, wire)
  assert.equal(state.held.size, 0)
})

for (const options of [{ marker: false }, { supported: false }]) {
  test(`protocol 5 refuses a background session without ${options.marker === false ? 'a DOM marker' : 'a rendering hold'}`, async t => {
    const state = mount(t, options)
    state.api.openPanel = () => assert.fail('an undisplayed panel must not be initialized')
    await assert.rejects(bridge.handle({ op: 'ensureSidebar', handle: wire }), { code: 'panel-not-displayed' })
    assert.equal(state.held.size, 0)
    assert.deepEqual(state.switched, [])
  })
}

for (const mode of ['deadline', 'cancel', 'socket-abort', 'bridge-dispose', 'client-dispose', 'error']) {
  test(`protocol-5 ${mode} aborts initialization and releases its background hold`, async t => {
    let initialized, cancelled
    const started = new Promise(resolve => { initialized = resolve })
    const reader = { protocolVersion: 1, read() {}, wait(_query, signal) {
      initialized()
      return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => { cancelled = true; reject(signal.reason) }, { once: true })
      })
    } }
    const state = mount(t, { reader })
    state.api.openPanel = () => mode === 'error'
      ? { ok: false, code: 'panel-initialization-failed', reason: 'open failed' }
      : { ok: true, created: true, panel: true, guestId: null, tabId: 'tab-1' }
    const controller = new AbortController()
    const pending = bridge.handle({ op: 'ensureSidebar', handle: wire, transactionId: 'one',
      deadline: Date.now() + (mode === 'deadline' ? 40 : 1000) }, controller.signal)
    const rejected = assert.rejects(pending, mode === 'socket-abort' ? /disconnected/ : mode === 'bridge-dispose' ? /disposed/ :
      mode === 'deadline' ? { code: 'BROWSER_DOCUMENT_TIMEOUT' } : mode === 'cancel' ? { code: 'BROWSER_NAVIGATION_CANCELLED' } : /disposed|open failed/)
    if (mode !== 'error') {
      await started
      assert.equal(state.held.size, 1)
      if (mode === 'cancel') assert.equal((await bridge.handle({ op: 'cancelSidebar', handle: wire, transactionId: 'one' })).cancelled, true)
      if (mode === 'socket-abort') controller.abort(new Error('disconnected'))
      if (mode === 'bridge-dispose') bridge.stop()
      if (mode === 'client-dispose') for (const cleanup of state.cleanups.splice(0).reverse()) cleanup()
    }
    await rejected
    assert.equal(state.held.size, 0)
    assert.equal(state.released(), 1)
    if (mode !== 'error') assert.equal(cancelled, true)
    assert.deepEqual(state.switched, [])
  })
}

test('abandoning a request releases a hold even before its renderer reply, and never dispatches it later', async t => {
  const state = mount(t)
  const shell = contents[0]
  const execute = shell.executeJavaScript
  let resume
  shell.executeJavaScript = async expression => {
    const result = await execute(expression)
    if (expression.includes('api.holdRendering(')) await new Promise(resolve => { resume = resolve })
    return result
  }
  state.api.openPanel = () => assert.fail('an abandoned request must not reach the panel')
  const controller = new AbortController()
  const pending = bridge.handle({ op: 'ensureSidebar', handle: wire }, controller.signal)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state.held.size, 1)
  controller.abort(new Error('client timed out'))
  assert.equal(state.held.size, 0)
  resume()
  await assert.rejects(pending, /client timed out/)
  assert.equal(state.released(), 1)
})

test('a disconnected request does not run after an earlier command drains the guest queue', async t => {
  const state = mount(t)
  let finishFirst
  const commands = []
  contents.push({ id: 2, getType: () => 'webview', isDestroyed: () => false, debugger: {
    isAttached: () => true,
    sendCommand: async method => {
      commands.push(method)
      if (method === 'Runtime.evaluate') await new Promise(resolve => { finishFirst = resolve })
      return {}
    },
  } })
  state.api.panelGuests = () => [2]
  bridge.bindGuest(wire, contents[1])
  const request = { op: 'cdp', handle: wire }
  const first = bridge.handle({ ...request, method: 'Runtime.evaluate' })
  await new Promise(resolve => setImmediate(resolve))
  const controller = new AbortController()
  const queued = bridge.handle({ ...request, method: 'Input.insertText', params: { text: 'late' } }, controller.signal)
  const rejected = assert.rejects(queued, /client timed out/)
  await new Promise(resolve => setImmediate(resolve))
  controller.abort(new Error('client timed out'))
  assert.equal(state.held.size, 1)
  finishFirst()
  await first
  await rejected
  assert.deepEqual(commands, ['Runtime.evaluate'])
  assert.equal(state.held.size, 0)
})

test('closing the transport while a held renderer reply is stalled cancels the request', async t => {
  const state = mount(t)
  const shell = contents[0]
  const execute = shell.executeJavaScript
  let resume
  let acquired, released
  const acquisition = new Promise(resolve => { acquired = resolve })
  const release = new Promise(resolve => { released = resolve })
  shell.executeJavaScript = async expression => {
    const result = await execute(expression)
    if (expression.includes('api.holdRendering(')) {
      acquired()
      await new Promise(resolve => { resume = resolve })
    }
    if (expression.includes('releaseRendering?.')) released()
    return result
  }
  state.api.openPanel = () => assert.fail('disconnect must cancel the panel operation')
  const server = bridge.start({ app: application, dshHome: directory })
  t.after(() => bridge.stop())
  await once(server, 'listening')
  const { port, token } = JSON.parse(readFileSync(join(directory, 'dsh-builtin-browser-bridge.json'), 'utf8'))
  const socket = connect(port, '127.0.0.1')
  t.after(() => socket.destroy())
  socket.write(JSON.stringify({ op: 'ensureSidebar', handle: wire, token }) + '\n')
  await acquisition
  assert.equal(state.held.size, 1)
  socket.destroy()
  await release
  assert.equal(state.held.size, 0)
  resume()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(state.released(), 1)
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

test('a legacy file-change reload replaces the listener and invokes the old module cleanup', async () => {
  const copy = await import(pathToFileURL(join(directory, 'bridge-copy.mjs')))
  contents.splice(0)
  const first = bridge.start({ app: application, dshHome: directory })
  await once(first, 'listening')
  let cleaned = false
  const active = globalThis[Symbol.for('dsh-builtin-browser.bridge.active')]
  const stop = active.stop
  active.stop = () => { cleaned = true; stop() }
  const second = copy.start({ app: application, dshHome: directory, reload: true })
  try {
    assert.notEqual(second, first)
    assert.equal(cleaned, true)
    assert.equal(first.listening, false)
    assert.equal(application.listenerCount('web-contents-created'), 1)
    assert.equal(application.listenerCount('will-quit'), 1)
    await once(second, 'listening')
    assert.equal(bridge.start(), second, 'an ordinary second startup still deduplicates after reload')
    const source = readFileSync(new URL('../desktop-bridge/install.mjs', import.meta.url), 'utf8')
    assert.ok(source.includes('legacyBridgeSnippet as SNIPPET'))
    assert.ok(legacyBridgeSnippet.includes('bridge.start({ reload: why === "file changed" })'))
  } finally { copy.stop() }
})
