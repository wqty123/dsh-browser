// The settings panel, actually executed.
//
// The bundle is a ModuleLoader entry that reaches for `react`, `ctx.slots` and `ctx.locale`
// and then renders a tree of elements. Nothing in the suite touched it before: the panel could
// throw on render, drop a section, or send the wrong patch, and every test stayed green — and a
// panel that silently loses a section is exactly how three dead settings shipped once.
//
// So this loads the real bundle in a VM, hands it a minimal host, renders the registered
// component, and checks the switches it produces and the patch it sends when one is flipped.
// What it does NOT verify is the host's own integration (real React, the real slot registry);
// that only a running DSH can show, which is stated here so nobody reads more into it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const { DEFAULT_SETTINGS } = await import('../lib/browser-electron/settings-store.js')

const SOURCE = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const ROUTE = '/dsh-builtin-browser/settings'

/**
 * The fetch the bundle sees. It has to live here rather than on `globalThis`: the bundle runs
 * in its own VM realm with its own globals, so patching the host's would have gone unnoticed.
 */
let activeFetch = async () => ({ ok: false, status: 500, json: async () => ({}) })

/**
 * The document the bundle sees while it runs.
 *
 * The conversation panel service reads the shell's sidebar out of the page, so a test that
 * exercises it has to be able to present one. Every access is forwarded rather than captured,
 * because the sandbox is a separate realm and a method captured at load time would go stale the
 * moment a test swaps the document.
 */
/**
 * A document complete enough for the bundle's own page work: the stylesheet step (`getElementById`,
 * `createElement`, `head.appendChild`) and the sidebar lookup the conversation panel service makes.
 * An incomplete one is worse than none — the bundle's `typeof document` guard passes, and the
 * failure then surfaces as a missing method rather than as "no page here".
 */
function makeDocument(overrides = {}) {
  return {
    body: {},
    head: { appendChild: () => {} },
    getElementById: () => null,
    createElement: () => ({}),
    querySelectorAll: () => [],
    ...overrides,
  }
}

let activeDocument = makeDocument()

/**
 * The sandbox the bundle last ran in.
 *
 * A contextified sandbox IS that realm's `globalThis`, so anything the bundle publishes globally
 * (the conversation panel service does) is readable here as a property of this object. Without
 * it the test could not see the API at all: the bundle runs in its own realm on purpose.
 */
let activeSandbox = null

/** Load the bundle the way the host's ModuleLoader does, and return its factory. */
function bundleFactory() {
  let factory
  const sandbox = {
    window: { __ModuleLoader__: { load: (spec) => { factory = spec.factory } } },
    console,
    setTimeout,
    clearTimeout,
    queueMicrotask,
    fetch: (...args) => activeFetch(...args),
    document: {
      get body() { return activeDocument.body },
      get head() { return activeDocument.head },
      getElementById: (id) => activeDocument.getElementById(id),
      createElement: (tag) => activeDocument.createElement(tag),
      querySelectorAll: (selector) => activeDocument.querySelectorAll(selector),
    },
  }
  activeSandbox = sandbox
  vm.runInNewContext(SOURCE, sandbox, { filename: 'client.js' })
  assert.ok(typeof factory === 'function', 'the bundle registered a factory')
  return factory
}

/**
 * A host stub just real enough to render: hooks that keep state across passes, `createElement`
 * that keeps the tree as data, and a fetch that records every call.
 */
function makeHost(settings) {
  const calls = []
  const hooks = []
  const pendingEffects = []
  let cursor = 0
  let dirty = false

  const sameDeps = (a, b) => a !== undefined && b !== undefined
    && a.length === b.length && a.every((value, index) => value === b[index])
  const slotFor = (kind) => {
    const index = cursor++
    if (hooks[index] === undefined) hooks[index] = { kind }
    return hooks[index]
  }

  const react = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat() }),
    useState: (initial) => {
      const entry = slotFor('state')
      if (!('value' in entry)) entry.value = initial
      return [entry.value, (next) => {
        entry.value = typeof next === 'function' ? next(entry.value) : next
        dirty = true
      }]
    },
    // Cached by deps, and that is load-bearing: `useEffect(() => load(), [load])` runs ONCE in
    // React because `useCallback(…, [])` hands back the same reference while its deps hold. A
    // mock returning a fresh closure each pass made the panel fetch its settings once per
    // pass — which is not what the panel does, and would have hidden a real double fetch.
    useCallback: (fn, deps) => {
      const entry = slotFor('callback')
      if (entry.fn !== undefined && sameDeps(entry.deps, deps)) return entry.fn
      entry.fn = fn
      entry.deps = deps
      return fn
    },
    // An effect with no deps list runs after EVERY render, as React specifies.
    useEffect: (effect, deps) => {
      const entry = slotFor('effect')
      const changed = deps === undefined || !sameDeps(entry.deps, deps)
      entry.deps = deps
      if (changed) pendingEffects.push(effect)
    },
  }
  const requireFn = (id) => {
    if (id === 'react') return react
    throw new Error(`the panel required "${id}"`)
  }
  const fetchMock = async (url, init) => {
    calls.push({ url, init })
    return { ok: true, status: 200, json: async () => ({ ok: true, settings, path: '/tmp/settings.json' }) }
  }
  return {
    calls,
    requireFn,
    fetchMock,
    pendingEffects,
    reset: () => { cursor = 0 },
    takeDirty: () => { const value = dirty; dirty = false; return value },
  }
}

