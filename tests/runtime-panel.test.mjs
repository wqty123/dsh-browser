import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BrowserRuntime } from '../lib/browser/runtime.js'

// Exercise the real registry/dispatch without starting Cordis or a carrier process.
function runtimeWith(provider) {
  const runtime = Object.create(BrowserRuntime.prototype)
  runtime.providers = new Map(provider === undefined ? [] : [[provider.id, provider]])
  runtime.panelSessions = new Map()
  Object.defineProperty(runtime, 'ctx', { value: { effect: effect => {
    const cleanup = effect()
    return () => cleanup()
  } } })
  return runtime
}

function provider(id, calls) {
  return new Proxy({ id, available: () => true, open: async label => {
    calls.push([id, 'open', label])
    return 'browser:' + id
  } }, { get: (target, name) => name === 'then' ? undefined : name in target ? target[name] : (session, ...args) => {
    calls.push([id, name, session, ...args])
    return name === 'exists' ? true : id
  } })
}

test('all session operations dispatch to the panel provider even when the default carrier changes', async () => {
  const calls = []
  const builtin = provider('builtin', calls)
  const sidebar = provider('sidebar', calls)
  const runtime = runtimeWith(builtin)
  runtime.registerPanelProvider(async label => {
    assert.equal(label, 'task-1')
    return sidebar
  })
  const session = await runtime.openPanel('task-1')
  assert.equal(session, 'browser:sidebar')
  runtime.providers = new Map([['replacement', provider('replacement', calls)]])
  for (const method of [
    'openUrl', 'listTabs', 'switchTab', 'closeTab', 'reset', 'navigate', 'execute', 'pageOperation',
    'waitFor', 'snapshot', 'a11y', 'reload', 'content', 'click', 'clickSequence', 'type', 'scroll',
    'back', 'forward', 'key', 'fillForm', 'setValue', 'check', 'selectOption', 'clearField',
    'getValue', 'scrape', 'screenshot', 'capturePassive', 'detectChallenge', 'history',
    'exists', 'replay', 'download', 'flushAuth', 'restoreAuth',
  ]) {
    const before = calls.length
    await runtime[method](session, {})
    assert.equal(calls.length, before + 1, method)
    assert.deepEqual(calls.at(-1).slice(0, 3), ['sidebar', method, session], method)
  }
  await runtime.close(session)
  assert.deepEqual(calls.at(-1).slice(0, 3), ['sidebar', 'close', session])
  assert.equal(runtime.panelSessions.size, 0)
  assert.equal(await runtime.open('task-1'), 'browser:replacement')
})

test('no panel provider or unsupported Web panel never falls back to the default provider', async () => {
  const calls = []
  const runtime = runtimeWith(provider('builtin', calls))
  assert.equal(await runtime.openPanel('task-1'), undefined)
  runtime.registerPanelProvider(async () => undefined)
  assert.equal(await runtime.openPanel('task-1'), undefined)
  assert.deepEqual(calls, [])
})

test('a panel session does not require any default provider', async () => {
  const calls = []
  const runtime = runtimeWith()
  runtime.registerPanelProvider(async () => provider('sidebar', calls))
  const session = await runtime.openPanel('task')
  assert.equal(await runtime.a11y(session, {}), 'sidebar')
  assert.throws(() => runtime.exists('unknown-session'), /no browser provider/)
})

test('panel provider discovery errors propagate without trying a default carrier', async () => {
  const calls = []
  const runtime = runtimeWith(provider('builtin', calls))
  runtime.registerPanelProvider(async () => { throw new Error('bridge refused') })
  await assert.rejects(runtime.openPanel('task'), /bridge refused/)
  assert.deepEqual(calls, [])
})

test('disposing panel registration removes its sessions and opener', async () => {
  const runtime = runtimeWith()
  const dispose = runtime.registerPanelProvider(async () => provider('sidebar', []))
  await runtime.openPanel('task')
  assert.equal(runtime.panelSessions.size, 1)
  dispose()
  assert.equal(runtime.panelSessions.size, 0)
  assert.equal(await runtime.openPanel('task'), undefined)
})

test('an open racing disposal closes the new session and rejects rather than leaking it', async () => {
  const calls = []
  const sidebar = provider('sidebar', calls)
  let ready
  let started
  const opening = new Promise(resolve => { ready = resolve })
  const reached = new Promise(resolve => { started = resolve })
  sidebar.open = async () => { started(); return opening }
  const runtime = runtimeWith()
  const dispose = runtime.registerPanelProvider(async () => sidebar)
  const pending = runtime.openPanel('task')
  await reached
  dispose()
  ready('browser:sidebar')
  await assert.rejects(pending, /disposed during open/)
  assert.deepEqual(calls, [['sidebar', 'close', 'browser:sidebar']])
  assert.equal(runtime.panelSessions.size, 0)
})

for (const channel of ['chrome', 'edge']) {
  test(`the viewer includes sidebar sessions independently of selected ${channel}`, async () => {
    const external = { id: channel, available: () => true, capturePassive() {}, watchableSessions: () => ['external', 'sidebar'] }
    const sidebar = { id: 'sidebar', open: async () => 'sidebar', capturePassive() {}, exists: () => true, close: async () => {} }
    const runtime = runtimeWith(external)
    runtime.providerId = channel
    runtime.registerPanelProvider(async () => sidebar)
    await runtime.openPanel('task')
    assert.deepEqual(runtime.watchableSessions(), ['sidebar', 'external'])
    assert.equal(new Set(runtime.watchableSessions()).size, 2, 'sessions exposed by both providers are deduplicated')
    external.capturePassive = undefined
    assert.deepEqual(runtime.watchableSessions(), ['sidebar'])
    external.available = () => false
    assert.deepEqual(runtime.watchableSessions(), ['sidebar'], 'an unavailable selected carrier cannot hide a live panel')
    sidebar.exists = () => false
    assert.deepEqual(runtime.watchableSessions(), [], 'retired shell sessions are not advertised')
  })
}

test('viewer enumeration handles panel-only, closed and non-preview sessions', async () => {
  const runtime = runtimeWith()
  assert.deepEqual(runtime.watchableSessions(), [])
  const sidebar = { id: 'sidebar', open: async () => 'sidebar', capturePassive() {}, close: async () => {} }
  runtime.registerPanelProvider(async () => sidebar)
  const session = await runtime.openPanel('task')
  assert.deepEqual(runtime.watchableSessions(), [session])
  sidebar.capturePassive = undefined
  assert.deepEqual(runtime.watchableSessions(), [])
  sidebar.capturePassive = () => {}
  await runtime.close(session)
  assert.deepEqual(runtime.watchableSessions(), [])
})
