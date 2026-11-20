import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NativeViewPage } from '../src/client/electron/NativeViewPage.ts'
import { nativeGuestRegistry } from '../desktop-bridge/native-guests.mjs'

const flush = () => new Promise(resolve => setImmediate(resolve))
const target = { kind: 'https', url: 'https://example.test/', title: 'example.test' }

function fixture({ acquire, attach, register, command, capture } = {}) {
  const calls = [], released = [], listeners = new Map()
  let sequence = 0
  const native = { protocolVersion: 1,
    acquire: acquire ?? (async () => ({ lease: 'lease-' + ++sequence })),
    attach: attach ?? (async lease => { listeners.get(lease)?.({ stage: 'attached', generation: 'initial' }) }),
    onState: (lease, listener) => { listeners.set(lease, listener); return () => listeners.delete(lease) },
    release: async lease => { released.push(lease) },
    command: command ?? (async (lease, method, params) => {
      calls.push({ lease, method, params })
      if (method === 'Runtime.evaluate') return { result: { value: { url: target.url, title: 'Native page' } } }
      if (method === 'Page.getNavigationHistory') return { currentIndex: 0, entries: [{ id: 1 }] }
      return {}
    }),
  }
  const registrations = []
  const page = new NativeViewPage({ tabId: 'tab-native', initial: undefined, persist() {}, openRequested() {} }, native,
    register ?? (async (...args) => { registrations.push(args); return 'slot' }), async () => 'workspace', 'session-native', capture)
  return { page, native, calls, released, listeners, registrations }
}

test('native presentation creates no webview and waits for attachment and committed frame/loader acknowledgement', async () => {
  const previous = globalThis.document
  globalThis.document = { getElementById: () => ({ dataset: {} }), createElement() { throw new Error('No DOM guest allowed') } }
  const f = fixture()
  try {
    f.page.loadUrl(target, 'transaction')
    await flush()
    assert.equal(f.calls.length, 0)
    const detach = f.page.mount('viewport')
    await flush()
    assert.deepEqual(f.calls.map(call => call.method), ['Page.navigate'])
    assert.equal(f.page.lifecycle.getSnapshot().stage, 'guest')
    assert.equal(f.page.getSnapshot().documentReady, false)
    assert.equal(f.registrations[0][1], 'dsh-tab:v1:' + encodeURIComponent(JSON.stringify(['session-native', 'sidebar', 'tab-native'])))
    f.listeners.get('lease-1')({ stage: 'document', generation: 'committed' })
    await flush()
    assert.equal(f.page.lifecycle.getSnapshot().stage, 'guest')
    f.listeners.get('lease-1')({ stage: 'document', generation: 'committed', frameId: 'frame', loaderId: 'loader' })
    await flush()
    assert.deepEqual(f.page.lifecycle.getSnapshot(), { stage: 'ready', guestId: 'lease-1', generation: 'committed', frameId: 'frame', loaderId: 'loader' })
    assert.equal(f.page.getSnapshot().navigationId, 'transaction')
    assert.equal(f.page.getSnapshot().documentReady, true)
    detach()
    f.page.mount('remount')
    await flush()
    assert.deepEqual(f.released, ['lease-1'])
    await f.page.dispose()
    await f.page.dispose()
    assert.deepEqual(f.released, ['lease-1', 'lease-2'])
  } finally { await f.page.dispose(); globalThis.document = previous }
})

test('empty native pages own no lease; attachment errors and late acquire cancellation release without carrier substitution', async () => {
  const previous = globalThis.document
  globalThis.document = { getElementById: () => ({ dataset: {} }) }
  try {
    const empty = fixture()
    empty.page.mount('empty'); await flush(); await empty.page.dispose()
    assert.equal(empty.registrations.length, 0)
    let resolveAcquire
    const f = fixture({ acquire: () => new Promise(resolve => { resolveAcquire = resolve }) })
    f.page.loadUrl(target); const detach = f.page.mount('pending'); await flush()
    detach(); resolveAcquire({ lease: 'late' }); await f.page.dispose()
    assert.deepEqual(f.released, ['late'])
    assert.equal(f.calls.length, 0)
    const broken = fixture({ attach: async () => { throw new Error('BROWSER_SLOT_UNAVAILABLE') } })
    broken.page.loadUrl(target); broken.page.mount('broken'); await flush()
    assert.equal(broken.page.lifecycle.getSnapshot().stage, 'failed')
    assert.deepEqual(broken.released, ['lease-1'])
    assert.equal(broken.calls.length, 0)
    await broken.page.dispose()
  } finally { globalThis.document = previous }
})

for (const retry of ['reload', 'navigate']) test(`native load failure recovers through ${retry} without remounting`, async () => {
  const previous = globalThis.document
  globalThis.document = { getElementById: () => ({ dataset: {} }) }
  const f = fixture()
  try {
    f.page.loadUrl(target); const detach = f.page.mount('viewport'); await flush()
    f.listeners.get('lease-1')({ stage: 'failed', generation: 'failed', code: 'BROWSER_GUEST_CLOSED' })
    assert.equal(f.page.getSnapshot().error.code, 'BROWSER_GUEST_CLOSED')
    assert.deepEqual(f.released, ['lease-1'])
    const next = { ...target, url: 'https://example.test/recovered' }
    if (retry === 'reload') f.page.reload()
    else f.page.loadUrl(next)
    await flush()
    assert.equal(f.registrations.length, 2)
    assert.deepEqual(f.calls.at(-1), { lease: 'lease-2', method: 'Page.navigate', params: { url: retry === 'reload' ? target.url : next.url } })
    f.listeners.get('lease-2')({ stage: 'document', generation: 'recovered', frameId: 'frame', loaderId: 'loader' }); await flush()
    assert.equal(f.page.getSnapshot().documentReady, true)
    assert.equal(f.page.getSnapshot().error, undefined)
    detach(); await f.page.dispose()
    assert.deepEqual(f.released, ['lease-1', 'lease-2'])
  } finally { await f.page.dispose(); globalThis.document = previous }
})