/** Render the registered component until a render stops changing state. */
async function renderPanel(Component, host) {
  activeFetch = host.fetchMock
  let tree
  for (let pass = 0; pass < 5; pass += 1) {
    host.reset()
    tree = Component()
    for (const effect of host.pendingEffects.splice(0)) effect()
    await new Promise(resolve => setTimeout(resolve, 0))
    if (!host.takeDirty()) break
  }
  return tree
}

/** Every element in the tree, depth first. */
function elements(node, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) elements(child, found)
    return found
  }
  if (node === null || typeof node !== 'object') return found
  found.push(node)
  elements(node.children, found)
  return found
}

/** Wire the bundle up to a host and render it. */
async function mount(options = {}) {
  const settings = options.settings ?? DEFAULT_SETTINGS
  if (options.document !== undefined) activeDocument = options.document
  const host = makeHost(settings)
  const exports = bundleFactory()(host.requireFn)

  let registration
  const ctx = {
    effect: (fn) => { fn() },
    locale: { register: () => {}, bind: () => (key) => key },
    slots: {
      inject: (_name, fn) => fn(),
      register: (spec, Component) => { registration = { spec, Component } },
    },
    // The panel service waits for `sidebarRight`. A host that never provides one leaves the
    // service unbound and the API names that when called — which is the shape every settings test
    // here runs in, and also what an older composition looks like.
    inject: (_names, fn) => {
      if (options.sidebarRight === undefined) return
      fn({ sidebarRight: options.sidebarRight, effect: (run) => { run() } })
    },
  }
  exports.apply(ctx)
  assert.ok(registration !== undefined, 'apply() registered a settings section')
  assert.equal(registration.spec.name, 'settings.section')

  const tree = await renderPanel(registration.Component, host)
  return { tree, host, exports, registration, panel: activeSandbox.__dshBuiltinBrowser }
}

test('the bundle loads and registers the settings section', async () => {
  const { exports, registration } = await mount()
  assert.equal(exports.name, 'dsh-builtin-browser')
  // Spread it: the bundle's array comes from another realm, and a strict deep compare would
  // fail on the prototype rather than on the contents.
  assert.deepEqual([...exports.inject], ['slots', 'locale'])
  assert.equal(registration.spec.order, 60, 'the panel stays under the host rows')
  assert.equal(registration.spec.locale, 'settings.dsh-builtin-browser')
})

test('the panel asks for the settings document and renders its sections', async () => {
  const { tree, host } = await mount()
  const reads = host.calls.filter(call => (call.init?.method ?? 'GET') === 'GET')
  assert.equal(reads.length, 1, 'it loaded the settings exactly once')
  assert.equal(reads[0].url, ROUTE)
  const keys = elements(tree).map(element => element.props.labelKey ?? element.props.titleKey ?? element.props.key).filter(Boolean)
  for (const section of ['history.title', 'cookies.title', 'ui.title', 'vision.title', 'browser.title', 'actions.title', 'credentials.title']) {
    assert.ok(keys.includes(section), `the panel renders the "${section}" section`)
  }
})

test('the three action switches render, bound to the settings that back them', async () => {
  const { tree } = await mount()
  const toggles = new Map(
    elements(tree)
      .filter(element => element.props.labelKey !== undefined)
      .map(element => [element.props.labelKey, element.props]),
  )
  for (const [labelKey, value] of [
    ['actions.allowExecute', true],
    ['actions.allowDownload', true],
    ['actions.allowCredentialWrite', true],
  ]) {
    const toggle = toggles.get(labelKey)
    assert.ok(toggle !== undefined, `the panel renders "${labelKey}"`)
    assert.equal(toggle.checked, value, `"${labelKey}" shows the stored value`)
    assert.equal(typeof toggle.onChange, 'function', `"${labelKey}" can be flipped`)
  }
})

