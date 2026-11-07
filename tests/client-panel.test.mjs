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
      // The live-view panel puts its bridge notice above the header. A fake without this made the
      // failure look like "the entry is broken" rather than "the fixture is incomplete".
      insertBefore(child, before) {
        const at = node.children.indexOf(before)
        if (at === -1) node.children.unshift(child)
        else node.children.splice(at, 0, child)
        return child
      },
      removeChild(child) { const at = node.children.indexOf(child); if (at !== -1) node.children.splice(at, 1); return child },
      parentNode: undefined,
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
    querySelector: () => null,
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
function bundleFactory(timers) {
  let factory
  const sandbox = {
    window: { __ModuleLoader__: { load: (spec) => { factory = spec.factory } } },
    console,
    setTimeout: timers?.setTimeout ?? setTimeout,
    clearTimeout: timers?.clearTimeout ?? clearTimeout,
    queueMicrotask,
    fetch: (...args) => activeFetch(...args),
    document: {
      get body() { return activeDocument.body },
      get head() { return activeDocument.head },
      get documentElement() { return activeDocument.documentElement },
      // Forwarded rather than captured, like the rest: the live-view panel listens for
      // visibilitychange and reads `visibilityState`, and a test swaps the document between cases.
      get visibilityState() { return activeDocument.visibilityState ?? 'visible' },
      addEventListener: (type, handler) => activeDocument.addEventListener?.(type, handler),
      removeEventListener: (type, handler) => activeDocument.removeEventListener?.(type, handler),
      getElementById: (id) => activeDocument.getElementById(id),
      createElement: (tag) => activeDocument.createElement(tag),
      querySelector: (selector) => activeDocument.querySelector(selector),
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
    // `useRef` is the fourth hook the bundle destructures. A mock without it failed as
    // "useRef is not a function" inside whichever component happened to call it first, which reads
    // like a defect in the panel rather than a gap in this harness.
    useRef: (initial) => {
      const entry = slotFor('ref')
      if (!('current' in entry)) entry.current = initial
      return entry
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
async function renderPanel(Component, host, fetchOverride) {
  activeFetch = fetchOverride ?? host.fetchMock
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
  if (options.fetch !== undefined) activeFetch = options.fetch
  const host = makeHost(settings)
  const exports = bundleFactory(options.timers)(host.requireFn)

  let registration
  const ctx = {
    effect: (fn) => { fn() },
    locale: options.locale ?? { register: () => {}, bind: () => (key) => key },
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

  // `render: false` stops after apply. A test that renders a component of its own must use the SAME
  // host: the bundle's `react` object is captured from the host it was loaded with, so a second host
  // records no hooks at all — and the failure looks like "the effect never ran" rather than like a
  // harness mix-up.
  if (options.render === false) return { tree: undefined, host, exports, registration, panel: activeSandbox.__dshBuiltinBrowser }

  // A test that supplies its own fetch keeps it: the watch panel's probe resolves across the render
  // loop, so clobbering the hook mid-test would hide the very requests the test is about.
  const tree = await renderPanel(registration.Component, host, options.fetch)
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

test('explicit and automatic system browsers expose profile and window controls', async () => {
  for (const channel of ['chrome', 'edge', 'auto']) {
    const mounted = await mount({ settings: { ...DEFAULT_SETTINGS, browser: { channel, headless: 'headless' } } })
    const controls = elements(mounted.tree)
    assert.equal(controls.find(node => node.props?.labelKey === 'browser.profile')?.props.checked, DEFAULT_SETTINGS.cookies.persist, `${channel}: sign-in persistence remains configurable`)
    assert.equal(controls.find(node => node.props?.label === 'browser.headless')?.props.value, 'headless', `${channel}: window mode remains configurable`)
  }
  for (const channel of ['bundled', 'sidebar']) {
    const mounted = await mount({ settings: { ...DEFAULT_SETTINGS, browser: { channel, headless: 'headless' } } })
    assert.equal(elements(mounted.tree).some(node => node.props?.labelKey === 'browser.profile' || node.props?.label === 'browser.headless'), false, `${channel}: carrier-owned profile and window controls are omitted`)
  }
})

test('automatic browser profile and window changes save their existing settings fields', async () => {
  const settings = { ...DEFAULT_SETTINGS, browser: { channel: 'auto', headless: 'auto' } }
  for (const [name, find, value, expected] of [
    ['profile', node => node.props?.labelKey === 'browser.profile', false, { cookies: { persist: false } }],
    ['window mode', node => node.props?.label === 'browser.headless', 'headless', { browser: { headless: 'headless' } }],
  ]) {
    const mounted = await mount({ settings })
    const control = elements(mounted.tree).find(find)
    assert.ok(control, `${name} is reachable for automatic browser selection`)
    control.props.onChange(value)
    await tick()
    const writes = mounted.host.calls.filter(call => call.init?.method === 'PUT')
    assert.equal(writes.length, 1)
    assert.deepEqual(JSON.parse(writes[0].init.body), expected)
  }
})

test('delivery validates drafts before saving all fields in one patch', async () => {
  const { host, registration } = await mount({ render: false })
  const form = await renderPanel(() => {
    const tree = registration.Component()
    const editor = elements(tree).find(node => node.type?.name === 'DeliverySettings')
    return editor?.type(editor.props)
  }, host)
  const values = { tool: 'upload_file', args: '{"file":"{path}","size":1}', onFail: 'stop', sites: 'Example.com=upload_site' }
  const event = { preventDefault() {}, currentTarget: { elements: { namedItem: name => ({ value: values[name] }) } } }
  form.props.onSubmit(event)
  assert.equal(host.calls.filter(call => call.init?.method === 'PUT').length, 0)
  values.args = '{"file":"{path}"}'
  form.props.onSubmit(event)
  const [write] = host.calls.filter(call => call.init?.method === 'PUT')
  assert.deepEqual(JSON.parse(write.init.body), {
    delivery: { tool: 'upload_file', args: { file: '{path}' }, onFail: 'stop', sites: { 'example.com': 'upload_site' } },
  })
})

test('the panel asks for the settings document and renders its sections', async () => {
  const { tree, host } = await mount()
  const reads = host.calls.filter(call => (call.init?.method ?? 'GET') === 'GET')
  assert.equal(reads.length, 1, 'it loaded the settings exactly once')
  assert.equal(reads[0].url, ROUTE)
  const keys = elements(tree).map(element => element.props.labelKey ?? element.props.titleKey ?? element.props.key).filter(Boolean)
  for (const key of ['browser.channel', 'ui.title', 'actions.title', 'remoteView.enabled']) {
    assert.ok(keys.includes(key), `the panel renders "${key}"`)
  }
  const advanced = elements(tree).find(node => node.type === 'details' && node.props.key === 'advanced')
  assert.ok(advanced)
  assert.equal(advanced.props.open, undefined)
  const advancedKeys = elements(advanced).map(node => node.props.labelKey ?? node.props.key)
  assert.ok(advancedKeys.includes('history.enabled'))
  assert.ok(advancedKeys.includes('vision.strategy'))
  assert.ok(advancedKeys.includes('delivery.title'))
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
  assert.equal(panel.panelProtocol, 3, 'the bridge can verify the renderer understands logical view identity')
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

test('an existing guest in a folded column is revealed without selecting an unrelated browser tab', async () => {
  const { state, service } = revealingSidebar({ tabs: [
    { id: 'first-browser', kind: 'browser' },
    { id: 'another-browser', kind: 'browser' },
  ] })
  const workspace = recordingWorkspace()
  const { panel } = await mount({
    sidebarRight: service,
    uiWorkspace: workspace.service,
    document: documentWith(makeStrip('session-a', [11])),
  })

  assert.equal(panel.panelGuest('session-a').guestId, 11)
  assert.deepEqual([...panel.panelGuests('session-a')], [11])
  assert.equal(state.expandCalls, 0, 'passive guest reads leave presentation alone')
  assert.deepEqual(workspace.calls, [])

  const result = panel.openPanel('session-a', 'https://example.com/')
  assert.equal(result.guestId, 11)
  assert.equal(result.created, false)
  assert.equal(result.displayed, true)
  assert.equal(result.expanded, true)
  assert.equal(state.expanded, true)
  assert.equal(state.expandCalls, 1)
  assert.deepEqual(state.placementCalls, [], 'the existing guest needs no new tab')
  assert.deepEqual(state.focusCalls, [], 'without its tab id no other browser tab is selected')
  assert.deepEqual(workspace.calls, [], 'the displayed owner is not reopened')
})

test('an existing guest in an expanded column keeps the column open on repeated navigation', async () => {
  const { state, service } = revealingSidebar({ expanded: true })
  const { panel } = await mount({
    sidebarRight: service,
    document: documentWith(makeStrip('session-a', [11])),
  })

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = panel.openPanel('session-a', 'https://example.com/')
    assert.equal(result.guestId, 11)
    assert.equal(result.displayed, true)
    assert.equal(result.expanded, undefined)
  }
  assert.equal(state.expanded, true)
  assert.equal(state.expandCalls, 0)
  assert.deepEqual(state.placementCalls, [])
  assert.deepEqual(state.focusCalls, [], 'a live guest alone does not identify a tab to focus')
})

test('an existing background guest claims only its owner and waits for that conversation before expanding', async () => {
  const { state, service } = revealingSidebar()
  let displayed = 'session-b'
  service.screen = () => ({ sessionId: displayed })
  const workspace = recordingWorkspace()
  const { panel } = await mount({
    sidebarRight: service,
    uiWorkspace: workspace.service,
    document: makeShellTree({
      own: { sessionId: 'session-a', guestIds: [11] },
      other: { sessionId: 'session-b', guestIds: [22] },
    }),
  })

  const waiting = panel.openPanel('session-a', 'https://example.com/')
  assert.equal(waiting.guestId, 11, 'the other conversation guest is never returned')
  assert.equal(waiting.switched, true)
  assert.equal(waiting.displayed, false)
  assert.deepEqual(workspace.calls, ['session-a'])
  assert.equal(state.expandCalls, 0, 'the on-screen session-b column is untouched')
  assert.deepEqual(state.focusCalls, [])
  assert.deepEqual(state.placementCalls, [])

  displayed = 'session-a'
  const shown = panel.openPanel('session-a', 'https://example.com/')
  assert.equal(shown.guestId, 11)
  assert.equal(shown.displayed, true)
  assert.equal(shown.expanded, true)
  assert.equal(state.expandCalls, 1)
  assert.deepEqual(workspace.calls, ['session-a'], 'the selected owner is not reopened on retry')
})

test('a newly placed browser tab is focused by id and reused while its guest attaches', async () => {
  const held = [{ id: 'old-blank', kind: 'browser' }]
  const focused = []
  let opened = 0
  const { panel } = await mount({
    document: documentWith(makeStrip('session-a')),
    sidebarRight: {
      screen: () => ({ sessionId: 'session-a' }),
      tabsIn: () => held,
      openTabIn: (_session, kind) => {
        opened += 1
        held.push({ id: 'requested-page', kind })
      },
      focus: id => focused.push(id),
    },
  })
  const first = panel.openPanel('session-a', 'https://example.com/')
  assert.equal(first.tabId, 'requested-page')
  assert.equal(first.focused, 'requested-page')
  const second = panel.openPanel('session-a', 'https://example.com/')
  assert.equal(second.created, false)
  assert.equal(second.tabId, 'requested-page')
  assert.equal(opened, 1, 'a second initialization read does not create another browser tab')
  assert.deepEqual(focused, ['requested-page', 'requested-page'])
})

test('deduplicated browser tabs match the requested URL rather than list order', async () => {
  const focused = []
  const held = [
    { id: 'first-blank', kind: 'browser', params: { url: '' } },
    { id: 'target', kind: 'browser', params: { url: 'https://example.com/' } },
    { id: 'last-unrelated', kind: 'browser', params: { url: 'https://other.example/' } },
  ]
  const { panel } = await mount({
    document: documentWith(makeStrip('session-a')),
    sidebarRight: {
      screen: () => ({ sessionId: 'session-a' }),
      tabsIn: () => held,
      openTabIn() {},
      focus: id => focused.push(id),
    },
  })
  const result = panel.openPanel('session-a', 'https://example.com/')
  assert.equal(result.tabId, 'target')
  assert.deepEqual(focused, ['target'])
})

test('ambiguous browser tabs are left to the shell instead of guessing the first or last', async () => {
  const focused = []
  const { panel } = await mount({
    document: documentWith(makeStrip('session-a')),
    sidebarRight: {
      screen: () => ({ sessionId: 'session-a' }),
      tabsIn: () => [{ id: 'first', kind: 'browser' }, { id: 'last', kind: 'browser' }],
      openTabIn() {},
      focus: id => focused.push(id),
    },
  })
  const result = panel.openPanel('session-a', 'https://example.com/')
  assert.equal(result.ok, false)
  assert.match(result.reason, /which browser tab/)
  assert.equal(result.focused, undefined)
  assert.equal(result.tabId, undefined)
  assert.deepEqual(focused, [])
})

test('panel guest polling with an intended tab id cannot return another browser tab', async () => {
  const fixture = rc5Tree()
  const { panel } = await mount({ document: fixture.document })
  assert.equal(panel.panelGuest('session-a', 'tab2').guestId, 12)
  assert.equal(panel.panelGuest('session-a', 'not-attached').guestId, null)
  assert.equal(panel.panelGuest('session-b', 'tab2').guestId, null)
  assert.equal(panel.panelGuest('session-a').guestId, 11, 'the legacy read still follows the drawn page')
})

test('a late guest on the old blank tab cannot satisfy a pending target placement', async () => {
  const fixture = rc5Tree()
  const [oldView, targetView] = fixture.ownPanel.querySelectorAll('webview')
  oldView.getWebContentsId = () => 0
  targetView.getWebContentsId = () => 0
  const held = [{ id: 'tab1', kind: 'browser' }]
  const focused = []
  let opened = 0
  const { panel } = await mount({
    document: fixture.document,
    sidebarRight: {
      screen: () => ({ sessionId: 'session-a' }),
      tabsIn: () => held,
      openTabIn: () => { opened += 1; held.push({ id: 'tab2', kind: 'browser' }) },
      focus: id => focused.push(id),
    },
  })
  assert.equal(panel.openPanel('session-a', 'https://example.com/').tabId, 'tab2')
  oldView.getWebContentsId = () => 11
  const retry = panel.openPanel('session-a', 'https://example.com/')
  assert.equal(retry.guestId, null)
  assert.equal(retry.tabId, 'tab2')
  assert.equal(opened, 1)
  assert.deepEqual(focused, ['tab2', 'tab2'])
  assert.equal(panel.panelGuest('session-a', 'tab2').guestId, null)
  targetView.getWebContentsId = () => 12
  assert.equal(panel.panelGuest('session-a', 'tab2').guestId, 12)
  const attached = panel.openPanel('session-a', 'https://example.com/')
  assert.equal(attached.guestId, 12)
  assert.equal(attached.focused, 'tab2', 'the known placement stays selected after its guest attaches')
  assert.deepEqual(focused, ['tab2', 'tab2', 'tab2'])
  assert.equal(opened, 1)
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

/** Native sidebar tabs with independent guest ids and URLs, including delayed guest attachment. */
function managedSidebar({ existing = [], attach = true } = {}) {
  const fixture = rc5Tree()
  fixture.ownPanel.children = []
  const pages = new Map()
  const tabs = []
  const calls = { opened: [], focused: [], expanded: 0 }
  let expanded = false
  let sequence = 100
  const add = (id, guestId, url, ready = true) => {
    const pane = fixture.guest('session-a', guestId, id)
    pane.parentElement = fixture.ownPanel
    fixture.ownPanel.children.push(pane)
    const view = pane.querySelectorAll('webview')[0]
    const page = { id, guestId, url, ready, visible: pages.size === 0, pane, view }
    view.getWebContentsId = () => page.ready ? page.guestId : 0
    view.getURL = () => page.url
    view.getBoundingClientRect = () => ({ width: page.visible ? 100 : 0, height: page.visible ? 100 : 0 })
    pages.set(id, page)
    tabs.push({ id, kind: 'browser', params: { url } })
    return page
  }
  for (const entry of existing) add(entry.id, entry.guestId, entry.url, entry.ready ?? true)
  return {
    fixture, pages, tabs, calls, add,
    service: {
      screen: () => ({ sessionId: 'session-a' }),
      tabsIn: owner => owner === 'session-a' ? tabs : [],
      openTabIn: (owner, kind, options) => {
        calls.opened.push([owner, kind, options])
        sequence += 1
        add(`native-${sequence}`, sequence, options?.params?.url ?? '', attach)
      },
      isExpanded: () => expanded,
      toggleExpanded: () => { calls.expanded += 1; expanded = !expanded },
      focus: id => {
        calls.focused.push(id)
        for (const page of pages.values()) page.visible = page.id === id
      },
    },
  }
}

for (const sameUrl of [false, true]) {
  test(`logical views create distinct native tabs with ${sameUrl ? 'the same' : 'different'} URLs`, async () => {
    const fixture = managedSidebar()
    const { panel } = await mount({ sidebarRight: fixture.service, document: fixture.fixture.document })
    const firstUrl = 'https://first.example/'
    const secondUrl = sameUrl ? firstUrl : 'https://second.example/'
    const first = panel.openPanel('session-a', firstUrl, { viewId: 'view-a' })
    const second = panel.openPanel('session-a', secondUrl, { viewId: 'view-b' })

    assert.equal(first.ok, true)
    assert.equal(second.ok, true)
    assert.notEqual(first.guestId, second.guestId)
    assert.notEqual(first.tabId, second.tabId)
    assert.equal(fixture.calls.opened.length, 2)
    assert.equal(fixture.pages.get(first.tabId).url, firstUrl)
    assert.equal(fixture.pages.get(second.tabId).url, secondUrl)

    const previous = panel.openPanel('session-a', 'https://changed-first.example/', { viewId: 'view-a', guestId: first.guestId })
    assert.equal(previous.guestId, first.guestId, 'navigating an old logical view keeps its native page')
    assert.equal(previous.tabId, first.tabId)
    assert.equal(previous.focused, first.tabId, 'the requested tab is selected, even while the other one is visible')
    fixture.pages.get(first.tabId).url = 'https://changed-first.example/'
    assert.equal(fixture.pages.get(second.tabId).url, secondUrl, 'a CDP navigation on the first guest leaves the second URL intact')
    assert.equal(fixture.calls.opened.length, 2, 'changing URLs does not create a replacement tab')
    assert.equal(panel.panelGuest('session-a', undefined, { viewId: 'view-b' }).guestId, second.guestId)
    assert.equal(panel.panelGuest('session-a', first.tabId, { viewId: 'view-b' }).guestId, null, 'a stale poll cannot override the view binding')
    assert.equal(panel.panelGuest('session-a', undefined, { viewId: 'uninitialized' }).guestId, null, 'a new view cannot poll a neighbour guest')
  })
}

test('an explicit cached guest binds and reveals its exact native tab after the client reloads', async () => {
  const fixture = managedSidebar({ existing: [
    { id: 'visible-first', guestId: 11, url: 'https://first.example/' },
    { id: 'cached-second', guestId: 12, url: 'https://second.example/' },
  ] })
  const { panel } = await mount({ sidebarRight: fixture.service, document: fixture.fixture.document })
  const result = panel.openPanel('session-a', 'https://second.example/', { viewId: 'view-b', guestId: 12 })
  assert.equal(result.guestId, 12)
  assert.equal(result.tabId, 'cached-second')
  assert.equal(result.focused, 'cached-second')
  assert.deepEqual(fixture.calls.focused, ['cached-second'])
  assert.equal(fixture.calls.opened.length, 0)
})

test('identical logical view ids in different conversations retain separate native bindings', async () => {
  const fixture = rc5Tree()
  let displayed = 'session-a'
  const switched = []
  const focused = []
  const { panel } = await mount({
    document: fixture.document,
    uiWorkspace: { openSession: owner => { switched.push(owner); displayed = owner } },
    sidebarRight: {
      screen: () => ({ sessionId: displayed }),
      tabsIn: owner => owner === 'session-a'
        ? [{ id: 'tab1', kind: 'browser' }, { id: 'tab2', kind: 'browser' }]
        : [{ id: 'tab1', kind: 'browser' }],
      openTabIn: () => assert.fail('both requested native guests already exist'),
      isExpanded: () => true,
      focus: id => focused.push([displayed, id]),
    },
  })
  const own = panel.openPanel('session-a', 'https://page11.example/', { viewId: 'same-view-id', guestId: 11 })
  const other = panel.openPanel('session-b', 'https://page99.example/', { viewId: 'same-view-id', guestId: 99 })
  assert.equal(own.guestId, 11)
  assert.equal(other.guestId, 99)
  assert.equal(panel.panelGuest('session-a', undefined, { viewId: 'same-view-id' }).guestId, 11)
  assert.equal(panel.panelGuest('session-b', undefined, { viewId: 'same-view-id' }).guestId, 99)
  assert.deepEqual(switched, ['session-b'])
  assert.deepEqual(focused, [['session-a', 'tab1'], ['session-b', 'tab1']])
})

test('a logical view cannot claim a guest already bound to another view', async () => {
  const fixture = managedSidebar()
  const { panel } = await mount({ sidebarRight: fixture.service, document: fixture.fixture.document })
  const first = panel.openPanel('session-a', 'https://first.example/', { viewId: 'view-a' })
  const refused = panel.openPanel('session-a', 'https://second.example/', { viewId: 'view-b', guestId: first.guestId })
  assert.equal(refused.ok, false)
  assert.equal(refused.guestId, null)
  assert.match(refused.reason, /cannot be assigned/)
  assert.equal(panel.panelGuest('session-a', undefined, { viewId: 'view-a' }).guestId, first.guestId)
})

test('a missing cached guest creates a replacement instead of adopting an unrelated visible page', async () => {
  const fixture = managedSidebar({ existing: [{ id: 'human-page', guestId: 11, url: 'https://human.example/' }] })
  const { panel } = await mount({ sidebarRight: fixture.service, document: fixture.fixture.document })
  const result = panel.openPanel('session-a', 'https://replacement.example/', { viewId: 'lost-view', guestId: 88 })
  assert.equal(result.ok, true)
  assert.equal(result.created, true)
  assert.notEqual(result.guestId, 11)
  assert.equal(fixture.pages.get('human-page').url, 'https://human.example/')
  assert.equal(fixture.calls.opened.length, 1)
})

test('a pending native tab remains bound while its guest attaches and the requested URL changes', async () => {
  const fixture = managedSidebar({ attach: false })
  const { panel } = await mount({ sidebarRight: fixture.service, document: fixture.fixture.document })
  const first = panel.openPanel('session-a', 'https://first.example/', { viewId: 'view-a' })
  const second = panel.openPanel('session-a', 'https://second.example/', { viewId: 'view-a' })
  assert.equal(first.guestId, null)
  assert.equal(second.guestId, null)
  assert.equal(first.tabId, second.tabId)
  assert.equal(fixture.calls.opened.length, 1)
  fixture.pages.get(first.tabId).ready = true
  assert.equal(panel.panelGuest('session-a', first.tabId, { viewId: 'view-a' }).guestId, 101)
  const attached = panel.openPanel('session-a', 'https://second.example/', { viewId: 'view-a' })
  assert.equal(attached.guestId, 101)
  assert.equal(attached.created, false)
})

test('a closed native tab is replaced only for its owning logical view', async () => {
  const fixture = managedSidebar()
  const { panel } = await mount({ sidebarRight: fixture.service, document: fixture.fixture.document })
  const first = panel.openPanel('session-a', 'https://first.example/', { viewId: 'view-a' })
  const second = panel.openPanel('session-a', 'https://second.example/', { viewId: 'view-b' })
  const closed = fixture.pages.get(first.tabId)
  closed.ready = false
  fixture.tabs.splice(fixture.tabs.findIndex(tab => tab.id === first.tabId), 1)
  const replacement = panel.openPanel('session-a', 'https://replacement.example/', { viewId: 'view-a', guestId: first.guestId })
  assert.equal(replacement.ok, true)
  assert.notEqual(replacement.tabId, first.tabId)
  assert.notEqual(replacement.tabId, second.tabId)
  assert.equal(fixture.pages.get(second.tabId).url, 'https://second.example/')
  assert.equal(fixture.calls.opened.length, 3)
})

test('split panes with several visible unclaimed guests create a tab instead of guessing by list order', async () => {
  const fixture = managedSidebar({ existing: [
    { id: 'split-a', guestId: 11, url: 'https://first.example/' },
    { id: 'split-b', guestId: 12, url: 'https://second.example/' },
  ] })
  for (const page of fixture.pages.values()) page.visible = true
  const { panel } = await mount({ sidebarRight: fixture.service, document: fixture.fixture.document })
  const result = panel.openPanel('session-a', 'https://new.example/', { viewId: 'view-new' })
  assert.equal(result.ok, true)
  assert.equal(result.created, true)
  assert.notEqual(result.guestId, 11)
  assert.notEqual(result.guestId, 12)
  assert.equal(fixture.calls.opened.length, 1)
})

test('a shell that deduplicates a new view onto a bound tab refuses instead of sharing it', async () => {
  const fixture = managedSidebar()
  const { panel } = await mount({ sidebarRight: fixture.service, document: fixture.fixture.document })
  const first = panel.openPanel('session-a', 'https://first.example/', { viewId: 'view-a' })
  fixture.service.openTabIn = () => {}
  const second = panel.openPanel('session-a', 'https://second.example/', { viewId: 'view-b' })
  assert.equal(second.ok, false)
  assert.equal(second.guestId, null)
  assert.match(second.reason, /new browser tab/)
  assert.equal(fixture.pages.get(first.tabId).url, 'https://first.example/')
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
  // A request for the displayed conversation never reopens its view.
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

// ---------------------------------------------------------------------------
// Issue #40 third part: the live-view entry, its labels, and the token it paints with.
//
// Three things were reported and reproduced against the shipped bundle, all of them visible with no
// remote watching configured at all: the entry button was mounted on every page anyway, mounting it
// fired a bridge-status request, and the panel's static title stayed `watch.title` because the labels
// were written before the dictionaries were bound.
// ---------------------------------------------------------------------------

/** Serve the two endpoints the watch panel talks to, and record which were asked for. */
function watchHostFetch({ enabled = false, bridge } = {}) {
  const asked = []
  const fetchMock = async url => {
    asked.push(String(url))
    if (String(url).includes('/browser-view/sessions')) {
      return { ok: true, status: 200, json: async () => ({ enabled, sessions: enabled ? [] : [] }) }
    }
    if (String(url).includes('/bridge-status')) {
      return { ok: true, status: 200, json: async () => ({ bridge }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }
  return { asked, fetchMock }
}

/** A locale host that resolves keys lazily, the way the real one does. */
function lazyLocale() {
  const dictionaries = {}
  let active = 'zh'
  const listeners = new Set()
  return {
    dictionaries,
    setLocale: id => {
      active = id
      for (const fn of listeners) fn()
    },
    api: {
      register: (ns, dict) => { dictionaries[ns] = dict },
      bind: ns => key => dictionaries[ns]?.[active]?.[key] ?? key,
      getSnapshot: () => ({ active }),
      // The real service exposes `subscribe` and fires it on every snapshot change (a switch, and
      // late dictionary registration). A stub without it would have hidden the fix under test.
      subscribe: fn => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
    },
  }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 5))

test('a disabled remote view mounts no entry and never asks about the bridge', async () => {
  const { asked, fetchMock } = watchHostFetch({ enabled: false })
  const document = documentWith()
  await mount({ fetch: fetchMock, document })
  await tick()

  const layers = elements(activeDocument.body.children ?? [])
    .filter(node => String(node.className) === 'dsh-bw-watch')
  assert.equal(layers.length, 0, 'no entry was appended: a feature nobody enabled shows nothing')
  assert.equal(asked.some(url => url.includes('/bridge-status')), false,
    'and no diagnostic request is made for it')
})

test('an enabled remote view mounts the entry and then asks about the bridge', async () => {
  const { asked, fetchMock } = watchHostFetch({
    enabled: true,
    bridge: { state: 'stale', present: true, command: 'node desktop-bridge/install.mjs "<root>" --restart' },
  })
  await mount({ fetch: fetchMock, document: documentWith() })
  await tick()

  const layers = elements(activeDocument.body.children ?? [])
    .filter(node => String(node.className) === 'dsh-bw-watch')
  assert.equal(layers.length, 1, 'exactly one entry, and only because watching is on')
  assert.equal(asked.some(url => url.includes('/bridge-status')), true,
    'the diagnostic belongs to the enabled feature')
})

test('the panel labels are translated, not left as keys', async () => {
  const locale = lazyLocale()
  const { fetchMock } = watchHostFetch({ enabled: true, bridge: { state: 'installed', present: true } })
  await mount({ fetch: fetchMock, document: documentWith(), locale: locale.api })
  await tick()

  const nodes = elements(activeDocument.body.children ?? [])
  const title = nodes.find(node => String(node.className) === 'dsh-bw-watch-title')
  const open = nodes.find(node => String(node.className) === 'dsh-bw-watch-label')
  assert.ok(title !== undefined, 'the panel title exists')
  assert.equal(title.textContent, locale.dictionaries['settings.dsh-builtin-browser'].zh['watch.title'],
    'the title is the translated string, not the key')
  assert.notEqual(title.textContent, 'watch.title', 'the reported symptom must not be back')
  assert.ok(open !== undefined && open.textContent !== 'watch.open', 'the entry label is translated too')
})

test('the panel paints with a token the shipped theme defines', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  // The *usage* must be gone; the name may still appear in the comment that explains why.
  assert.equal(source.includes('var(--dsw-alias-bg-elevated'), false,
    'that token does not exist in the theme this ships against, so its fallback was the only thing seen')
  assert.match(source, /var\(--dsw-alias-bg-layer-2/, 'the token the host uses for elevated surfaces')
})

// ---------------------------------------------------------------------------
// Issue #46 second and third parts: the floating panel's geometry and the `hidden` attribute.
//
// Both are pure CSS and both were measured against the shipped bundle: the panel's opaque background
// covered the button it hangs off by 6px (taking the only way out with it), and `img.hidden = true`
// did nothing because an author `display: block` defeats the UA sheet's `[hidden]{display:none}`.
// ---------------------------------------------------------------------------

test('the panel sits above its button instead of on top of it', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const panel = /\.dsh-bw-watch-panel \{[^}]*\}/.exec(source)
  assert.ok(panel !== null, 'the panel rule exists')
  assert.match(panel[0], /bottom: calc\(100% \+ \d+px\)/,
    'positioned against the button box, so the 6px overlap cannot come back with a font change')
  assert.equal(/bottom: 40px/.test(panel[0]), false, 'the hard-coded 40px is gone')
})

test('the close control is visible, and the overlay stays under host dialogs', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  const close = /\.dsh-bw-watch-close \{[^}]*\}/.exec(source)
  assert.ok(close !== null)
  assert.match(close[0], /border: 1px solid/, 'it has an edge: a 16px glyph at 70% opacity was invisible')
  assert.match(close[0], /border-radius/, 'and reads as a control')
  assert.equal(/opacity: \.7/.test(close[0]), false, 'no longer faded into the title')

  const layer = /\.dsh-bw-watch \{[^}]*\}/.exec(source)
  assert.ok(layer !== null)
  const z = /z-index: (\d+)/.exec(layer[0])
  assert.ok(z !== null, 'the layer states its stacking')
  assert.ok(Number(z[1]) < 2147483000, 'and it is no longer above everything the host draws')
  assert.ok(Number(z[1]) >= 100, 'while still above ordinary page content')
})

test('the hidden attribute actually hides the preview image', () => {
  const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.match(source, /\.dsh-bw-watch-img\[hidden\] \{ display: none; \}/,
    'an author display rule needs its own [hidden] rule to honour the attribute')
  // And the script still uses the attribute, which is what the rule makes effective.
  assert.match(source, /img\.hidden = true/)
})

// ---------------------------------------------------------------------------
// Issue #46 follow-up: remote viewing is switched on from the settings panel, and it takes effect
// at once. Editing the settings file and reloading was the only way before, which is not something a
// phone can do at all.
// ---------------------------------------------------------------------------

test('the settings panel offers the remote-view switch, bound to the document', async () => {
  const { tree } = await mount({ settings: { ...DEFAULT_SETTINGS, remoteView: { enabled: false } } })
  const toggle = elements(tree).find(element => element.props?.labelKey === 'remoteView.enabled')?.props
  assert.ok(toggle !== undefined, 'the switch is rendered')
  assert.equal(toggle.checked, false, 'and shows what the document says')

  const on = await mount({ settings: { ...DEFAULT_SETTINGS, remoteView: { enabled: true } } })
  const checked = elements(on.tree).find(element => element.props?.labelKey === 'remoteView.enabled')?.props
  assert.equal(checked.checked, true, 'including when it is on')
})

test('flipping the remote-view switch writes exactly that field and re-evaluates the entry', async () => {
  // The re-evaluation is the whole point: a write that only stored the value left the user with a
  // switch that did nothing until a reload (issue #46).
  let enabled = false
  const asked = []
  // Serve the settings document as well as the two watch endpoints: the panel renders nothing until
  // its GET succeeds, and a mock that only knows the watch routes hides the switch under test.
  const documentSettings = () => ({ ...DEFAULT_SETTINGS, remoteView: { enabled } })
  const fetchMock = async (url, init) => {
    const path = String(url)
    if (path.includes('/browser-view/sessions')) {
      asked.push('sessions')
      return { ok: true, status: 200, json: async () => ({ enabled, sessions: [] }) }
    }
    if (path.includes('/bridge-status')) {
      asked.push('bridge-status')
      return { ok: true, status: 200, json: async () => ({ bridge: { state: 'installed', present: true } }) }
    }
    if (path.includes('/dsh-builtin-browser/settings')) {
      if (init?.method === 'PUT') {
        const body = JSON.parse(init.body)
        enabled = body.remoteView.enabled === true
        return { ok: true, status: 200, json: async () => ({ ok: true, settings: documentSettings() }) }
      }
      return { ok: true, status: 200, json: async () => ({ ok: true, settings: documentSettings(), path: '' }) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  }

  const { tree } = await mount({ fetch: fetchMock, document: documentWith(), settings: { ...DEFAULT_SETTINGS, remoteView: { enabled: false } } })
  await tick()
  const layerCount = () => elements(activeDocument.body.children ?? []).filter(node => String(node.className) === 'dsh-bw-watch').length
  assert.equal(layerCount(), 0, 'off: no entry')

  const toggle = elements(tree).find(element => element.props?.labelKey === 'remoteView.enabled')?.props
  assert.ok(toggle !== undefined)
  await toggle.onChange(true)
  await tick()
  await tick()

  const writes = asked.length
  assert.ok(writes > 0, 'the switch re-evaluated the entry instead of only storing the value')
  assert.equal(layerCount(), 1, 'and the entry is on screen without a reload')
})

// ---------------------------------------------------------------------------
// A runtime language switch must reach text that is already on screen (Mzy123l's note on #40: the
// locale service publishes on a switch but not on dictionary registration, so moving the registration
// earlier fixes the first paint and nothing else).
// ---------------------------------------------------------------------------

test('switching language updates the labels that are already mounted', async () => {
  const locale = lazyLocale()
  const { fetchMock } = watchHostFetch({ enabled: true, bridge: { state: 'installed', present: true } })
  await mount({ fetch: fetchMock, document: documentWith(), locale: locale.api })
  await tick()

  const byClass = name => elements(activeDocument.body.children ?? []).find(node => String(node.className) === name)
  const ns = 'settings.dsh-builtin-browser'
  assert.equal(byClass('dsh-bw-watch-title').textContent, locale.dictionaries[ns].zh['watch.title'],
    'starts in the host language')

  locale.setLocale('en')
  assert.equal(byClass('dsh-bw-watch-title').textContent, locale.dictionaries[ns].en['watch.title'],
    'and follows the switch without a reload')
  assert.equal(byClass('dsh-bw-watch-label').textContent, locale.dictionaries[ns].en['watch.open'])
})

// ---------------------------------------------------------------------------
// Readiness (0.5.6): the section that answers "can I use the browser right now".
//
// The state itself is unit-tested on the host side; what these check is what a USER gets: the three
// facts and the badge, the retry button exactly where it can do something, and — the case that
// matters after every update — a host too old to serve the route leaving the section out instead of
// showing an HTTP error at someone who has not restarted yet.
// ---------------------------------------------------------------------------

/** A fetch that answers by path: the settings document, and the two readiness endpoints. */
function readinessFetch({ runtime, status = 200, calls = [] } = {}) {
  return async (url, init = {}) => {
    const path = String(url)
    calls.push({ url: path, method: init.method ?? 'GET' })
    if (path.includes('/runtime-status')) return { ok: status === 200, status, json: async () => ({ ok: true, runtime }) }
    if (path.includes('/runtime-provision')) return { ok: true, status: 200, json: async () => ({ ok: true, runtime }) }
    return { ok: true, status: 200, json: async () => ({ ok: true, settings: DEFAULT_SETTINGS, path: '/tmp/settings.json' }) }
  }
}

/** The section, taken from the module the bundle exports (see the seam comment in client.js). */
function readinessComponent(exports) {
  const component = exports.__readinessSection
  assert.equal(typeof component, 'function', 'the readiness section is exported for this harness')
  return component
}

/** Every string in a rendered element tree. */
function textOf(node, found = []) {
  if (Array.isArray(node)) {
    for (const child of node) textOf(child, found)
    return found
  }
  if (node === null || node === undefined || typeof node === 'boolean') return found
  if (typeof node === 'string' || typeof node === 'number') {
    found.push(String(node))
    return found
  }
  if (typeof node === 'object') textOf(node.children, found)
  return found
}

const failedRuntime = {
  channel: 'bundled',
  carrier: 'bundled',
  readiness: 'blocked',
  electron: { state: 'failed', detail: 'the download failed: fetch failed', at: '2026-11-03T15:00:00.000Z' },
  bridge: {
    present: false,
    state: 'absent',
    detail: 'no DSH Desktop install was found on this machine',
    running: false,
    runningDetail: 'no desktop shell has published a bridge endpoint',
  },
  canProvision: true,
}

test('readiness shows the carrier, the runtime and the bridge, with the reason a runtime failed', async () => {
  const fetchMock = readinessFetch({ runtime: failedRuntime })
  const mounted = await mount({ fetch: fetchMock, render: false })
  const tree = await renderPanel(readinessComponent(mounted.exports), mounted.host, fetchMock)
  const text = textOf(tree).join(' | ')
  for (const expected of [
    'readiness.status.bundledFailed',
    'readiness.carrier.bundled',
    'readiness.electron.failed',
    'readiness.bridge.absent',
  ]) {
    assert.match(text, new RegExp(expected.replace(/\./g, '\\.')), `the section names "${expected}"`)
  }
  assert.match(text, /fetch failed/, 'and carries the reason the host reported')
})

test('the prepare button appears exactly where it can do something', async () => {
  const fetchMock = readinessFetch({ runtime: failedRuntime })
  const mounted = await mount({ fetch: fetchMock, render: false })
  const tree = await renderPanel(readinessComponent(mounted.exports), mounted.host, fetchMock)
  const buttons = elements(tree).filter(node => node.type === 'button')
  const labels = buttons.map(button => textOf(button).join(''))
  assert.ok(labels.includes('readiness.prepare'), 'a failed preparation offers the retry')
  assert.ok(labels.includes('readiness.recheck'), 'and a plain re-read')

})

test('while a download runs there is no second one on offer', async () => {
  // The shared attempt exists so two downloads never write into the same directory: the button must
  // be gone in this state, and the control that stays says what is happening instead of looking idle.
  //
  // Its own mount, deliberately: the bundle captures its hooks from the host it was loaded with, so
  // rendering one instance's component on another instance's host runs no effects at all — which
  // reads as "the section never loaded" rather than as a harness mix-up.
  const preparing = { ...failedRuntime, readiness: 'blocked', canProvision: false, electron: { ...failedRuntime.electron, state: 'preparing' } }
  const fetchMock = readinessFetch({ runtime: preparing })
  const mounted = await mount({ fetch: fetchMock, render: false })
  const tree = await renderPanel(readinessComponent(mounted.exports), mounted.host, fetchMock)
  const labels = elements(tree).filter(node => node.type === 'button').map(button => textOf(button).join(''))
  assert.equal(labels.includes('readiness.prepare'), false, 'no second download on offer')
  assert.ok(textOf(tree).includes('readiness.preparing'), 'and the panel says what is happening')
})

test('pressing prepare posts to the provisioning route', async () => {
  const calls = []
  const fetchMock = readinessFetch({ runtime: failedRuntime, calls })
  const mounted = await mount({ fetch: fetchMock, render: false })
  const tree = await renderPanel(readinessComponent(mounted.exports), mounted.host, fetchMock)
  const prepare = elements(tree).find(node => node.type === 'button' && textOf(node).join('') === 'readiness.prepare')
  assert.ok(prepare !== undefined, 'the button is there to press')
  await prepare.props.onClick()
  await tick()
  const posts = calls.filter(call => call.method === 'POST')
  assert.equal(posts.length, 1, 'exactly one request')
  assert.match(posts[0].url, /\/dsh-builtin-browser\/runtime-provision$/, 'to the route that starts the download')
})

test('a host without the route hides the section instead of reporting HTTP 404', async () => {
  // The skew every update produces: the client bundle is read at request time, the host's code is
  // whatever started with the process. Showing "could not read readiness: HTTP 404" would report the
  // user's missing restart as a fault in their settings.
  const fetchMock = readinessFetch({ runtime: failedRuntime, status: 404 })
  const mounted = await mount({ fetch: fetchMock, render: false })
  const tree = await renderPanel(readinessComponent(mounted.exports), mounted.host, fetchMock)
  assert.equal(tree, null, 'nothing is rendered at all')
  const text = textOf(tree).join(' ')
  assert.equal(/HTTP 404|readiness\.failed/.test(text), false, 'no error text either')
})
test('a language switch reaches the readiness labels that are already on screen', async () => {
  // `translate` is a module-level binding that `apply()` re-binds on every locale snapshot, but React
  // has no idea that happened: before `useLocaleVersion`, every label kept the language it was first
  // rendered in. The watch panel's version of this bug is covered above (its DOM is rewritten by
  // hand); this is the React section, which needs the subscription to re-render instead.
  const locale = lazyLocale()
  const fetchMock = readinessFetch({ runtime: failedRuntime })
  const mounted = await mount({ fetch: fetchMock, render: false, locale: locale.api })
  const zh = textOf(await renderPanel(readinessComponent(mounted.exports), mounted.host, fetchMock)).join(' | ')
  assert.match(zh, /内置 Electron/, 'starts in the host language')

  locale.setLocale('en')
  const en = textOf(await renderPanel(readinessComponent(mounted.exports), mounted.host, fetchMock)).join(' | ')
  assert.match(en, /Bundled Electron/, 'and follows the switch without a reload')
  assert.equal(/内置 Electron/.test(en), false, 'with no label left in the old language')
})
test('an installed bridge with no running shell names that state and retains external maintenance', async () => {
  // The gap between "installed" and "running" is the state users hit most (the desktop app is
  // closed). The row must not read a plain "Installed", and the sentence under it must explain the
  // process while retaining an external command for an explicit reinstall.
  const closedDesktop = {
    channel: 'sidebar',
    carrier: 'sidebar',
    readiness: 'blocked',
    electron: { state: 'present', detail: 'an Electron runtime is already available', at: '2026-11-03T15:00:00.000Z' },
    bridge: {
      present: true,
      state: 'installed',
      detail: 'the shell loads the patched tree and the bridge is in it',
      running: false,
      runningDetail: 'the shell that published the endpoint (pid 4242) is not running',
      command: 'node ".../desktop-bridge/install.mjs" "C:/DSH Desktop"',
    },
    canProvision: false,
  }
  const fetchMock = readinessFetch({ runtime: closedDesktop })
  const mounted = await mount({ fetch: fetchMock, render: false })
  const text = textOf(await renderPanel(readinessComponent(mounted.exports), mounted.host, fetchMock)).join(' | ')
  assert.match(text, /readiness\.bridge\.installedNotRunning/, 'the row names the real state')
  assert.match(text, /pid 4242/, 'and the sentence names the process that is missing')
  assert.match(text, /install\.mjs/, 'the command remains available for external maintenance')
})
test('an installed bridge that IS running says so, rather than a bare "installed"', async () => {
  const running = {
    channel: 'sidebar',
    carrier: 'sidebar',
    readiness: 'ready',
    electron: { state: 'present', detail: 'an Electron runtime is already available', at: '2026-11-03T15:00:00.000Z' },
    bridge: {
      present: true,
      state: 'installed',
      detail: 'the shell loads the patched tree and the bridge is in it',
      running: true,
      runningDetail: 'a desktop shell is running and answering on its published endpoint',
    },
    canProvision: false,
  }
  const fetchMock = readinessFetch({ runtime: running })
  const mounted = await mount({ fetch: fetchMock, render: false })
  const text = textOf(await renderPanel(readinessComponent(mounted.exports), mounted.host, fetchMock)).join(' | ')
  assert.match(text, /readiness\.bridge\.installedRunning/, 'the row distinguishes running from merely installed')
  assert.equal(/readiness\.bridge\.installedNotRunning/.test(text), false, 'and does not claim the opposite')
  assert.match(text, /readiness\.status\.bridgeReady/, 'with the overall verdict naming the available sidebar bridge')
})

for (const { name, runtime, expected } of [
  {
    name: 'detected Chrome', expected: '已找到 Chrome',
    runtime: { ...failedRuntime, channel: 'chrome', carrier: 'system', resolvedCarrier: 'system', readiness: 'ready', systemBrowser: { checked: true, present: true, kind: 'chrome', path: 'C:/Browsers/Chrome/chrome.exe' } },
  },
  {
    name: 'missing configured Edge', expected: '未找到 Edge',
    runtime: { ...failedRuntime, channel: 'edge', carrier: 'system', resolvedCarrier: 'system', systemBrowser: { checked: true, present: false } },
  },
  {
    name: 'automatic selection of installed Edge', expected: '已找到 Edge',
    runtime: { ...failedRuntime, channel: 'auto', carrier: 'auto', resolvedCarrier: 'system', readiness: 'ready', systemBrowser: { checked: true, present: true, kind: 'edge', path: 'C:/Browsers/Edge/msedge.exe' } },
  },
  {
    name: 'automatic selection of the live sidebar over an installed system browser', expected: '侧栏桥可用',
    runtime: { ...failedRuntime, channel: 'auto', carrier: 'auto', resolvedCarrier: 'sidebar', readiness: 'ready', bridge: { present: true, state: 'installed', running: true }, systemBrowser: { checked: true, present: true, kind: 'chrome' } },
  },
  {
    name: 'automatic fallback to an available bundled runtime', expected: '内置运行环境可用',
    runtime: { ...failedRuntime, channel: 'auto', carrier: 'auto', resolvedCarrier: 'bundled', readiness: 'ready', electron: { state: 'present' }, systemBrowser: { checked: true, present: false } },
  },
  {
    name: 'missing bundled runtime', expected: '内置运行环境待安装',
    runtime: { ...failedRuntime, resolvedCarrier: 'bundled', electron: { state: 'idle' } },
  },
  {
    name: 'runtime download in progress', expected: '正在下载内置运行环境',
    runtime: { ...failedRuntime, resolvedCarrier: 'bundled', electron: { state: 'preparing' }, canProvision: false },
  },
  {
    name: 'sidebar bridge waiting for installation', expected: '侧栏桥待安装',
    runtime: { ...failedRuntime, channel: 'sidebar', carrier: 'sidebar', resolvedCarrier: 'sidebar', bridge: { present: true, state: 'missing', running: false } },
  },
  {
    name: 'sidebar bridge waiting for repair', expected: '侧栏桥待修复',
    runtime: { ...failedRuntime, channel: 'sidebar', carrier: 'sidebar', resolvedCarrier: 'sidebar', bridge: { present: true, state: 'stale', running: true } },
  },
  {
    name: 'installed bridge with the Desktop closed', expected: '等待桌面端启动',
    runtime: { ...failedRuntime, channel: 'sidebar', carrier: 'sidebar', resolvedCarrier: 'sidebar', bridge: { present: true, state: 'installed', running: false } },
  },
]) {
  test(`readiness names the environment result: ${name}`, async () => {
    const locale = lazyLocale()
    const fetchMock = readinessFetch({ runtime })
    const mounted = await mount({ fetch: fetchMock, render: false, locale: locale.api })
    const tree = await renderPanel(readinessComponent(mounted.exports), mounted.host, fetchMock)
    const headline = elements(tree).find(node => node.props.key === 'head')
    assert.ok(textOf(headline).includes(expected), 'the main row names the actual discovered carrier and its missing prerequisite')
    assert.doesNotMatch(textOf(tree).join(' '), /实际启动才能确定|Only a real launch can tell|readiness\.state\.unknown/)
    if (runtime.systemBrowser?.path) {
      const diagnostic = elements(tree).find(node => node.type === 'details' && node.props.key === 'diagnostics')
      assert.ok(textOf(diagnostic).includes(runtime.systemBrowser.path), 'the detected executable is available in diagnostics')
    }
  })
}

function bridgeRuntime(state, present = true) {
  return {
    ...failedRuntime,
    channel: 'sidebar',
    carrier: 'sidebar',
    bridge: { ...failedRuntime.bridge, present, state },
  }
}

function bridgeButton(tree, label) {
  return elements(tree).find(node => node.type === 'button' && textOf(node).join('') === label)
}

test('bridge maintenance names its automatic restart and retains the diagnostic command', async () => {
  const locale = lazyLocale()
  const runtime = bridgeRuntime('installed')
  runtime.bridge.command = 'node "C:/Plugin/desktop-bridge/install.mjs" "C:/DSH Desktop"'
  const fetchMock = readinessFetch({ runtime })
  const mounted = await mount({ fetch: fetchMock, render: false, locale: locale.api })
  const tree = await renderPanel(readinessComponent(mounted.exports), mounted.host, fetchMock)
  const zh = textOf(tree).join(' | ')
  assert.match(zh, /点击后将正常退出并重启 DSH/, 'the explicit action names the desktop restart')
  assert.match(zh, /外部终端/, 'the supported maintenance surface is named')
  const diagnostics = elements(tree).find(node => node.type === 'details' && node.props.key === 'diagnostics')
  assert.ok(textOf(diagnostics).includes(runtime.bridge.command), 'installed users retain the external reinstall command')
  locale.setLocale('en')
  const en = textOf(await renderPanel(readinessComponent(mounted.exports), mounted.host, fetchMock)).join(' | ')
  assert.match(en, /DSH will exit normally and restart after you click/)
  assert.doesNotMatch(en, /maintenance script/)
})

for (const [state, label] of [
  ['missing', 'readiness.bridge.install'],
  ['stale', 'readiness.bridge.repair'],
  ['installed', 'readiness.bridge.reinstall'],
]) {
  test(`bridge ${state} offers its action outside folded diagnostics`, async () => {
    const calls = []
    const fetchMock = readinessFetch({ runtime: bridgeRuntime(state), calls })
    const mounted = await mount({ fetch: fetchMock, render: false })
    const tree = await renderPanel(readinessComponent(mounted.exports), mounted.host, fetchMock)
    const controls = elements(tree).find(node => node.props.key === 'bridge-controls')
    const diagnostics = elements(tree).find(node => node.type === 'details' && node.props.key === 'diagnostics')
    assert.ok(controls, 'bridge management remains visible without opening diagnostics')
    assert.ok(bridgeButton(controls, label), 'the action matches the actual bridge state')
    assert.equal(bridgeButton(diagnostics, label), undefined, 'the primary action is not buried in diagnostics')
    assert.ok(textOf(controls).includes('readiness.bridge.maintenanceHint'), 'the restart is stated beside the explicit action')
    assert.equal(calls.filter(call => call.method === 'POST').length, 0, 'viewing settings starts no installation')
  })
}

test('bridge management requires a detected desktop installation', async () => {
  for (const runtime of [bridgeRuntime('absent', false), bridgeRuntime('missing', false), bridgeRuntime('absent', true)]) {
    const fetchMock = readinessFetch({ runtime })
    const mounted = await mount({ fetch: fetchMock, render: false })
    const tree = await renderPanel(readinessComponent(mounted.exports), mounted.host, fetchMock)
    assert.equal(elements(tree).some(node => node.props.key === 'bridge-controls'), false)
    assert.equal(bridgeButton(tree, 'readiness.bridge.uninstall'), undefined)
  }
})

function maintenanceDocument(clicks = []) {
  return makeDocument({ querySelector(selector) {
    assert.equal(selector, '[data-windows-menu]')
    return { shadowRoot: { querySelector(inner) { assert.equal(inner, 'button'); return { click() { clicks.push('official-menu') } } } } }
  } })
}

function maintenanceTimers() {
  const pending = new Map()
  let next = 0
  return {
    pending,
    setTimeout(fn, ms) { const id = ++next; pending.set(id, { fn, ms }); return id },
    clearTimeout(id) { pending.delete(id) },
    async run(ms = 1000) {
      const entry = [...pending].find(([, timer]) => timer.ms === ms)
      assert.ok(entry, `a ${ms}ms maintenance poll was scheduled`)
      pending.delete(entry[0]); entry[1].fn(); await tick()
    },
  }
}

function maintenanceFixture({ state = 'missing', initialJob, post } = {}) {
  const calls = []
  let job = initialJob, runtime = bridgeRuntime(state), offline = false
  const fetchMock = async (url, init = {}) => {
    const path = String(url)
    calls.push({ path, init })
    if (path.endsWith('/bridge-action')) throw Error('legacy bridge-action must never be called')
    if (path.endsWith('/bridge-maintenance')) {
      if (init.method === 'POST') {
        if (post) return await post(init)
        const { action } = JSON.parse(init.body)
        job = { id: 'maintenance-1', phase: 'armed', action, at: '2026-11-06T02:00:00.000Z' }
        return { ok: true, status: 202, json: async () => ({ ok: true, accepted: true, protocol: 1, job }) }
      }
      if (offline) throw Error('connection interrupted while restarting')
      return { ok: true, status: 200, json: async () => ({ ok: true, protocol: 1, ...(job ? { job } : {}) }) }
    }
    if (path.endsWith('/runtime-status')) return { ok: true, status: 200, json: async () => ({ ok: true, runtime }) }
    return { ok: true, status: 200, json: async () => ({ ok: true, settings: DEFAULT_SETTINGS, enabled: false }) }
  }
  return {
    calls, fetchMock,
    setJob(next) { job = next },
    setRuntime(next) { runtime = next },
    setOffline(next) { offline = next },
  }
}

for (const [action, state, label, success] of [
  ['install', 'missing', 'readiness.bridge.install', 'readiness.bridge.installedDone'],
  ['uninstall', 'installed', 'readiness.bridge.uninstall', 'readiness.bridge.uninstalledDone'],
]) {
  test(`automatic bridge ${action} arms the new endpoint before opening the official menu and waits for completion`, async () => {
    const fixture = maintenanceFixture({ state }), clicks = [], timers = maintenanceTimers()
    const mounted = await mount({ fetch: fixture.fetchMock, render: false, document: maintenanceDocument(clicks), timers })
    const Component = readinessComponent(mounted.exports)
    const tree = await renderPanel(Component, mounted.host, fixture.fetchMock)
    await bridgeButton(tree, label).props.onClick()
    const armed = await renderPanel(Component, mounted.host, fixture.fetchMock)
    const posts = fixture.calls.filter(call => call.init.method === 'POST')
    assert.equal(posts.length, 1)
    assert.equal(posts[0].path, '/dsh-builtin-browser/bridge-maintenance')
    assert.deepEqual(JSON.parse(posts[0].init.body), { action, locale: 'zh' })
    assert.equal(new Headers(posts[0].init.headers).get('content-type'), 'application/json')
    assert.deepEqual(clicks, ['official-menu'], 'only the exact official menu button is opened after acknowledgement')
    assert.ok(textOf(armed).includes('readiness.bridge.phase.armed'))
    assert.ok(textOf(armed).includes('readiness.bridge.progressHint'), 'handoff explains the independent progress and automatic startup')
    assert.equal(elements(armed).some(node => node.props.key === 'bridge-result'), false, 'an armed job is never reported as completed')
    assert.ok(elements(armed).filter(node => node.type === 'button').every(node => node.props.disabled === true))
    fixture.setRuntime(bridgeRuntime(action === 'install' ? 'installed' : 'missing'))
    fixture.setJob({ id: 'maintenance-1', action, phase: 'completed', ok: true, restarted: true })
    await timers.run()
    const finished = await renderPanel(Component, mounted.host, fixture.fetchMock)
    assert.ok(elements(finished).some(node => node.props.key === 'bridge-result' && textOf(node).includes(success)))
    assert.ok(bridgeButton(finished, action === 'install' ? 'readiness.bridge.reinstall' : 'readiness.bridge.install'))
    assert.equal(fixture.calls.filter(call => call.path.endsWith('/runtime-status')).length, 2, 'completion refreshes actual runtime state')
    assert.equal(timers.pending.size, 0, 'terminal jobs leave no background maintenance polling')
  })
}

test('an in-flight handoff ignores duplicate clicks and disables concurrent controls', async () => {
  let complete
  const response = new Promise(resolve => { complete = resolve })
  const fixture = maintenanceFixture({ state: 'installed', post: () => response }), clicks = [], timers = maintenanceTimers()
  const mounted = await mount({ fetch: fixture.fetchMock, render: false, document: maintenanceDocument(clicks), timers })
  const Component = readinessComponent(mounted.exports)
  const tree = await renderPanel(Component, mounted.host, fixture.fetchMock)
  const install = bridgeButton(tree, 'readiness.bridge.reinstall')
  const task = install.props.onClick()
  await install.props.onClick()
  const pending = await renderPanel(Component, mounted.host, fixture.fetchMock)
  assert.equal(fixture.calls.filter(call => call.init.method === 'POST').length, 1)
  assert.ok(elements(pending).filter(node => node.type === 'button').every(node => node.props.disabled === true))
  const pendingButton = elements(pending).find(node => node.props.key === 'install')
  assert.deepEqual(textOf(pendingButton), ['readiness.bridge.working'], 'the button changes immediately before the POST settles')
  assert.equal(pendingButton.props['aria-busy'], 'true')
  assert.equal(pendingButton.props.style.cursor, 'default')
  assert.ok(elements(pending).some(node => node.props.role === 'status' && textOf(node).includes('readiness.bridge.working')), 'preparation feedback is present before the acknowledgement')
  assert.deepEqual(clicks, [], 'the menu remains closed until the worker is armed')
  complete({ ok: true, status: 202, json: async () => ({ ok: true, accepted: true, protocol: 1, job: { id: 'one', phase: 'armed', action: 'install' } }) })
  await task
  await install.props.onClick()
  assert.equal(fixture.calls.filter(call => call.init.method === 'POST').length, 1, 'a stale click handler cannot submit after acceptance either')
  assert.deepEqual(clicks, ['official-menu'])
})

for (const { name, snapshot, documentLanguage, switchLanguage, expected } of [
  { name: 'current English snapshot', snapshot: 'en', documentLanguage: 'zh-CN', expected: 'en' },
  { name: 'current Chinese snapshot', snapshot: 'zh', documentLanguage: 'en-GB', expected: 'zh' },
  { name: 'a language switch before the click', snapshot: 'zh', switchLanguage: 'en', documentLanguage: 'zh-CN', expected: 'en' },
  { name: 'legacy English document language', documentLanguage: 'en-GB', expected: 'en' },
  { name: 'legacy Chinese document language', documentLanguage: 'zh-CN', expected: 'zh' },
  { name: 'an unavailable language source', documentLanguage: '', expected: 'zh' },
]) {
  test(`maintenance passes locale from ${name}`, async () => {
    const fixture = maintenanceFixture(), locale = lazyLocale()
    const document = maintenanceDocument()
    document.documentElement.lang = documentLanguage
    if (snapshot !== undefined) locale.setLocale(snapshot)
    else delete locale.api.getSnapshot
    const mounted = await mount({ fetch: fixture.fetchMock, render: false, document, locale: locale.api, timers: maintenanceTimers() })
    const Component = readinessComponent(mounted.exports)
    const tree = await renderPanel(Component, mounted.host, fixture.fetchMock)
    if (switchLanguage) locale.setLocale(switchLanguage)
    await elements(tree).find(node => node.props.key === 'install').props.onClick()
    const post = fixture.calls.find(call => call.init.method === 'POST')
    assert.deepEqual(JSON.parse(post.init.body), { action: 'install', locale: expected })
  })
}

test('remote or unsupported surfaces cannot arm bridge maintenance', async () => {
  const fixture = maintenanceFixture(), timers = maintenanceTimers()
  const mounted = await mount({ fetch: fixture.fetchMock, render: false, document: makeDocument(), timers })
  const Component = readinessComponent(mounted.exports)
  const tree = await renderPanel(Component, mounted.host, fixture.fetchMock)
  await bridgeButton(tree, 'readiness.bridge.install').props.onClick()
  const refused = await renderPanel(Component, mounted.host, fixture.fetchMock)
  assert.equal(fixture.calls.some(call => call.init.method === 'POST'), false)
  assert.ok(textOf(refused).includes('readiness.bridge.localOnly'))
  assert.equal(bridgeButton(refused, 'readiness.bridge.install').props.disabled, false)
})

for (const [name, response, reason] of [
  ['old host', { ok: false, status: 404, data: { ok: false } }, 'readiness.bridge.unsupported'],
  ['missing protocol acknowledgement', { ok: true, status: 200, data: { ok: true, accepted: true, job: { id: 'unsafe', phase: 'armed', action: 'install' } } }, 'invalid bridge maintenance acknowledgement'],
  ['HTTP rejection', { ok: false, status: 409, data: { ok: false, error: 'bridge-maintenance-in-progress' } }, 'bridge-maintenance-in-progress'],
  ['installer refusal', { ok: true, status: 200, data: { ok: false, output: 'EBUSY: archive locked' } }, 'EBUSY: archive locked'],
  ['connection failure', null, 'connection interrupted'],
]) {
  test(`a ${name} never opens the native menu and permits retry`, async () => {
    const fixture = maintenanceFixture({ post: () => {
      if (!response) throw Error(reason)
      return { ...response, json: async () => response.data }
    } }), clicks = [], timers = maintenanceTimers()
    const mounted = await mount({ fetch: fixture.fetchMock, render: false, document: maintenanceDocument(clicks), timers })
    const Component = readinessComponent(mounted.exports)
    const tree = await renderPanel(Component, mounted.host, fixture.fetchMock)
    await bridgeButton(tree, 'readiness.bridge.install').props.onClick()
    const failed = await renderPanel(Component, mounted.host, fixture.fetchMock)
    assert.deepEqual(clicks, [])
    assert.ok(textOf(failed).join(' ').includes(reason), 'the reason remains visible in the short notice or diagnostics')
    assert.equal(elements(failed).some(node => node.props.key === 'bridge-result'), false)
    assert.equal(bridgeButton(failed, 'readiness.bridge.install').props.disabled, false)
    assert.equal(fixture.calls.some(call => call.path.endsWith('/bridge-action')), false)
  })
}

test('a remounted panel resumes an active job and keeps polling through the restart disconnect', async () => {
  const job = { id: 'resumed', action: 'install', phase: 'installing' }
  const fixture = maintenanceFixture({ initialJob: job }), timers = maintenanceTimers(), clicks = []
  const mounted = await mount({ fetch: fixture.fetchMock, render: false, document: maintenanceDocument(clicks), timers })
  const Component = readinessComponent(mounted.exports)
  const tree = await renderPanel(Component, mounted.host, fixture.fetchMock)
  assert.ok(textOf(tree).includes('readiness.bridge.phase.installing'))
  fixture.setOffline(true)
  await timers.run()
  const disconnected = await renderPanel(Component, mounted.host, fixture.fetchMock)
  assert.ok(textOf(disconnected).includes('readiness.bridge.phase.installing'), 'a disconnect preserves progress')
  assert.equal(elements(disconnected).some(node => node.props.key === 'bridge-error'), false)
  fixture.setOffline(false)
  for (const phase of ['restarting', 'verifying', 'completed']) {
    fixture.setJob({ ...job, phase, ...(phase === 'completed' ? { ok: true, restarted: true } : {}) })
    await timers.run()
    const next = await renderPanel(Component, mounted.host, fixture.fetchMock)
    assert.ok(textOf(next).includes(phase === 'completed' ? 'readiness.bridge.installedDone' : 'readiness.bridge.phase.' + phase))
  }
  assert.deepEqual(clicks, [], 'resume never repeats the native-menu handoff')
  assert.equal(fixture.calls.some(call => call.init.method === 'POST'), false)
  assert.equal(timers.pending.size, 0)
})

test('a fresh panel recovers a completed job without rearming maintenance', async () => {
  const fixture = maintenanceFixture({ state: 'installed', initialJob: { id: 'completed-before-mount', action: 'install', phase: 'completed', ok: true, restarted: true } })
  const timers = maintenanceTimers(), clicks = []
  const mounted = await mount({ fetch: fixture.fetchMock, render: false, document: maintenanceDocument(clicks), timers })
  const tree = await renderPanel(readinessComponent(mounted.exports), mounted.host, fixture.fetchMock)
  assert.ok(textOf(tree).includes('readiness.bridge.installedDone'))
  assert.equal(bridgeButton(tree, 'readiness.bridge.reinstall').props.disabled, false)
  assert.equal(fixture.calls.some(call => call.init.method === 'POST'), false)
  assert.deepEqual(clicks, [])
  assert.equal(timers.pending.size, 0)
})

for (const phase of ['failed', 'cancelled']) {
  test(`a ${phase} job exposes details only in diagnostics and enables retry`, async () => {
    const detail = 'worker diagnostic '.repeat(150)
    const fixture = maintenanceFixture({ initialJob: { id: 'finished', action: 'install', phase, error: detail, output: 'worker output' } }), timers = maintenanceTimers()
    const mounted = await mount({ fetch: fixture.fetchMock, render: false, document: maintenanceDocument(), timers })
    const Component = readinessComponent(mounted.exports)
    const tree = await renderPanel(Component, mounted.host, fixture.fetchMock)
    const alert = elements(tree).find(node => node.props.key === 'bridge-job-error')
    assert.deepEqual(textOf(alert), ['readiness.bridge.' + phase])
    const diagnostics = elements(tree).find(node => node.props.key === 'diagnostics')
    assert.ok(textOf(diagnostics).join(' ').includes(detail))
    assert.equal(bridgeButton(tree, 'readiness.bridge.install').props.disabled, false)
    assert.equal(elements(tree).some(node => node.props.key === 'bridge-result'), false)
    assert.equal(timers.pending.size, 0)
  })
}

for (const { name, error, output, expected } of [
  { name: 'a wrapped copy of worker output', output: 'worker waited 88.8s for the Desktop to close', error: 'Error: worker waited 88.8s for the Desktop to close', expected: 'Error: worker waited 88.8s for the Desktop to close' },
  { name: 'distinct worker output and recovery failure', output: 'bridge files were restored', error: 'recovery could not restart the Desktop', expected: 'recovery could not restart the Desktop\nbridge files were restored' },
]) {
  test(`maintenance diagnostics retain ${name} without duplicate output`, async () => {
    const fixture = maintenanceFixture({ initialJob: { id: 'diagnostic', action: 'install', phase: 'failed', error, output } })
    const mounted = await mount({ fetch: fixture.fetchMock, render: false, document: maintenanceDocument(), timers: maintenanceTimers() })
    const tree = await renderPanel(readinessComponent(mounted.exports), mounted.host, fixture.fetchMock)
    const detail = elements(tree).find(node => node.props.key === 'bridge-job-detail')
    assert.deepEqual(textOf(detail), [expected])
    assert.equal(textOf(detail).join('').split(output).length - 1, 1, 'the complete worker output appears once')
  })
}

test('an idle settings panel reads maintenance once without polling or opening the menu', async () => {
  const fixture = maintenanceFixture(), timers = maintenanceTimers(), clicks = []
  const mounted = await mount({ fetch: fixture.fetchMock, render: false, document: maintenanceDocument(clicks), timers })
  await renderPanel(readinessComponent(mounted.exports), mounted.host, fixture.fetchMock)
  assert.equal(fixture.calls.filter(call => call.path.endsWith('/bridge-maintenance')).length, 1)
  assert.equal(timers.pending.size, 0)
  assert.deepEqual(clicks, [])
})
