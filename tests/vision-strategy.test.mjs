// The visual / non-visual strategy (requirements §7).
//
// A coordinate click exists only because somebody read a picture. Under the
// non-visual strategy the provider must refuse one and say what to do instead —
// silently honouring a guessed coordinate is the failure mode this guards against.
// Semantic targeting must keep working in both strategies: the whole point is that
// nothing a model could do without images is lost.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_SETTINGS } from '../lib/browser-electron/settings-store.js'
import { ElectronBrowserProvider } from '../lib/browser-electron/provider.js'

/** Host stub: enough of a view for clicks to reach the coordinate branch. */
function makeHost() {
  const commands = []
  return {
    commands,
    createView() {
      return {
        id: 'view1',
        async sendCommand(method, params) {
          commands.push({ method, params })
          if (method === 'Runtime.evaluate') {
            const expression = params.expression ?? ''
            if (expression.includes('timeOrigin')) return { result: { value: '1|complete' } }
            if (expression.includes('document.title')) return { result: { value: 'https://example.com/\u0000Example' } }
            if (expression.includes('getBoundingClientRect')) {
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

/** A provider reading the given settings. */
function providerWith(strategy, host = makeHost()) {
  const settings = { ...DEFAULT_SETTINGS, vision: { strategy } }
  return { p: new ElectronBrowserProvider(host, { settings: () => settings }), host }
}

test('the non-visual strategy refuses a coordinate click', async () => {
  const { p } = providerWith('nonVisual')
  const sid = await p.open()
  await assert.rejects(
    () => p.click(sid, { x: 10, y: 20 }),
    (error) => {
      // The message must be actionable: it names the replacement, not just the rule.
      assert.match(String(error.message), /non-visual/i)
      assert.match(String(error.message), /semantic target/i)
      assert.equal(error.code, 'BROWSER_NON_VISUAL_COORDINATES')
      return true
    },
  )
})

test('the non-visual strategy still honours a semantic target', async () => {
  const { p, host } = providerWith('nonVisual')
  const sid = await p.open()
  await p.click(sid, { target: { by: 'text', value: 'Sign in' } })
  assert.ok(
    host.commands.some(c => c.method === 'Input.dispatchMouseEvent'),
    'the clicked coordinate came from the located element, not from the caller',
  )
})

test('the default (auto) strategy accepts a coordinate click', async () => {
  const { p, host } = providerWith('auto')
  const sid = await p.open()
  await p.click(sid, { x: 10, y: 20 })
  const mouse = host.commands.filter(c => c.method === 'Input.dispatchMouseEvent')
  assert.ok(mouse.length > 0, 'the click was dispatched')
  assert.ok(
    mouse.some(c => c.params.x === 10 && c.params.y === 20),
    'the caller coordinates were used as given',
  )
})
