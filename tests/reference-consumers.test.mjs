import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ElectronBrowserProvider } from '../lib/browser-electron/provider.js'
import { setReferenceCaptureActionHandler, dispatchReferenceCaptureAction } from '../lib/browser-reference/service.js'

const intent = {
  type: 'dsh-browser-ref:intent', selectionText: 'first quote',
  capture: { ok: true, url: 'https://example.test/article', events: [{ kind: 'text', text: 'first quote' }] },
}

test('dispatch refuses a missing reference capture handler', async () => {
  await assert.rejects(dispatchReferenceCaptureAction({ windowId: 'missing', entry: 'page-overlay' }), /handler is unavailable/)
})

for (const mode of ['success', 'empty', 'refused', 'missing handler', 'invalid channel', 'invalid capture', 'closed session']) {
  test(`provider submits a taken intent or visibly refuses it: ${mode}`, async () => {
    const queue = mode === 'empty' ? [] : [mode === 'invalid channel' ? { ...intent, type: 'foreign' }
      : mode === 'invalid capture' ? { ...intent, capture: {} } : intent]
    const notices = []
    const received = []
    const provider = new ElectronBrowserProvider({
      createView() { throw new Error('unexpected new view') }, destroyView() {},
    }, { history: { enabled: false } })
    provider.stopReferenceEntryPump()
    const tab = { id: 'tab', url: intent.capture.url, handle: {
      id: 'guest', async sendCommand(method, params) {
        assert.equal(method, 'Runtime.evaluate')
        if (params.expression.includes('__dshRefTake')) return { result: { value: queue.shift() ?? null } }
        assert.match(params.expression, /__dsh-ref-notice/)
        notices.push(params.expression)
        return { result: { value: true } }
      },
    } }
    const session = { id: 'browser:consumer-test', tabs: [tab], activeIndex: 0, history: [], nextSeq: 1 }
    if (mode !== 'closed session') provider.sessions.set(session.id, session)
    const stop = mode === 'missing handler' ? () => {} : setReferenceCaptureActionHandler(async action => {
      if (mode === 'refused') throw new Error('capture refused by service')
      received.push(action)
    })
    try {
      await provider.pumpOneTab(session, tab)
      assert.equal(queue.length, 0)
      assert.equal(received.length, mode === 'success' ? 1 : 0)
      assert.equal(notices.length, mode === 'success' || mode === 'empty' ? 0 : 1)
      if (mode === 'success') {
        assert.equal(received[0].windowId, session.id)
        assert.deepEqual(received[0].capture, intent.capture)
      } else if (mode !== 'empty') {
        assert.match(provider.referenceStatus().lastError, /capture refused:/)
      }
    } finally { stop(); provider.dispose() }
  })
}
