// Synthetic pointer feedback: the generated in-page overlay script, the point
// the provider paints at, and the switch that turns it off.
import { test } from 'node:test'
import assert from 'node:assert/strict'

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
