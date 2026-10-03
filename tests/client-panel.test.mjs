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
  }
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
  }
  exports.apply(ctx)
  assert.ok(registration !== undefined, 'apply() registered a settings section')
  assert.equal(registration.spec.name, 'settings.section')

  const tree = await renderPanel(registration.Component, host)
  return { tree, host, exports, registration }
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
