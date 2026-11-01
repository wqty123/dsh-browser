// Quiet mode (`ui.quiet`, issue #35): the agent works without taking the screen over.
//
// The contract in one line: presenting a view may still make it visible — Chromium drops
// synthesized `Input.*` for a view without a display surface — but it must not activate the
// application, steal keyboard focus, or restore a window the user minimized. The carrier half of
// that lives in `host-main.ts`; these tests pin the provider half, because a switch that stops at
// the settings file is indistinguishable from no switch at all: every presentation and capture
// call has to carry the decision, and a screenshot must not present the page at all.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_SETTINGS } from '../lib/browser-electron/settings-store.js'
import { ElectronBrowserProvider } from '../lib/browser-electron/provider.js'

/** Host stub: records how the provider asked for presentation and capture. */
function makeHost() {
  const seen = {
    showView: [],
    presentView: [],
    capture: [],
  }
  let loads = 0
  let current = 'about:blank'
  const view = {
    id: 'view1',
    async sendCommand(method, params) {
      if (method === 'Page.navigate') { loads += 1; current = params.url; return {} }
      if (method === 'Runtime.evaluate') {
        const expression = params.expression ?? ''
        if (expression.includes('timeOrigin')) return { result: { value: `${loads}|complete` } }
        if (expression.includes('document.title')) return { result: { value: `${current}\u0000Example` } }
        if (expression.includes('getBoundingClientRect')) {
          return { result: { value: { ok: true, x: 10, y: 20, __point: { x: 10, y: 20 } } } }
        }
        return { result: { value: { ok: true } } }
      }
      return {}
    },
    async capture(options) {
      seen.capture.push(options)
      return { base64: Buffer.from('image').toString('base64'), mime: 'image/png', width: 8, height: 8 }
    },
  }
  return {
    seen,
    createView() { return view },
    destroyView() {},
    groupView() {},
    onUserAction() {},
    showView(_handle, _label, options) { seen.showView.push(options) },
    async presentView(_handle, _label, options) { seen.presentView.push(options) },
  }
}

/**
 * A provider whose live settings the test can flip, the way the panel does.
 * @param quiet - initial value of `ui.quiet`.
 * @param host - the recording host, when a test wants a fresh one.
 */
function providerWith(quiet, host = makeHost()) {
  const settings = { ...DEFAULT_SETTINGS, ui: { ...DEFAULT_SETTINGS.ui, quiet } }
  const p = new ElectronBrowserProvider(host, { settings: () => settings })
  return {
    p,
    host,
    setQuiet(value) { settings.ui = { ...settings.ui, quiet: value } },
  }
}

test('with quiet mode off, presentation and capture keep the documented sharing behaviour', async () => {
  const { p, host } = providerWith(false)
  const sid = await p.open()
  await p.click(sid, { x: 10, y: 20 })
  await p.screenshot(sid)

  assert.deepEqual(host.seen.presentView.at(-1), { quiet: false }, 'input presents the view as before')
  assert.deepEqual(host.seen.showView.at(-1), { quiet: false }, 'showing keeps raising the window')
  assert.equal(host.seen.capture.at(-1).quiet, false, 'capture may still restore/raise the window')
})

test('quiet mode asks the carrier to present without raising', async () => {
  const { p, host } = providerWith(true)
  const sid = await p.open()
  // `open` legitimately presents the page it just created; only later operations are our subject.
  host.seen.presentView.length = 0
  host.seen.showView.length = 0

  await p.click(sid, { x: 10, y: 20 })

  assert.deepEqual(host.seen.presentView.at(-1), { quiet: true }, 'input still presents, but quietly')
  assert.deepEqual(host.seen.showView.at(-1), { quiet: true }, 'the follow-up show is quiet too')
})

test('quiet mode takes a screenshot without presenting the page at all', async () => {
  const { p, host } = providerWith(true)
  const sid = await p.open()
  host.seen.presentView.length = 0
  host.seen.showView.length = 0
  host.seen.capture.length = 0

  await p.screenshot(sid)

  assert.equal(host.seen.capture.at(-1).quiet, true, 'the carrier is told to capture without presenting')
  assert.equal(host.seen.showView.length, 0, 'a screenshot is not a reason to show or raise the window')
  assert.equal(host.seen.presentView.length, 0, 'nor to present it')
})

test('flipping the switch applies to the next operation, without a restart', async () => {
  const { p, host, setQuiet } = providerWith(false)
  const sid = await p.open()

  await p.click(sid, { x: 10, y: 20 })
  assert.deepEqual(host.seen.presentView.at(-1), { quiet: false })

  setQuiet(true)
  await p.click(sid, { x: 10, y: 20 })
  assert.deepEqual(host.seen.presentView.at(-1), { quiet: true }, 'the next call reads the live document')

  setQuiet(false)
  await p.screenshot(sid)
  assert.equal(host.seen.capture.at(-1).quiet, false, 'turning it back off restores the default path')
})
