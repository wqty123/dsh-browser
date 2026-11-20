import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

/**
 * Regression for issue #11: the toolbar script used to start with
 * `const bridge = window.bridge`. The preload exposes that global with
 * contextBridge.exposeInMainWorld(), which defines it as NON-CONFIGURABLE, and
 * a top-level const/let of the same name is then a parse-time SyntaxError
 * (HasRestrictedGlobalProperty). Early errors discard the whole script, so the
 * toolbar rendered but every binding was missing: address bar Enter, the four
 * nav buttons and the tab strip were all dead, with nothing reported to the
 * user. The fix binds the handle in function scope (`tb`) inside an IIFE.
 *
 * This test runs the real toolbar script out of the shipped lib/ against a stub
 * DOM, in a VM context whose globals are installed exactly the way
 * contextBridge does — so the collision, if it ever comes back, fails here
 * instead of in the user's browser window.
 */

const HOST_MAIN = fileURLToPath(new URL('../lib/browser-electron/host-main.js', import.meta.url))

/**
 * Resolve a `const NAME = \`...\`` template literal out of host-main.js as the
 * string the JS engine would produce. host-main.js cannot be imported here (it
 * requires Electron and starts the child-side RPC loop), so the shipped source
 * text is resolved the same way the engine resolves it.
 */
function readTemplate(source, name) {
  const marker = `const ${name} = \``
  const start = source.indexOf(marker)
  assert.notEqual(start, -1, `${name} not found in the shipped lib/browser-electron/host-main.js`)
  const from = start + marker.length
  const end = source.indexOf('`', from)
  assert.notEqual(end, -1, `${name} template literal is unterminated`)
  const raw = source.slice(from, end)
  assert.ok(!raw.includes('${'), `${name} template literal must not be interpolated`)
  assert.equal(source[end + 1], ';', `${name} template literal must end with a backtick + semicolon`)
  // eslint-disable-next-line no-new-func
  return new Function(`return \`${raw}\``)()
}

const HOST_MAIN_SOURCE = readFileSync(HOST_MAIN, 'utf8')
const TOOLBAR_PRELOAD = readTemplate(HOST_MAIN_SOURCE, 'TOOLBAR_PRELOAD')
const TOOLBAR_HTML = readTemplate(HOST_MAIN_SOURCE, 'TOOLBAR_HTML')

