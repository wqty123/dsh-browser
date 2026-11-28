// Issue #140: a screenshot whose native capture describes another surface must not reach the caller.
//
// Measured on a real machine: the page reported a 1254×707 layout viewport, while the native capture
// answered 231×960 — same document (a magenta background set through `execute` was in the image), but
// laid out at a different size. The capture describes the VIEW, and that view is not always the
// page's own surface. The aspect ratio is the DPR-independent test, so a mismatch falls back to a CDP
// clip of the layout viewport instead of returning a mobile-layout picture.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ElectronBrowserProvider } from '../lib/browser-electron/provider.js'
import { DEFAULT_SETTINGS } from '../lib/browser-electron/settings-store.js'

const VIEWPORT = { cssLayoutViewport: { width: 1254, height: 707 }, cssContentSize: { width: 1254, height: 1500 } }

/** A self-hosted view: it has `capture` (the native path) and answers CDP commands. */
function makeHost(nativeSize) {
  const sent = []
  const view = {
    id: 'view1',
    async capture() {
      return { base64: Buffer.from('native').toString('base64'), mime: 'image/png', width: nativeSize.width, height: nativeSize.height }
    },
    async sendCommand(method, params, options) {
      sent.push({ method, params, options })
      if (method === 'Runtime.evaluate') {
        const expression = params?.expression ?? ''
        if (expression.includes('timeOrigin')) return { result: { value: '1|complete' } }
        if (expression.includes('document.title')) return { result: { value: 'about:blank\u0000Example' } }
        return { result: { value: { ok: true } } }
      }
      if (method === 'Page.getLayoutMetrics') return VIEWPORT
      if (method === 'Page.captureScreenshot') return { data: Buffer.from('cdp').toString('base64') }
      return {}
    },
  }
  return {
    sent,
    createView() { return view },
    destroyView() {},
    groupView() {},
    onUserAction() {},
    showView() {},
    async presentView() {},
  }
}

test('a native capture that disagrees with the page viewport is replaced by a CDP viewport clip', async () => {
  const host = makeHost({ width: 231, height: 960 })
  const provider = new ElectronBrowserProvider(host, { settings: () => DEFAULT_SETTINGS })
  const session = await provider.open()
  host.sent.length = 0
  await provider.screenshot(session)
  const shot = host.sent.find(entry => entry.method === 'Page.captureScreenshot')
  assert.ok(shot !== undefined, 'the mismatched native image is not returned; the page is re-captured')
  assert.deepEqual(shot.params.clip, { x: 0, y: 0, width: 1254, height: 707, scale: 1 })
})

test('a native capture that matches the page viewport is kept', async () => {
  const host = makeHost({ width: 1254, height: 707 })
  const provider = new ElectronBrowserProvider(host, { settings: () => DEFAULT_SETTINGS })
  const session = await provider.open()
  host.sent.length = 0
  const shot = await provider.screenshot(session)
  assert.equal(host.sent.some(entry => entry.method === 'Page.captureScreenshot'), false, 'no second capture for a right one')
  assert.equal(typeof shot.dataUrl, 'string')
})

test('a capture with a different device scale factor but the same shape is kept', async () => {
  const host = makeHost({ width: 2508, height: 1414 })
  const provider = new ElectronBrowserProvider(host, { settings: () => DEFAULT_SETTINGS })
  const session = await provider.open()
  host.sent.length = 0
  await provider.screenshot(session)
  assert.equal(host.sent.some(entry => entry.method === 'Page.captureScreenshot'), false, 'aspect ratio is the test, not pixel equality')
})