test('a switch that is off renders as off — the panel shows what the file says', async () => {
  const settings = { ...DEFAULT_SETTINGS, actions: { allowExecute: false, allowDownload: true, allowCredentialWrite: true } }
  const { tree } = await mount({ settings })
  const toggles = new Map(
    elements(tree)
      .filter(element => element.props.labelKey !== undefined)
      .map(element => [element.props.labelKey, element.props]),
  )
  assert.equal(toggles.get('actions.allowExecute').checked, false)
})

test('a document from an older host, with no action section, still renders', async () => {
  // The failure this guards, reproduced exactly: after an update without a restart the client
  // bundle is new while the host is old, so the document it serves has no `actions`. Reading
  // `settings.actions.allowExecute` off that threw, and the throw took the whole panel with it —
  // the section did not show stale values, it refused to open.
  const legacy = { ...DEFAULT_SETTINGS }
  delete legacy.actions
  const { tree } = await mount({ settings: legacy })

  const toggles = new Map(
    elements(tree)
      .filter(element => element.props.labelKey !== undefined)
      .map(element => [element.props.labelKey, element.props]),
  )
  for (const labelKey of ['actions.allowExecute', 'actions.allowDownload', 'actions.allowCredentialWrite']) {
    assert.ok(toggles.has(labelKey), `the panel still renders "${labelKey}"`)
    assert.equal(toggles.get(labelKey).checked, true, `"${labelKey}" falls back to the host's behaviour: on`)
  }
  // And the sections that were always there are unharmed.
  assert.ok(toggles.has('history.enabled'), 'the rest of the panel renders too')
})

test('flipping a switch sends exactly that patch', async () => {
  const { tree, host } = await mount()
  // Element props, not the element: `h(Toggle, {…})` keeps everything on `props`.
  const toggle = elements(tree).find(element => element.props.labelKey === 'actions.allowDownload')?.props
  assert.ok(toggle !== undefined, 'the switch is rendered')

  await toggle.onChange(false)
  const writes = host.calls.filter(call => call.init !== undefined && call.init.method === 'PUT')
  assert.equal(writes.length, 1, 'one write, not a burst')
  assert.equal(writes[0].url, ROUTE)
  assert.deepEqual(JSON.parse(writes[0].init.body), { actions: { allowDownload: false } })
})

// ---------------------------------------------------------------------------
// The conversation panel service.
//
// This is the half that makes a page land in the conversation that ASKED for it. The shell mounts
// one sidebar per conversation and keeps the DSH session id on each, so the panel is found by id
// and nested lookups never leave its subtree. Two things are load-bearing here and both are
// asserted below: it calls `openTabIn` and NEVER the on-screen `openTab`, and it reports a named
// refusal when the conversation has no panel rather than reaching for somebody else's.
// ---------------------------------------------------------------------------

/** A sidebar strip belonging to `sessionId`, carrying the React fiber the shell marks it with. */
function makeStrip(sessionId, guests = []) {
  const views = guests.map(id => ({
    getWebContentsId: () => id,
    getBoundingClientRect: () => ({ width: 320, height: 200 }),
    getURL: () => 'https://example.com/',
  }))
  return {
    __reactFiber$test: { memoizedProps: { sessionId }, return: null },
    querySelectorAll: (selector) => (selector === 'webview' ? views : []),
    parentElement: null,
  }
}

/** A document holding just these strips. */
function documentWith(...strips) {
  return makeDocument({
    querySelectorAll: (selector) => (selector === '[class*=_tabStrip]' ? strips : []),
  })
}

/**
 * A shell sidebar service that records which navigation the panel service chose to call.
 * @param placed - how many tabs the conversation's store accepts. Zero models a conversation whose
 *   surface was never minted, where `openTabIn` is a silent no-op — the case that must never be
 *   reported as success.
 */
function recordingSidebar(placed = 1) {
  const calls = []
  let tabs = []
  return {
    calls,
    get tabs() { return tabs },
    service: {
      // Public method, and the only proof that a placed tab actually landed.
      tabsIn: () => tabs,
      openTabIn: (...args) => {
        calls.push(['openTabIn', ...args])
        if (placed > 0) tabs = [...tabs, { id: `tab:${args[1]}`, kind: args[1] }]
      },
      // The on-screen variant. Nothing may call it: it acts on the conversation the shell is
      // displaying, which is the entire class of bug this service exists to remove.
      openTab: (...args) => { calls.push(['openTab', ...args]) },
    },
  }
}