/** Globals the preload injects into the toolbar page. */
const EXPOSED_GLOBALS = [...TOOLBAR_PRELOAD.matchAll(/exposeInMainWorld\(\s*'([^']+)'/g)].map(m => m[1])

const SCRIPT_START = '<script>'
const SCRIPT_END = '</script>'
const TOOLBAR_SCRIPT = (() => {
  const start = TOOLBAR_HTML.indexOf(SCRIPT_START)
  const end = TOOLBAR_HTML.lastIndexOf(SCRIPT_END)
  assert.ok(start !== -1 && end > start, 'toolbar html must contain an inline script')
  return TOOLBAR_HTML.slice(start + SCRIPT_START.length, end)
})()

/**
 * Names declared with const/let/class in the script's GLOBAL scope (the only
 * scope the restricted-global check applies to; function-scoped declarations
 * are exempt, which is why wrapping the body in an IIFE fixes the collision).
 *
 * Brace depth is used as a scope approximation — enough for a small script,
 * and it skips strings and comments so their contents cannot confuse it.
 */
function globalScopeDeclarationNames(script) {
  const names = []
  let depth = 0
  for (let i = 0; i < script.length; i += 1) {
    const ch = script[i]
    if (ch === '/' && script[i + 1] === '/') {
      i = script.indexOf('\n', i)
      if (i === -1) break
      continue
    }
    if (ch === '/' && script[i + 1] === '*') {
      const close = script.indexOf('*/', i + 2)
      i = close === -1 ? script.length : close + 1
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      for (i += 1; i < script.length; i += 1) {
        if (script[i] === '\\') i += 1
        else if (script[i] === ch) break
      }
      continue
    }
    if (ch === '{') { depth += 1; continue }
    if (ch === '}') { depth -= 1; continue }
    if (depth !== 0) continue
    const match = /^(?:const|let|class)\s+([A-Za-z_$][\w$]*)/.exec(script.slice(i))
    const atBoundary = i === 0 || /[\s;{}(]/.test(script[i - 1])
    if (match && atBoundary) {
      names.push(match[1])
      i += match[0].length - 1
    }
  }
  return names
}

const GLOBAL_SCOPE_DECLARATIONS = globalScopeDeclarationNames(TOOLBAR_SCRIPT)

/** A DOM element stub covering everything the toolbar script touches. */
function makeElement(tagName = 'div') {
  let text = ''
  const el = {
    tagName,
    className: '',
    title: '',
    value: '',
    children: [],
    onclick: null,
    listeners: new Map(),
    blurred: 0,
    showClass: false,
    propagationStopped: false,
    classList: {
      add: cls => { if (cls === 'show') el.showClass = true },
      remove: cls => { if (cls === 'show') el.showClass = false },
    },
    addEventListener(type, fn) {
      const list = el.listeners.get(type) || []
      list.push(fn)
      el.listeners.set(type, list)
    },
    appendChild(child) {
      el.children.push(child)
      return child
    },
    blur() {
      el.blurred += 1
    },
    /** Dispatch a synthetic event to the addEventListener handlers. */
    fire(type, event = {}) {
      for (const fn of el.listeners.get(type) || []) fn(event)
    },
    /** Invoke the element's onclick the way a real click would. */
    click() {
      if (typeof el.onclick === 'function') el.onclick({ stopPropagation: () => { el.propagationStopped = true } })
    },
  }
  // Assigning textContent in a browser wipes children; the toolbar relies on
  // that when it rebuilds the tab strip.
  Object.defineProperty(el, 'textContent', {
    get: () => text,
    set: value => {
      text = String(value)
      el.children.length = 0
    },
    enumerable: true,
  })
  return el
}

/**
 * Build a toolbar page: stub DOM, stub preload bridge, and global properties
 * defined the way contextBridge.exposeInMainWorld does them (non-configurable,
 * non-writable). Returns the page plus the recorded user actions.
 */
function startToolbar({ restrictedGlobals = [...new Set([...EXPOSED_GLOBALS, ...GLOBAL_SCOPE_DECLARATIONS])] } = {}) {
  const actions = []
  const elements = new Map()
  const timers = new Map()
  let timerSeq = 0

  const element = id => {
    if (!elements.has(id)) elements.set(id, makeElement('div'))
    return elements.get(id)
  }

  const bridge = {
    // The payload objects come from the VM realm, so they would fail
    // deepStrictEqual against this realm's objects on prototype identity alone;
    // round-tripping through JSON compares just the data.
    post: (action, payload) => actions.push(JSON.parse(JSON.stringify({ action, payload: payload || {} }))),
    onTabs: cb => { bridge.tabsHandler = cb },
    onError: cb => { bridge.errorHandler = cb },
  }

  const sandbox = {
    document: {
      activeElement: null,
      getElementById: element,
      createElement: tag => makeElement(tag),
    },
    setTimeout: fn => { const id = (timerSeq += 1); timers.set(id, fn); return id },
    clearTimeout: id => timers.delete(id),
  }
  for (const name of EXPOSED_GLOBALS) sandbox[name] = bridge
  sandbox.window = sandbox

  const context = vm.createContext(sandbox)
  // Install the globals from INSIDE the context, mirroring contextBridge: a
  // property that exists on the sandbox object is not enough — it has to be
  // non-configurable as seen by the context's global object for the parse-time
  // SyntaxError to trigger.
  for (const name of restrictedGlobals) {
    const key = JSON.stringify(name)
    vm.runInContext(
      `Object.defineProperty(globalThis, ${key}, { value: globalThis[${key}], writable: false, enumerable: true, configurable: false })`,
      context,
    )
  }
  vm.runInContext(TOOLBAR_SCRIPT, context, { filename: 'toolbar.html' })

  return {
    actions,
    bridge,
    element,
    /** Run the pending setTimeout callbacks (the error bar's auto-hide). */
    runTimers: () => {
      const pending = [...timers.values()]
      timers.clear()
      for (const fn of pending) fn()
    },
  }
}

test('the toolbar script parses and wires itself up under contextBridge globals', () => {
  // The guard is only meaningful while the preload actually injects something.
  assert.ok(EXPOSED_GLOBALS.length > 0, 'the toolbar preload must expose at least one global')

  const page = startToolbar()

  // The whole point: the parse-time SyntaxError used to leave every one of
  // these unwired.
  const back = page.element('back')
  const fwd = page.element('fwd')
  const reload = page.element('reload')
  const newtab = page.element('newtab')
  const addr = page.element('addr')
  const strip = page.element('strip')

  assert.equal(addr.listeners.get('keydown')?.length, 1, 'address bar must have its Enter handler')
  for (const [label, el] of [['back', back], ['fwd', fwd], ['reload', reload], ['newtab', newtab]]) {
    assert.equal(typeof el.onclick, 'function', `${label} button must be wired`)
  }
  assert.equal(typeof page.bridge.tabsHandler, 'function', 'tab updates must be subscribed')
  assert.equal(typeof page.bridge.errorHandler, 'function', 'user-action errors must be subscribed')

  // Address bar: Enter navigates, empty input does not, and the field blurs.
  addr.value = '  '
  addr.fire('keydown', { key: 'Enter' })
  assert.deepEqual(page.actions, [], 'empty address bar must not navigate')
  addr.value = 'example.com'
  addr.fire('keydown', { key: 'Enter' })
  assert.deepEqual(page.actions, [{ action: 'navigate', payload: { url: 'example.com' } }])
  assert.equal(addr.blurred, 1, 'address bar must blur after Enter')
  // Non-Enter keys are ignored.
  addr.fire('keydown', { key: 'a' })
  assert.equal(page.actions.length, 1)

  // Nav buttons.
  back.click()
  fwd.click()
  reload.click()
  assert.deepEqual(page.actions.slice(1), [
    { action: 'back', payload: {} },
    { action: 'forward', payload: {} },
    { action: 'reload', payload: {} },
  ])

  // New tab button: with a URL, then without one (and it clears the field).
  addr.value = 'https://new.test/'
  newtab.click()
  assert.deepEqual(page.actions.at(-1), { action: 'new-tab', payload: { url: 'https://new.test/' } })
  assert.equal(addr.value, '')
  newtab.click()
  assert.deepEqual(page.actions.at(-1), { action: 'new-tab', payload: {} })

  // Tab strip renders from the parent's tab model.
  page.bridge.tabsHandler({
    tabs: [
      { viewId: 'v1', title: 'First', url: 'https://first.test/', active: false },
      { viewId: 'v2', title: '', url: 'about:blank', active: true },
    ],
  })
  assert.equal(strip.children.length, 2, 'tab strip must render one row per tab')
  const [first, second] = strip.children
  assert.equal(first.className, 'tab')
  assert.equal(first.children[0].textContent, 'First')
  assert.equal(first.children[0].title, 'https://first.test/')
  assert.equal(second.className, 'tab active')
  assert.equal(second.children[0].textContent, 'New tab', 'blank title/url falls back to "New tab"')

  // Clicking a tab activates it; the close box closes it without activating.
  first.click()
  assert.deepEqual(page.actions.at(-1), { action: 'activate', payload: { viewId: 'v1' } })
  const closeBox = first.children[1]
  const beforeClose = page.actions.length
  closeBox.click()
  assert.deepEqual(page.actions.slice(beforeClose), [
    { action: 'close', payload: { viewId: 'v1' } },
  ], 'closing a tab must not also activate it')
  assert.equal(closeBox.propagationStopped, true, 'the close box stops the click from reaching the tab')

  // Re-rendering replaces the strip instead of appending to it.
  page.bridge.tabsHandler({ tabs: [{ viewId: 'v3', title: 'Only', url: 'https://only.test/', active: true }] })
  assert.equal(strip.children.length, 1)
  assert.equal(addr.value, 'https://only.test/', 'the active tab url lands in the address bar')

  // Errors from the parent surface in the toolbar and then auto-hide.
  page.bridge.errorHandler('boom')
  const err = page.element('err')
  assert.equal(err.textContent, 'boom')
  assert.equal(err.showClass, true)
  page.runTimers()
  assert.equal(err.showClass, false)
})

test('the toolbar harness reproduces the issue #11 failure mode', () => {
  // Guards the guard: with a non-configurable global installed the way
  // contextBridge does it, a top-level `const bridge` must still blow up with
  // the exact error users hit — otherwise this suite could pass while the bug
  // is back.
  const runWithRestrictedGlobal = (source, name) => {
    const sandbox = { window: null }
    sandbox.window = sandbox
    const context = vm.createContext(sandbox)
    const key = JSON.stringify(name)
    vm.runInContext(
      `Object.defineProperty(globalThis, ${key}, { value: {}, writable: false, enumerable: true, configurable: false })`,
      context,
    )
    vm.runInContext(source, context, { filename: 'toolbar.html' })
  }

  assert.throws(() => runWithRestrictedGlobal('const bridge = window.bridge', 'bridge'), /already been declared/)
  assert.doesNotThrow(() => runWithRestrictedGlobal('const tb = window.bridge', 'bridge'))
  assert.doesNotThrow(() => runWithRestrictedGlobal('(() => { const bridge = window.bridge })()', 'bridge'))
})

test('the toolbar script declares nothing in the global scope', () => {
  // The trap only applies to global-scope lexical declarations, so the toolbar
  // keeps its bindings inside an IIFE. Asserting that shape directly keeps the
  // guard above from silently becoming vacuous (e.g. if the preload stopped
  // exposing globals) and moves the failure next to its cause.
  assert.deepEqual(
    GLOBAL_SCOPE_DECLARATIONS,
    [],
    `toolbar script must not declare globals: ${GLOBAL_SCOPE_DECLARATIONS.join(', ')}`,
  )
})
