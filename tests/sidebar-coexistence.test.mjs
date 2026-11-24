// Issue #107: dsh-builtin-browser's client entry must coexist with DSH's built-in
// @deepseek-ai/dsh-client-ui-sidebar-browser without colliding on locale namespace
// ("sidebarBrowser"/zh), sidebarRightTabs id/band, keyed slot keys, or "browser.new" shortcut.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { clientBundle } from './helpers/client-build.mjs'

function loadBuiltClientPlugin() {
  const source = clientBundle()
  const styles = []
  const storage = new Map()
  const createStyleNode = () => ({
    attrs: {},
    textContent: '',
    setAttribute(name, value) { this.attrs[name] = String(value) },
    getAttribute(name) { return this.attrs[name] ?? null },
    remove() {},
  })
  const sandbox = {
    console,
    URL,
    AbortController,
    AbortSignal,
    crypto,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    fetch: async () => ({ ok: false }),
    location: { href: 'http://127.0.0.1:3080/', origin: 'http://127.0.0.1:3080', replace() {} },
    sessionStorage: {
      getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => { storage.set(key, String(value)) },
      removeItem: key => { storage.delete(key) },
    },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      createElement: () => createStyleNode(),
      head: {
        appendChild: node => { styles.push(node); return node },
        append: (...nodes) => { styles.push(...nodes) },
        querySelector: () => null,
        querySelectorAll: () => [],
      },
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener() {},
      removeEventListener() {},
    },
    addEventListener() {},
    removeEventListener() {},
  }
  sandbox.window = sandbox
  sandbox.globalThis = sandbox
  sandbox.self = sandbox
  let factory
  sandbox.__ModuleLoader__ = { load: entry => { factory = entry.factory } }

  vm.runInNewContext(source, sandbox, { filename: 'dist/client.cjs' })
  assert.equal(typeof factory, 'function', 'dist/client.cjs registers a ModuleLoader factory')

  const chainable = new Proxy(function stub() { return chainable }, {
    get(_target, prop) {
      if (prop === Symbol.toPrimitive) return () => ''
      if (prop === 'then') return undefined
      return chainable
    },
    apply() { return chainable },
  })
  const createSnapshotStore = initial => {
    let value = initial
    const listeners = new Set()
    return {
      getSnapshot: () => value,
      set: next => { value = next; for (const listener of listeners) listener() },
      subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener) } },
    }
  }
  const externals = {
    '@deepseek-ai/dsh-client-store': { createSnapshotStore, defineStore: spec => spec },
    zod: { z: chainable },
  }
  const plugin = factory(id => externals[id] ?? chainable)
  assert.equal(typeof plugin.apply, 'function')
  return { plugin, createSnapshotStore }
}

