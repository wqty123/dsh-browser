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
  /**
   * A minimal element: enough for code that BUILDS a tree rather than parsing one.
   *
   * The live-view panel creates its nodes and keeps references, so it needs attributes, children,
   * text and listeners — not markup parsing or query lookups. Returning `{}` made every one of those
   * throw, which surfaced as "setAttribute is not a function" rather than as anything to do with the
   * panel's behaviour.
   */
  const element = (tag = 'div') => {
    const node = {
      tagName: String(tag).toUpperCase(),
      className: '',
      textContent: '',
      hidden: false,
      children: [],
      attributes: new Map(),
      listeners: new Map(),
      setAttribute(name, value) { node.attributes.set(String(name), String(value)) },
      getAttribute(name) { return node.attributes.get(String(name)) ?? null },
      removeAttribute(name) { node.attributes.delete(String(name)) },
      appendChild(child) { node.children.push(child); return child },
      addEventListener(type, handler) {
        const list = node.listeners.get(type) ?? []
        list.push(handler)
        node.listeners.set(type, list)
      },
      removeEventListener(type, handler) {
        const list = node.listeners.get(type) ?? []
        node.listeners.set(type, list.filter(entry => entry !== handler))
      },
      /** Fire a listener the way a real event would, so a test can drive the panel. */
      dispatch(type, event = {}) {
        for (const handler of node.listeners.get(type) ?? []) handler({ type, ...event })
      },
      remove() {},
      querySelector() { return null },
      querySelectorAll() { return [] },
    }
    return node
  }
  return {
    body: element('body'),
    documentElement: element('html'),
    head: { appendChild: () => {} },
    getElementById: () => null,
    createElement: tag => element(tag),
    querySelectorAll: () => [],
    addEventListener() {},
    visibilityState: 'visible',
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
      // Forwarded rather than captured, like the rest: the live-view panel listens for
      // visibilitychange and reads `visibilityState`, and a test swaps the document between cases.
      get visibilityState() { return activeDocument.visibilityState ?? 'visible' },
      addEventListener: (type, handler) => activeDocument.addEventListener?.(type, handler),
      removeEventListener: (type, handler) => activeDocument.removeEventListener?.(type, handler),
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
    //
    // Each service is dispatched by name, so a host that offers one and not the other is
    // expressible: that is the case the two separate `inject` calls in the bundle exist for.
    inject: (names, fn) => {
      const scope = { effect: (run) => { run() } }
      let bound = false
      if (names.includes('sidebarRight') && options.sidebarRight !== undefined) {
        scope.sidebarRight = options.sidebarRight
        bound = true
      }
      if (names.includes('uiWorkspace') && options.uiWorkspace !== undefined) {
        scope.uiWorkspace = options.uiWorkspace
        bound = true
      }
      if (bound) fn(scope)
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
 * A minimal page shaped like the shell's: an application root holding one container per
 * conversation, each with its own strip (and possibly its own guest).
 *
 * The shell mounts EVERY conversation's panel in the same document — hidden ones included — which
 * is what makes "walk up until you find a guest" wrong: one step too far reaches a subtree holding
 * all of them.
 */
function makeShellTree({ own, other }) {
  // `appendChild` accepts and ignores: the live-view panel mounts itself on `document.body`, and
  // this fixture's body is a hand-built shape that only answers sidebar queries. Accepting the
  // append keeps the bundle's mount step from failing without adding a node to the shell tree.
  const body = { appendChild: child => child }
  const panelOf = (sessionId, guestIds) => {
    const views = guestIds.map(id => ({
      getWebContentsId: () => id,
      getBoundingClientRect: () => ({ width: 100, height: 100 }),
      getURL: () => 'about:blank',
    }))
    const strip = {
      __reactFiber$t: { memoizedProps: { sessionId }, return: null },
      querySelectorAll: () => [],
      parentElement: null,
    }
    const panel = {
      parentElement: null,
      querySelectorAll: (selector) => {
        if (selector === '[class*=_tabStrip]') return [strip]
        if (selector === 'webview') return views
        return []
      },
    }
    strip.parentElement = panel
    return panel
  }
  const ownPanel = panelOf(own.sessionId, own.guestIds ?? [])
  const otherPanel = panelOf(other.sessionId, other.guestIds ?? [])
  const panels = [ownPanel, otherPanel]
  const root = {
    parentElement: body,
    querySelectorAll: (selector) => panels.flatMap(panel => panel.querySelectorAll(selector)),
  }
  ownPanel.parentElement = root
  otherPanel.parentElement = root
  return makeDocument({
    body,
    querySelectorAll: (selector) => (selector === '[class*=_tabStrip]'
      ? panels.flatMap(panel => panel.querySelectorAll(selector))
      : []),
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
        const kind = args[1]
        // The shell DEDUPLICATES a page kind: a second request for one the conversation already
        // holds reveals that tab instead of adding another. A fake that always appended would hide
        // the very case this suite now guards.
        if (placed > 0 && !tabs.some(tab => tab.kind === kind)) {
          tabs = [...tabs, { id: `tab:${kind}`, kind }]
        }
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

test('a conversation that already holds the page is never mistaken for an unmounted one', async () => {
  // The shell deduplicates a page kind, so a second request leaves the tab count unchanged. Reading
  // "the count did not grow" as "this conversation has no sidebar" refused to drive a page that was
  // right there — the "it will not reopen what it already opened" report, worst on exactly the
  // second open of an address, which is when a human expects the fastest answer.
  const { service } = recordingSidebar()
  const { panel } = await mount({
    sidebarRight: service,
    document: documentWith(makeStrip('session-a')),
  })

  const first = panel.openPanel('session-a', 'https://example.com/')
  assert.equal(first.ok, true, 'the first call succeeds')
  assert.equal(first.created, true, 'and reports that it placed the tab')

  const second = panel.openPanel('session-a', 'https://example.com/')
  assert.equal(second.ok, true, 'the second call is NOT refused')
  assert.equal(second.created, false, 'and reports that nothing new was placed')
})

test('the walk up stops at this conversation, never reaching the shell root', async () => {
  // Measured on the running shell: a GitHub login page opened in a DIFFERENT conversation was
  // reported as this one's guest, because the walk up to the first ancestor holding a guest reached
  // the application root — where every conversation's panel is mounted, hidden ones included.
  const { calls, service } = recordingSidebar()
  const { panel } = await mount({
    sidebarRight: service,
    document: makeShellTree({
      own: { sessionId: 'session-a', guestIds: [] },        // this conversation has no page yet
      other: { sessionId: 'session-b', guestIds: [99] },    // a neighbour has one
    }),
  })

  const seen = panel.panelGuest('session-a')
  assert.equal(seen.panel, true, 'this conversation\'s sidebar is found')
  assert.equal(seen.guestId, null, 'and the neighbour\'s guest is NOT reported as this one\'s')
  assert.notEqual(seen.guestId, 99)

  // Opening a panel must not navigate the neighbour's guest either.
  const verdict = panel.openPanel('session-a', 'https://example.com/')
  assert.equal(verdict.guestId, null, 'no foreign guest is handed back')
  assert.equal(calls.length, 1, 'it placed its own tab')
  assert.equal(calls[0][1], 'session-a', 'naming its own conversation')
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

test('panelGuests lists only all guests of the named conversation', async () => {
  const { panel } = await mount({ document: documentWith(makeStrip('session-a', [11, 12]), makeStrip('session-b', [99])) })
  assert.deepEqual(Array.from(panel.panelGuests('session-a')), [11, 12])
  assert.deepEqual(Array.from(panel.panelGuests('session-b')), [99])
  assert.deepEqual(Array.from(panel.panelGuests('anonymous')), [])
})

test('closePanelGuest matches a tab by identity and cannot close a same-title neighbour', async () => {
  const clicks = []
  const button = id => ({ getAttribute: key => key === 'aria-label' ? 'Close' : null, click: () => clicks.push(id) })
  const header = (tabId, id) => ({
    __reactFiber$test: { memoizedProps: { tab: { id: tabId } }, return: null },
    getAttribute: () => null,
    querySelectorAll: () => [button(id)],
  })
  const headers = [header('tab-a', 11), header('tab-b', 12)]
  const views = [11, 12].map((id, index) => ({
    getWebContentsId: () => id,
    __reactFiber$test: { memoizedProps: { tab: { id: index ? 'tab-b' : 'tab-a' } }, return: null },
  }))
  const strip = makeStrip('session-a')
  strip.querySelectorAll = selector => selector === 'webview' ? views : selector === '[role=tab]' ? headers : []
  const { panel } = await mount({
    document: documentWith(strip, makeStrip('session-b', [99])),
    sidebarRight: { tabsIn: () => [{ id: 'tab-a' }, { id: 'tab-b' }] },
  })
  assert.equal(panel.closePanelGuest('session-a', 12).ok, true)
  assert.deepEqual(clicks, [12])
  assert.equal(panel.closePanelGuest('session-a', 99).ok, false)
  assert.deepEqual(clicks, [12])
})

// rc.5 creates webviews imperatively inside data-sidebar-right-tab containers. The guest
// itself has no React fiber; DockKit may place the same conversation in several panes.
function rc5Tree() {
  class Node {
    constructor(tag, attributes = {}, children = []) {
      this.tag = tag; this.attributes = attributes; this.children = children
      for (const child of children) child.parentElement = this
    }
    getAttribute(name) { return this.attributes[name] ?? null }
    /**
     * Accept a child WITHOUT recording it in `children`.
     *
     * The live-view panel mounts itself on `document.body`. This fixture's `children` is the
     * shell-shaped tree that `querySelectorAll` walks, so recording the panel there would feed a
     * non-Node into `matches()` and change what every sidebar lookup sees. A real DOM accepts the
     * append and the panel is simply part of the page; here the append is accepted and ignored,
     * which keeps the fixture describing the shell and nothing else.
     */
    appendChild(child) { return child }
    matches(selector) {
      return selector.split(',').some(raw => {
        const item = raw.trim()
        if (item === this.tag) return true
        if (item === '[class*=_tabStrip]') return (this.attributes.class ?? '').includes('_tabStrip')
        const match = /^\[([^=\]]+)(?:=["']?([^"'\]]+)["']?)?\]$/.exec(item)
        return match !== null && (match[2] === undefined ? match[1] in this.attributes : this.getAttribute(match[1]) === match[2])
      })
    }
    querySelectorAll(selector) { return this.children.flatMap(child => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]) }
    closest(selector) { for (let node = this; node; node = node.parentElement) if (node.matches(selector)) return node; return null }
    contains(other) { for (let node = other; node; node = node.parentElement) if (node === this) return true; return false }
  }
  const guest = (sessionId, id, tabId) => {
    const view = new Node('webview')
    view.getWebContentsId = () => id
    view.getBoundingClientRect = () => ({ width: 100, height: 100 })
    view.getURL = () => `https://page${id}.example/`
    const header = new Node('button', { role: 'tab', 'data-dockkit-tab': tabId })
    const strip = new Node('div', { class: '_tabStrip_fixture', 'data-dockkit-strip': '' }, [header])
    strip.__reactFiber$fixture = { memoizedProps: { sessionId }, return: null }
    return new Node('div', { 'data-dockkit-pane': `pane${id}` }, [strip, new Node('div', { 'data-sidebar-right-tab': tabId }, [view])])
  }
  // rc.5 has BOTH SessionView and SidebarPanel session markers (installed client.js:
  // 1704 and 1529), not a single owning element. All panes live inside the latter.
  const ownPanel = new Node('div', { 'data-sidebar-right-session': 'session-a', 'data-sidebar-right-panel': 'push' }, [guest('session-a', 11, 'tab1'), guest('session-a', 12, 'tab2')])
  const own = new Node('div', { 'data-sidebar-right-session': 'session-a' }, [ownPanel])
  const foreign = new Node('div', { 'data-sidebar-right-session': 'session-b' }, [guest('session-b', 99, 'tab1')])
  const body = new Node('body', {}, [own, foreign])
  return { document: makeDocument({ body, querySelectorAll: selector => body.querySelectorAll(selector) }), own, ownPanel, foreign, body, Node, guest }
}

test('rc5 lists all imperative guests across one conversation panes without foreign pages', async () => {
  const fixture = rc5Tree()
  const { panel } = await mount({ document: fixture.document })
  assert.deepEqual(Array.from(panel.panelGuests('session-a')), [11, 12])
  assert.deepEqual(Array.from(panel.panelGuests('session-b')), [99])
})

test('rc5 closes an imperative guest through closeIn using verified session and tab attributes', async () => {
  const fixture = rc5Tree()
  const calls = []
  let tabs = [{ id: 'tab1' }, { id: 'tab2' }]
  const { panel } = await mount({ document: fixture.document, sidebarRight: {
    tabsIn: () => tabs,
    closeIn: (sessionId, tabId) => { calls.push([sessionId, tabId]); tabs = tabs.filter(tab => tab.id !== tabId) },
  } })
  assert.equal(panel.closePanelGuest('session-a', 12).ok, true)
  assert.deepEqual(calls, [['session-a', 'tab2']])
  assert.equal(panel.closePanelGuest('session-a', 99).ok, false)
  assert.deepEqual(calls, [['session-a', 'tab2']])
})

test('rc5 reads the visible guest with nested SessionView and SidebarPanel ownership', async () => {
  const fixture = rc5Tree()
  const { panel } = await mount({ document: fixture.document })
  assert.equal(panel.panelGuest('session-a').guestId, 11)
  assert.equal(panel.panelGuest('session-a').url, 'https://page11.example/')
})

test('rc5 includes its floating pane once and excludes a nested foreign session', async () => {
  const fixture = rc5Tree()
  const floating = fixture.guest('session-a', 13, 'tab3')
  floating.attributes = { 'data-dockkit-float': 'float13' }
  floating.parentElement = fixture.ownPanel
  fixture.ownPanel.children.push(floating)
  // A foreign session can also have a tab1. It must never become session-a's guest.
  fixture.body.children = [fixture.own]
  fixture.foreign.parentElement = fixture.ownPanel
  fixture.ownPanel.children.push(fixture.foreign)
  const { panel } = await mount({ document: fixture.document })
  assert.deepEqual(Array.from(panel.panelGuests('session-a')), [11, 12, 13])
  assert.deepEqual(Array.from(panel.panelGuests('session-b')), [99])
})

test('rc5 missing requested owner cannot fall back to another owner stale React session', async () => {
  const fixture = rc5Tree()
  fixture.body.children = [fixture.foreign]
  const staleStrip = fixture.foreign.querySelectorAll('[class*=_tabStrip]')[0]
  staleStrip.__reactFiber$fixture.memoizedProps.sessionId = 'session-a'
  const calls = []
  const { panel } = await mount({ document: fixture.document, sidebarRight: {
    tabsIn: () => [{ id: 'tab1' }],
    closeIn: (...args) => calls.push(args),
  } })
  assert.deepEqual(Array.from(panel.panelGuests('session-a')), [])
  assert.equal(panel.panelGuest('session-a').panel, false)
  assert.equal(panel.closePanelGuest('session-a', 99).ok, false)
  assert.deepEqual(calls, [])
})

test('rc5 refuses conflicting tab attributes rather than choosing one stable id', async () => {
  const fixture = rc5Tree()
  const marker = fixture.ownPanel.querySelectorAll('[data-sidebar-right-tab]')[1]
  marker.attributes['data-dockkit-tab'] = 'tab1'
  const calls = []
  const { panel } = await mount({ document: fixture.document, sidebarRight: {
    tabsIn: () => [{ id: 'tab1' }, { id: 'tab2' }],
    closeIn: (...args) => calls.push(args),
  } })
  assert.equal(panel.closePanelGuest('session-a', 12).ok, false)
  assert.deepEqual(calls, [])
})

test('rc5 reports a no-op closeIn as refused and never tries an alternative tab', async () => {
  const fixture = rc5Tree()
  const calls = []
  const { panel } = await mount({ document: fixture.document, sidebarRight: {
    tabsIn: () => [{ id: 'tab1' }, { id: 'tab2' }],
    closeIn: (...args) => calls.push(args),
  } })
  const result = panel.closePanelGuest('session-a', 12)
  assert.equal(result.ok, false)
  assert.equal(result.closed, 0)
  assert.match(result.reason, /did not remove/)
  assert.deepEqual(calls, [['session-a', 'tab2']])
})

test('rc5 reuses its imperative guest without opening another conversation tab', async () => {
  const fixture = rc5Tree()
  const calls = []
  const { panel } = await mount({ document: fixture.document, sidebarRight: {
    openTabIn: (...args) => calls.push(args),
  } })
  const result = panel.openPanel('session-a', 'https://new.example/')
  assert.equal(result.ok, true)
  assert.equal(result.created, false)
  assert.equal(result.guestId, 11)
  assert.deepEqual(calls, [])
})

test('rc5 never infers missing DOM tab identity from React or another session tab list', async () => {
  for (const mode of ['missing-marker', 'foreign-list', 'outside-owner', 'conflicting-ancestor']) {
    const fixture = rc5Tree()
    const view = fixture.ownPanel.querySelectorAll('webview')[1]
    const marker = view.parentElement
    // Even a plausible React fallback must not override the authoritative modern DOM.
    view.__reactFiber$fixture = { memoizedProps: { tab: { id: 'tab2' } }, return: null }
    if (mode === 'missing-marker' || mode === 'outside-owner') delete marker.attributes['data-sidebar-right-tab']
    if (mode === 'outside-owner') fixture.own.attributes['data-sidebar-right-tab'] = 'tab2'
    if (mode === 'conflicting-ancestor') marker.parentElement.attributes['data-dockkit-tab'] = 'tab1'
    const calls = []
    const { panel } = await mount({ document: fixture.document, sidebarRight: {
      tabsIn: () => [{ id: mode === 'foreign-list' ? 'other-tab' : 'tab2' }],
      closeIn: (...args) => calls.push(args),
    } })
    assert.equal(panel.closePanelGuest('session-a', 12).ok, false, mode)
    assert.deepEqual(calls, [], mode)
  }
})

test('rc5 reports cleanup errors from closeIn without clicking another tab control', async () => {
  const fixture = rc5Tree()
  const calls = []
  const { panel } = await mount({ document: fixture.document, sidebarRight: {
    tabsIn: () => [{ id: 'tab1' }, { id: 'tab2' }],
    closeIn: (...args) => { calls.push(args); throw new Error('cleanup refused') },
  } })
  const result = panel.closePanelGuest('session-a', 12)
  assert.equal(result.ok, false)
  assert.equal(result.closed, 0)
  assert.match(result.reason, /cleanup refused/)
  assert.deepEqual(calls, [['session-a', 'tab2']])
})

test('a shell without closeIn uses only the exact session and tab DOM close button', async () => {
  const fixture = rc5Tree()
  const clicks = []
  for (const header of fixture.body.querySelectorAll('[role=tab]')) {
    const owner = header.closest('[data-sidebar-right-session]').getAttribute('data-sidebar-right-session')
    const button = new fixture.Node('button', { 'aria-label': 'Close same title' })
    button.click = () => clicks.push([owner, header.getAttribute('data-dockkit-tab')])
    button.parentElement = header
    header.children.push(button)
  }
  const { panel } = await mount({ document: fixture.document, sidebarRight: {
    tabsIn: () => [{ id: 'tab1' }, { id: 'tab2' }],
  } })
  assert.equal(panel.closePanelGuest('session-a', 12).ok, true)
  assert.deepEqual(clicks, [['session-a', 'tab2']])
})

test('rc5 refuses duplicate matching fallback tab controls', async () => {
  const fixture = rc5Tree()
  const duplicate = new fixture.Node('button', { role: 'tab', 'data-dockkit-tab': 'tab2' })
  duplicate.parentElement = fixture.ownPanel
  fixture.ownPanel.children.push(duplicate)
  const { panel } = await mount({ document: fixture.document, sidebarRight: {
    tabsIn: () => [{ id: 'tab1' }, { id: 'tab2' }],
  } })
  const result = panel.closePanelGuest('session-a', 12)
  assert.equal(result.ok, false)
  assert.match(result.reason, /one matching tab control/)
})

test('rc5 ignores unready or destroyed guests while listing live guests in its panes', async () => {
  const fixture = rc5Tree()
  const views = fixture.ownPanel.querySelectorAll('webview')
  views[0].getWebContentsId = () => { throw new Error('guest destroyed') }
  views[1].getWebContentsId = () => 0
  const { panel } = await mount({ document: fixture.document })
  assert.deepEqual(Array.from(panel.panelGuests('session-a')), [])
  assert.equal(panel.panelGuest('session-a').panel, true)
  assert.equal(panel.panelGuest('session-a').guestId, null)
})

// ---------------------------------------------------------------------------
// A placed tab is not a shown page.
//
// Measured on the running shell: the bridge read `panel: true, guestId: null` and an empty
// sidebar guest list for its whole 20 s budget, then reported the panel unusable and swapped the
// surface to a separate window. The cause is a layout fact, not a timing one: the shell renders
// the body of the ACTIVE tab and only while the column is expanded, so a folded column keeps its
// strip (hence `panel: true`) and never creates the `<webview>`. Placements alone therefore have
// no way to produce a guest, and no amount of polling fixes that — the column has to be asked to
// open, and the tab has to be made the active one.
// ---------------------------------------------------------------------------

/**
 * A sidebar service whose column can be folded, recording what the panel service asked for.
 *
 * `tabsIn` reports the tab even while folded, which is exactly the shape that fooled the old
 * code: the store knows about the page, the DOM does not.
 */
function revealingSidebar({ expanded = false, tabs = [{ id: 'tab:browser', kind: 'browser' }], onScreen = 'session-a' } = {}) {
  const state = { expanded, expandCalls: 0, focusCalls: [], placementCalls: [] }
  const held = [...tabs]
  return {
    state,
    service: {
      // The shell's own answer to "which conversation is displayed". Pass `onScreen: null` to model
      // a shell that will not say, which both callers must treat as "not this conversation".
      screen: () => (onScreen === null ? undefined : { sessionId: onScreen, surface: {} }),
      tabsIn: () => held,
      openTabIn: (sessionId, kind, options) => {
        state.placementCalls.push([sessionId, kind, options])
        // The shell records the page and DEDUPLICATES by kind; a stub that never recorded it
        // would make every placement look like a conversation whose surface was never minted.
        if (!held.some(tab => tab.kind === kind)) held.push({ id: `tab:${kind}`, kind })
      },
      isExpanded: () => state.expanded,
      toggleExpanded: () => {
        state.expandCalls += 1
        state.expanded = !state.expanded
      },
      focus: (id) => { state.focusCalls.push(id) },
    },
  }
}

test('a page placed in a folded column is expanded and focused so its webview can exist', async () => {
  const { state, service } = revealingSidebar()
  const { panel } = await mount({ sidebarRight: service, document: documentWith(makeStrip('session-a')) })

  const verdict = panel.openPanel('session-a', 'https://example.com/')
  assert.equal(verdict.ok, true)
  assert.equal(verdict.expanded, true, 'the folded column is opened')
  assert.equal(state.expandCalls, 1, 'once per open, not once per poll')
  assert.equal(verdict.focused, 'tab:browser', 'and the placed tab becomes the active one')
  assert.deepEqual(state.focusCalls, ['tab:browser'])
  assert.equal(state.expanded, true, 'the column really ends up open')
})

test('an already expanded column is focused but never folded', async () => {
  // `toggleExpanded` is a toggle, not "make sure expanded": calling it unconditionally would close
  // a column that was already open, which is the same class of mistake in the other direction.
  const { state, service } = revealingSidebar({ expanded: true })
  const { panel } = await mount({ sidebarRight: service, document: documentWith(makeStrip('session-a')) })

  const verdict = panel.openPanel('session-a', 'https://example.com/')
  assert.equal(verdict.ok, true)
  assert.equal(verdict.expanded, undefined, 'nothing was expanded')
  assert.equal(state.expandCalls, 0)
  assert.equal(state.expanded, true, 'and it is still open')
  assert.deepEqual(state.focusCalls, ['tab:browser'])
})

test('a conversation the shell is not showing never moves the column a human is reading', async () => {
  // `toggleExpanded` acts on the ON-SCREEN session, so a request from a background conversation that
  // called it would fold the panel of the conversation the human IS reading. `screen()` is what
  // separates the two, and this is the case it must refuse.
  const { state, service } = revealingSidebar({ onScreen: 'session-b' })
  const { panel } = await mount({ sidebarRight: service, document: documentWith() })

  const verdict = panel.openPanel('session-a', 'https://example.com/')
  assert.equal(verdict.switched, undefined, 'no workspace service was offered, so nothing is claimed')
  assert.equal(verdict.panel, false, 'no panel for this conversation was found')
  assert.equal(state.expandCalls, 0)
  assert.deepEqual(state.focusCalls, [])
})

test('a displayed conversation whose column was never opened is opened, not skipped', async () => {
  // The measured case: a freshly started shell has NO right sidebar at all until something asks for
  // one. The conversation is displayed, its panel DOM is absent, and the old guard ("only expand
  // when the panel DOM exists") meant nothing could ever open it — every call failed, and the fix
  // that had just shipped was unreachable on a fresh window.
  const { state, service } = revealingSidebar({ onScreen: 'session-a', expanded: false })
  const { panel } = await mount({ sidebarRight: service, document: documentWith() })

  const verdict = panel.openPanel('session-a', 'https://example.com/')
  assert.equal(verdict.displayed, true, 'the shell says this conversation is the displayed one')
  assert.equal(verdict.expanded, true, 'so the column is opened')
  assert.equal(state.expandCalls, 1)
  assert.deepEqual(state.focusCalls, ['tab:browser'])
})

test('a shell without the expansion API is still driven, and only placed', async () => {
  // An older shell exposes `tabsIn`/`openTabIn` and nothing else. The reveal step must degrade to
  // "place only" instead of throwing into the bridge's evaluate, which would have turned a working
  // carrier on a slightly older desktop into a hard failure.
  const { state, service } = revealingSidebar()
  delete service.isExpanded
  delete service.toggleExpanded
  delete service.focus
  const { panel } = await mount({ sidebarRight: service, document: documentWith(makeStrip('session-a')) })

  const verdict = panel.openPanel('session-a', 'https://example.com/')
  assert.equal(verdict.ok, true, 'the placement still reports success')
  assert.equal(verdict.expanded, undefined)
  assert.equal(verdict.focused, undefined)
  assert.equal(state.placementCalls.length, 1, 'and the tab was placed exactly once')
})

// ---------------------------------------------------------------------------
// A conversation that is not the one on screen.
//
// The shell renders ONE sidebar — the displayed conversation's — so a page requested from a
// background conversation could be placed in its store and never grow a webview. The previous
// answer told the human to click over to that conversation; that is a working carrier whose
// usability depends on their timing. The fix asks the shell to display it, which is the same
// navigation its own session list performs.
// ---------------------------------------------------------------------------

/** A workspace service that records which conversation the panel asked the shell to show. */
function recordingWorkspace() {
  const calls = []
  return {
    calls,
    service: {
      openSession: (sessionId) => { calls.push(sessionId) },
    },
  }
}

test('a page for a conversation the shell is not showing asks the shell to show it', async () => {
  const { service } = revealingSidebar({ onScreen: 'session-b' })
  const workspace = recordingWorkspace()
  // No strip for session-a: this conversation's panel DOM is absent, and another conversation is
  // the one on screen.
  const { panel } = await mount({
    sidebarRight: service,
    uiWorkspace: workspace.service,
    document: documentWith(),
  })

  const verdict = panel.openPanel('session-a', 'https://example.com/')
  assert.deepEqual(workspace.calls, ['session-a'], 'the shell is asked to display that conversation, once')
  assert.equal(verdict.switched, true, 'and the verdict says so, so the caller retries instead of failing')
  assert.equal(verdict.panel, false, 'the panel really was absent at the time of the request')
})

test('a conversation whose panel is already mounted is never switched away from', async () => {
  // The guard that keeps this from being a view-hijack: the shell is asked to change what it shows
  // only when this conversation has no sidebar DOM at all.
  const { service } = revealingSidebar()
  const workspace = recordingWorkspace()
  const { panel } = await mount({
    sidebarRight: service,
    uiWorkspace: workspace.service,
    document: documentWith(makeStrip('session-a')),
  })

  const verdict = panel.openPanel('session-a', 'https://example.com/')
  assert.deepEqual(workspace.calls, [])
  assert.equal(verdict.switched, undefined)
  assert.equal(verdict.ok, true)
})

test('a host without the workspace service still places the tab and reports no switch', async () => {
  const { service, state } = revealingSidebar()
  const { panel } = await mount({ sidebarRight: service, document: documentWith() })

  const verdict = panel.openPanel('session-a', 'https://example.com/')
  assert.equal(verdict.switched, undefined, 'nothing was switched, and nothing claims it was')
  assert.equal(state.placementCalls.length, 1, 'the placement path still ran')
})
