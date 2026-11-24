// Synthetic pointer feedback: the generated in-page overlay script, the point
// the provider paints at, and the switch that turns it off.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'

import { cursorScript, forgetCursor, paintCursor } from '../lib/browser-electron/virtual-cursor.js'
import { DEFAULT_SETTINGS } from '../lib/browser-electron/settings-store.js'
import { ElectronBrowserProvider } from '../lib/browser-electron/provider.js'

/** Host stub that records every expression the provider evaluates. */
function makeHost() {
  const expressions = []
  let counter = 0
  return {
    expressions,
    createView() {
      return {
        id: `view${++counter}`,
        async sendCommand(method, params) {
          if (method === 'Page.navigate') { counter += 0; return {} }
          if (method === 'Input.dispatchMouseEvent') return {}
          if (method === 'Runtime.evaluate') {
            const expression = params.expression ?? ''
            expressions.push(expression)
            if (expression.includes('__dsh_agent_cursor__')) return { result: { value: true } }
            if (expression.includes('timeOrigin')) return { result: { value: '1|complete' } }
            if (expression.includes('document.title')) return { result: { value: 'https://example.com/\u0000Example' } }
            if (expression.includes('getBoundingClientRect')) {
              // What a located element reports: its viewport center.
              return { result: { value: { ok: true, x: 40, y: 50, __point: { x: 40, y: 50 } } } }
            }
            return { result: { value: { ok: true } } }
          }
          return {}
        },
      }
    },
    destroyView() {}, showView() {}, groupView() {}, onUserAction() {},
  }
}

test('the overlay script moves the pointer and pulses only on click', () => {
  const move = cursorScript(12, 34, 'move')
  const click = cursorScript(12, 34, 'click')

  assert.ok(move.includes('translate(12px, 34px)'), 'position is applied')
  assert.ok(move.includes('__dsh_agent_cursor__'), 'stable element id')
  assert.equal(move.includes('.animate('), false, 'a move does not pulse')
  assert.ok(click.includes('.animate('), 'a click pulses the ripple')
  assert.ok(click.includes('pointer-events:none'), 'the overlay never swallows page input')
  assert.ok(click.includes('2147483647'), 'the cursor stacks above page content')
})

test('the overlay script is idempotent: it reuses the existing node', () => {
  const script = cursorScript(1, 2, 'move')
  assert.ok(script.includes('getElementById'), 'looks for an existing node first')
  assert.ok(script.includes('if (!root)'), 'only creates when missing')
})

test('the overlay uses a closed shadow root and moves an inner stage without mutating the host node', () => {
  const nodes = new Map()
  let shadowMode
  const animations = []
  const stage = { style: { transform: '' } }
  const ripple = { animate: (frames, opts) => { animations.push(['ripple', frames, opts]) } }
  const bubble = { textContent: '', style: {}, animate: (frames, opts) => { animations.push(['bubble', frames, opts]) } }
  const shadow = {
    innerHTML: '',
    querySelector: selector => {
      if (selector === '[data-dsh-role="stage"]') return stage
      if (selector === '[data-dsh-role="ripple"]') return ripple
      if (selector === '[data-dsh-role="bubble"]') return bubble
      return null
    },
  }
  const hostStyleWrites = []
  const makeElement = () => {
    let cssText = ''
    const element = {
      id: '',
      innerHTML: '',
      shadowRoot: null,
      attrs: {},
      style: {
        get cssText() { return cssText },
        set cssText(value) { cssText = value; hostStyleWrites.push(['cssText', value]) },
        set transform(value) { hostStyleWrites.push(['transform', value]) },
      },
      setAttribute(name, value) { this.attrs[name] = value },
      attachShadow(init) {
        shadowMode = init.mode
        if (init.mode === 'open') this.shadowRoot = shadow
        return shadow
      },
    }
    return element
  }
  const document = {
    body: { appendChild(node) { nodes.set(node.id, node); return node } },
    getElementById: id => nodes.get(id) ?? null,
    createElement: () => makeElement(),
  }
  const ctx = vm.createContext({ document })

  vm.runInContext(cursorScript(40, 50, 'click', 'click'), ctx)
  const root = nodes.get('__dsh_agent_cursor__')
  assert.ok(root, 'host node is appended to body')
  assert.equal(shadowMode, 'closed', 'closed shadow root keeps deep-DOM walkers out of cursor markup')
  assert.equal(root.shadowRoot, null, 'open shadowRoot is not exposed to markdown/findText/anti-bot walkers')
  assert.equal(root.innerHTML, '', 'light DOM of host stays empty')
  assert.equal(stage.style.transform, 'translate(40px, 50px)')
  assert.equal(bubble.textContent, 'click')

  const writesAfterCreate = hostStyleWrites.length
  vm.runInContext(cursorScript(90, 120, 'click', 'type'), ctx)
  assert.equal(hostStyleWrites.length, writesAfterCreate, 'moving the pointer never mutates host style attributes')
  assert.equal(stage.style.transform, 'translate(90px, 120px)')
  assert.equal(bubble.textContent, 'type')
  assert.equal(animations.filter(([kind]) => kind === 'ripple').length, 2)
})