test('native document overlays drain captured references to their Session and stop on navigation or disposal', async () => {
  const previous = globalThis.document
  globalThis.document = { getElementById: () => ({ dataset: {} }) }
  const captures = [], scripts = []
  let intents = [{ entry: 'page-overlay', text: 'native selection' }]
  const f = fixture({ capture: async (...args) => { captures.push(args) }, command: async (_lease, method, params) => {
    if (method === 'Page.getNavigationHistory') return { currentIndex: 0, entries: [{}] }
    if (method !== 'Runtime.evaluate') return {}
    scripts.push(params.expression)
    if (params.expression === '({url:location.href,title:document.title})') return { result: { value: { url: target.url } } }
    if (params.expression.includes('var intents = []')) {
      const value = JSON.stringify(intents); intents = []
      return { result: { value } }
    }
    return { result: { value: undefined } }
  } })
  try {
    f.page.loadUrl(target); f.page.mount('viewport'); await flush()
    assert.equal(scripts.length, 0)
    const committed = { stage: 'document', generation: 'one', frameId: 'frame', loaderId: 'loader' }
    f.listeners.get('lease-1')(committed); await flush()
    assert.deepEqual(captures, [[{ entry: 'page-overlay', text: 'native selection' }, 'session-native']])
    assert.ok(scripts.some(source => source.includes('引用到 DSH')))
    f.page.loadUrl(target)
    const count = scripts.length
    await new Promise(resolve => setTimeout(resolve, 330))
    assert.equal(scripts.length, count)
    f.listeners.get('lease-1')({ ...committed, generation: 'two' }); await flush()
    assert.equal(captures.length, 1)
    await f.page.dispose()
    const disposed = scripts.length
    await new Promise(resolve => setTimeout(resolve, 330))
    assert.equal(scripts.length, disposed)
  } finally { await f.page.dispose(); globalThis.document = previous }
})

test('same-document native acknowledgements refresh fragment and History API addresses, history controls and reference polling', async () => {
  const previous = globalThis.document
  globalThis.document = { getElementById: () => ({ dataset: {} }) }
  let url = target.url, currentIndex = 0, installations = 0
  const f = fixture({ capture: async () => {}, command: async (_lease, method, params) => {
    if (method === 'Page.getNavigationHistory') return { currentIndex, entries: [{}, {}, {}] }
    if (method !== 'Runtime.evaluate') return {}
    if (params.expression === '({url:location.href,title:document.title})') return { result: { value: { url } } }
    if (!params.expression.includes('var intents = []')) installations++
    return { result: { value: '[]' } }
  } })
  try {
    f.page.loadUrl(target); f.page.mount('viewport'); await flush()
    const document = { stage: 'document', generation: 'same', frameId: 'frame', loaderId: 'loader' }
    f.listeners.get('lease-1')(document); await flush()
    url += '#fragment'; currentIndex = 1
    f.page.loadUrl({ ...target, url })
    assert.equal(f.page.getSnapshot().loading, true)
    f.listeners.get('lease-1')(document); await flush()
    assert.equal(f.page.getSnapshot().target.url, url)
    assert.equal(f.page.getSnapshot().loading, false)
    assert.equal(f.page.getSnapshot().canGoBack, true)
    assert.equal(f.page.getSnapshot().canGoForward, true)
    url = 'https://example.test/history-state'; currentIndex = 2
    f.listeners.get('lease-1')(document); await flush()
    assert.equal(f.page.getSnapshot().target.url, url)
    assert.equal(f.page.getSnapshot().documentReady, true)
    assert.equal(f.page.getSnapshot().canGoForward, false)
    assert.equal(f.page.lifecycle.getSnapshot().generation, 'same')
    assert.equal(installations, 3)
  } finally { await f.page.dispose(); globalThis.document = previous }
})

test('trusted native transport dispatches only scoped capabilities and revokes cached leases', async () => {
  const scope = 'dsh-tab:v1:' + encodeURIComponent(JSON.stringify(['session-native', 'sidebar', 'tab-native']))
  let entries = [{ scope, lease: 'opaque', state: { stage: 'document', generation: 'g', frameId: 'f', loaderId: 'l' }, url: target.url, title: 'Native' }]
  const calls = []
  const capability = { snapshot: () => entries, command: async (...args) => { calls.push(args); return {} },
    release: async (...args) => { calls.push(args); entries = [] } }
  const registry = nativeGuestRegistry(() => capability)
  assert.deepEqual(registry.ids('foreign'), [])
  assert.deepEqual(registry.ids('session-native'), ['opaque'])
  const guest = registry.get('opaque')
  assert.equal(registry.get('opaque'), guest)
  assert.equal(guest.getType(), 'native')
  await guest.debugger.sendCommand('Page.getFrameTree', {})
  assert.deepEqual(calls[0], [scope, 'opaque', 'Page.getFrameTree', {}])
  await registry.releaseAll()
  assert.equal(registry.get('opaque'), undefined)
  assert.equal(guest.isDestroyed(), true)
  assert.equal(registry.get(42), undefined)
})