/** Strict host stub reproducing DSH's locale, tab-registry, shortcut and keyed-slot collision rules. */
function makeStrictHost(createSnapshotStore, { withBuiltInSidebarBrowser = false } = {}) {
  const dicts = new Map()
  const tabsById = new Set()
  const tabsByKind = new Map()
  const shortcuts = new Map()
  const keyedSlots = new Map()
  const disposers = []

  const locale = {
    register(ns, dictsOrLocale, singleDict) {
      const pairs = typeof dictsOrLocale === 'string'
        ? [[dictsOrLocale, singleDict]]
        : Object.entries(dictsOrLocale)
      let bucket = dicts.get(ns)
      if (!bucket) { bucket = new Map(); dicts.set(ns, bucket) }
      for (const [id] of pairs) {
        const key = id.toLowerCase()
        if (bucket.has(key)) throw new Error(`locale namespace "${ns}" already has locale "${id}"`)
      }
      for (const [id, dict] of pairs) bucket.set(id.toLowerCase(), dict)
      return () => { for (const [id] of pairs) bucket.delete(id.toLowerCase()) }
    },
    bind(ns) {
      return key => dicts.get(ns)?.get('zh')?.[key] ?? key
    },
  }

  const sidebarRightTabs = {
    register(definition) {
      const band = definition.priority ?? 'extension'
      if (tabsById.has(definition.id)) {
        throw new Error(`sidebarRight: tab type id "${definition.id}" is already registered`)
      }
      const held = tabsByKind.get(definition.kind)
      if (held !== undefined) {
        const canCoexist = band !== 'fallback' && held.inForce.band !== 'fallback'
          && held.inForce.band !== band && held.shadowed === undefined
        if (!canCoexist) {
          throw new Error(`sidebarRight: tab kind "${definition.kind}" is already registered (${held.inForce.band})`)
        }
        const entry = { definition, band }
        if (band === 'extension') {
          held.shadowed = held.inForce
          held.inForce = entry
        } else {
          held.shadowed = entry
        }
      } else {
        tabsByKind.set(definition.kind, { inForce: { definition, band }, shadowed: undefined })
      }
      tabsById.add(definition.id)
      return () => {
        tabsById.delete(definition.id)
        const slot = tabsByKind.get(definition.kind)
        if (!slot) return
        if (slot.inForce.definition === definition) {
          if (slot.shadowed) { slot.inForce = slot.shadowed; slot.shadowed = undefined }
          else tabsByKind.delete(definition.kind)
        } else if (slot.shadowed?.definition === definition) {
          slot.shadowed = undefined
        }
      }
    },
    get(kind) { return tabsByKind.get(kind)?.inForce.definition },
  }

  const shortcutsService = {
    register(command) {
      if (shortcuts.has(command.id)) throw new Error(`Duplicate shortcut command: ${command.id}`)
      shortcuts.set(command.id, command)
      return () => { if (shortcuts.get(command.id) === command) shortcuts.delete(command.id) }
    },
  }

  const slots = {
    inject(_name, run) { return run() },
    register(spec, component) {
      if (spec.key !== undefined) {
        const slotKey = `${spec.name}::${spec.key}`
        if (keyedSlots.has(slotKey)) throw new Error(`Duplicate keyed slot: ${slotKey}`)
        keyedSlots.set(slotKey, { spec, component })
        return () => { keyedSlots.delete(slotKey) }
      }
      return () => {}
    },
  }

  if (withBuiltInSidebarBrowser) {
    locale.register('sidebarBrowser', { zh: { 'type.label': '浏览器' }, en: { 'type.label': 'Browser' } })
    sidebarRightTabs.register({
      id: '@deepseek-ai/dsh-client-ui-sidebar-browser',
      kind: 'browser',
      priority: 'builtin',
      title: () => 'Browser',
    })
    shortcutsService.register({ id: 'browser.new', defaults: {}, regions: ['page'], modals: [], resolve: () => ({ status: 'pass' }) })
    slots.register({ name: 'sidebar.right.pane.tab', key: '@deepseek-ai/dsh-client-ui-sidebar-browser', locale: 'sidebarBrowser' }, () => null)
    slots.register({ name: 'sidebar.right.pane.tab.title', key: '@deepseek-ai/dsh-client-ui-sidebar-browser' }, () => null)
  }

  const services = {
    locale,
    slots,
    sidebarRightTabs,
    sidebarRight: {
      openTabs: createSnapshotStore([]),
      commandTarget: () => undefined,
      openTabFromTarget() {},
      openTabIn() {},
      focus() {},
    },
    shortcuts: shortcutsService,
    contextMenus: { register: () => () => {} },
    configForms: {
      get: () => ({
        getSnapshot: () => ({ status: 'ready', value: undefined, revision: 0 }),
        subscribe: () => () => {},
        update: async () => ({ ok: true }),
      }),
    },
    uiConversation: { events: { register: () => () => {} } },
  }

  const ctx = {
    ...services,
    effect(run) {
      const cleanup = run()
      if (typeof cleanup === 'function') disposers.push(cleanup)
      return cleanup
    },
    inject(names, callback) {
      if (names.every(name => services[name] !== undefined)) callback(ctx)
    },
    provide() {},
    set(name, value) { services[name] = value; ctx[name] = value },
    get(name) { return services[name] },
  }

  return {
    ctx,
    dicts,
    sidebarRightTabs,
    shortcuts,
    keyedSlots,
    dispose: () => { for (const fn of disposers.splice(0).reverse()) fn() },
  }
}

test('issue #107: client plugin coexists cleanly when DSH built-in ui-sidebar-browser is also active', t => {
  const { plugin, createSnapshotStore } = loadBuiltClientPlugin()
  const host = makeStrictHost(createSnapshotStore, { withBuiltInSidebarBrowser: true })
  t.after(() => host.dispose())

  assert.doesNotThrow(() => plugin.apply(host.ctx))

  assert.ok(host.dicts.has('dshBuiltinBrowser.sidebar'), 'uses a plugin-owned locale namespace')
  assert.ok(host.dicts.get('dshBuiltinBrowser.sidebar').has('zh'))
  assert.ok(host.dicts.get('dshBuiltinBrowser.sidebar').has('en'))

  const active = host.sidebarRightTabs.get('browser')
  assert.equal(active.id, 'dsh-builtin-browser', 'extension definition takes over the browser kind')
  assert.equal(active.priority, 'extension')

  assert.ok(host.keyedSlots.has('sidebar.right.pane.tab::dsh-builtin-browser'))
  assert.equal(host.keyedSlots.get('sidebar.right.pane.tab::dsh-builtin-browser').spec.locale, 'dshBuiltinBrowser.sidebar')
  assert.ok(host.keyedSlots.has('sidebar.right.pane.tab.title::dsh-builtin-browser'))

  assert.ok(host.shortcuts.has('browser.new'), 'built-in browser.new shortcut remains registered')
  assert.ok(host.shortcuts.has('browser.address'), 'plugin-owned browser.address shortcut is registered')

  // Unloading our plugin cleanly restores DSH's built-in browser tab.
  host.dispose()
  assert.equal(host.sidebarRightTabs.get('browser').id, '@deepseek-ai/dsh-client-ui-sidebar-browser')
})

test('client plugin registers browser.new and browser.address when built-in ui-sidebar-browser is disabled', t => {
  const { plugin, createSnapshotStore } = loadBuiltClientPlugin()
  const host = makeStrictHost(createSnapshotStore, { withBuiltInSidebarBrowser: false })
  t.after(() => host.dispose())

  assert.doesNotThrow(() => plugin.apply(host.ctx))
  assert.equal(host.sidebarRightTabs.get('browser').id, 'dsh-builtin-browser')
  assert.ok(host.shortcuts.has('browser.new'))
  assert.ok(host.shortcuts.has('browser.address'))
})