test('a click paints the cursor at the located element center', async () => {
  const host = makeHost()
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open()
  await p.click(sid, { target: { by: 'css', value: '#submit' } })

  const painted = host.expressions.filter(expression => expression.includes('__dsh_agent_cursor__'))
  assert.equal(painted.length, 1, 'painted exactly once per click')
  assert.ok(painted[0].includes('translate(40px, 50px)'), 'painted at the element center')
  assert.ok(painted[0].includes('.animate('), 'a click pulses')
  await p.close(sid)
})

test('a DOM-level action also shows where it landed', async () => {
  const host = makeHost()
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open()
  await p.setValue(sid, { target: { by: 'css', value: '#name' }, value: 'Ada' })

  const painted = host.expressions.filter(expression => expression.includes('__dsh_agent_cursor__'))
  assert.equal(painted.length, 1, 'a value write is visible too')
  assert.ok(painted[0].includes('translate(40px, 50px)'))
  await p.close(sid)
})

test('the cursor can be switched off, and nothing is painted then', async () => {
  const host = makeHost()
  const settings = { ...DEFAULT_SETTINGS, ui: { ...DEFAULT_SETTINGS.ui, virtualCursor: false } }
  const p = new ElectronBrowserProvider(host, { settings: () => settings })
  const sid = await p.open()
  await p.click(sid, { target: { by: 'css', value: '#submit' } })

  assert.equal(host.expressions.filter(e => e.includes('__dsh_agent_cursor__')).length, 0)
  await p.close(sid)
})

// A single tool call emits several CDP commands, and the pointer is repainted for
// each one that moves it. Repainting to the same pixel is a wasted round-trip and a
// visible stutter, so an unchanged position is skipped — but only until the document
// is replaced, because the overlay lived in the old document and is gone with it.
test('an unchanged position is not repainted, and a new document resets that', () => {
  const handle = { id: 'view' }
  const painted = []
  const evaluate = (_handle, expression) => { painted.push(expression); return Promise.resolve(true) }

  paintCursor(handle, 10, 20, 'move', evaluate)
  assert.equal(painted.length, 1, 'the first paint happens')

  paintCursor(handle, 10, 20, 'move', evaluate)
  assert.equal(painted.length, 1, 'an identical position is skipped')

  paintCursor(handle, 30, 40, 'move', evaluate)
  assert.equal(painted.length, 2, 'a new position paints')

  // A click must always show its ripple, even at the position it already occupies.
  paintCursor(handle, 30, 40, 'click', evaluate, undefined, true)
  assert.equal(painted.length, 3, 'a forced paint ignores the cache')

  forgetCursor(handle)
  paintCursor(handle, 10, 20, 'move', evaluate)
  assert.equal(painted.length, 4, 'after a navigation the pointer is drawn again')
})

test('the pointer overlay changes neither the page fingerprint nor its text in real Chromium', {
  skip: !process.env.DSH_TEST_CHROME && 'set DSH_TEST_CHROME to a Chromium executable',
}, async t => {
  const { chromiumPage } = await import('./fixtures/chromium-page.mjs')
  const { pageFingerprint } = await import('../lib/tool-browser/probe-client.js')
  const chrome = await chromiumPage(t)
  await chrome.evaluate(`document.body.innerHTML = '<form><input name="a"><button>Submit order</button></form>'; true`)
  const browser = { execute: async (_session, { script }) => ({ ok: true, value: await chrome.evaluate(script) }) }
  const before = await pageFingerprint(browser, 's')
  await chrome.evaluate(cursorScript(40, 50, 'click', 'click'))
  await chrome.evaluate(`(() => { window.__cursorMut = 0; new MutationObserver(records => { window.__cursorMut += records.length }).observe(document.documentElement, { subtree: true, childList: true, attributes: true }); return true })()`)
  await chrome.evaluate(cursorScript(90, 120, 'click', 'type'))
  assert.equal(await pageFingerprint(browser, 's'), before)
  assert.equal(await chrome.evaluate('document.body.innerText.trim()'), 'Submit order')
  assert.equal(await chrome.evaluate(`document.getElementById('__dsh_agent_cursor__').shadowRoot`), null, 'closed shadow root is invisible to deep-DOM walkers')
  assert.equal(await chrome.evaluate(`document.getElementById('__dsh_agent_cursor__')[Symbol.for('__dsh_agent_cursor_shadow__')].querySelector('[data-dsh-role="bubble"]').textContent`), 'type')
  assert.equal(await chrome.evaluate('window.__cursorMut'), 0, 'subsequent cursor moves trigger zero top-document mutations')
})