test('the panel service is published even when the host offers no sidebar service', async () => {
  const { panel } = await mount()
  assert.ok(panel !== undefined, 'the API is published on the global the bridge calls')
  assert.equal(typeof panel.openPanel, 'function')
  // And a call names the missing service instead of throwing into the bridge's evaluate.
  const verdict = panel.openPanel('session-a', 'https://example.com/')
  assert.equal(verdict.ok, false)
  assert.match(String(verdict.reason), /sidebar service/)
})

test('opening a panel names the calling conversation and never the on-screen one', async () => {
  const { calls, service } = recordingSidebar()
  const { panel } = await mount({
    sidebarRight: service,
    document: documentWith(makeStrip('session-a')),
  })

  const verdict = panel.openPanel('session-a', 'https://example.com/')
  assert.equal(verdict.ok, true)
  assert.equal(verdict.created, true, 'the panel had no guest, so a tab was placed')

  assert.equal(calls.length, 1, 'exactly one navigation')
  const [method, sessionId, kind, options] = calls[0]
  assert.equal(method, 'openTabIn', 'the conversation-scoped call is the one used')
  assert.equal(sessionId, 'session-a', 'the call carries the CALLING conversation id')
  assert.equal(kind, 'browser')
  // Field by field: the options object is built inside the bundle's own realm, so a deep compare
  // against a host-realm literal fails on the prototype rather than on the contents — the same
  // cross-realm caveat the exports.inject assertion above carries.
  assert.equal(options.params.url, 'https://example.com/', 'the address rides along to the shell')
  assert.ok(!calls.some(call => call[0] === 'openTab'), 'the on-screen variant is never called')
})

test('the panel lookup never leaves the calling conversation subtree', async () => {
  const { calls, service } = recordingSidebar()
  // Two conversations have sidebars at once, which is the normal state of the shell. The guest
  // that exists belongs to the OTHER one.
  const { panel } = await mount({
    sidebarRight: service,
    document: documentWith(makeStrip('session-a'), makeStrip('session-b', [77])),
  })

  const verdict = panel.openPanel('session-a', 'https://example.com/')
  assert.equal(verdict.guestId, null, 'session-b\'s guest is not handed to session-a')
  assert.equal(calls.length, 1, 'session-a still opens its own panel')
  assert.equal(calls[0][1], 'session-a')

  // And the other direction reads its own guest without navigating at all.
  const own = panel.panelGuest('session-b')
  assert.equal(own.guestId, 77, 'session-b reads its own guest')
  assert.equal(calls.length, 1, 'reading an existing guest navigates nothing')
})

test('a conversation whose surface was never minted is refused by name, not driven', async () => {
  // `openTabIn` SILENTLY ignores a conversation the shell has never shown, so its returning cannot
  // be read as success. `tabsIn` is what proves a tab landed, and this is the case where it did
  // not — reported with what the lookup actually found, so the reason is actionable.
  const { calls, service } = recordingSidebar(0)
  const { panel } = await mount({
    sidebarRight: service,
    document: documentWith(makeStrip('session-other')),
  })

  const verdict = panel.openPanel('session-a', 'https://example.com/')
  assert.equal(verdict.ok, false)
  assert.match(String(verdict.reason), /not mounted/)
  assert.equal(calls.length, 1, 'it tried exactly once')
  assert.equal(calls[0][0], 'openTabIn', 'through the conversation-scoped call, never the on-screen one')
  assert.equal(verdict.found.wanted, 'session-a')
  assert.deepEqual([...verdict.found.owners], ['session-other'], 'and it reports what it did find')
})

test('a non-conversation owner is refused before any lookup', async () => {
  const { calls, service } = recordingSidebar()
  const { panel } = await mount({ sidebarRight: service, document: documentWith(makeStrip('session-a')) })

  for (const owner of ['anonymous', 'default', '', undefined]) {
    const verdict = panel.openPanel(owner, 'https://example.com/')
    assert.equal(verdict.ok, false, `${String(owner)} is refused`)
    assert.equal(verdict.guestId, null)
  }
  assert.equal(calls.length, 0, 'no navigation is attempted for an unidentifiable caller')
})
