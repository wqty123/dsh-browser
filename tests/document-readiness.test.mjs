import { test } from 'node:test'
import assert from 'node:assert/strict'
import { documentReady, mainDocument } from '../lib/browser-electron/document-readiness.js'

const frame = { id: 'main', loaderId: 'document-one', url: 'https://example.com/' }

test('document identity requires a main frame and loader and rejects network error documents', () => {
  assert.deepEqual(mainDocument({ frameTree: { frame } }), frame)
  for (const value of [undefined, {}, { frameTree: {} }, { frameTree: { frame: { ...frame, loaderId: '' } } }]) {
    assert.throws(() => mainDocument(value), { code: 'BROWSER_DOCUMENT_UNACKNOWLEDGED' })
  }
  assert.throws(() => mainDocument({ frameTree: { frame: { ...frame, unreachableUrl: frame.url } } }), { code: 'BROWSER_NAVIGATION_FAILED' })
})

function handle(value, after = frame) {
  return { async sendCommand(method, params, options) {
    assert.deepEqual(options, { present: false, initialize: false })
    if (method === 'Page.createIsolatedWorld') {
      assert.equal(params.frameId, frame.id)
      return { executionContextId: 42 }
    }
    if (method === 'Runtime.evaluate') {
      assert.equal(params.contextId, 42)
      assert.equal(params.expression, 'document.readyState')
      return { result: { value } }
    }
    if (method === 'Page.getFrameTree') return { frameTree: { frame: after } }
    throw new Error(method)
  } }
}

test('only interactive or complete in the acknowledged document is ready', async () => {
  for (const value of ['interactive', 'complete']) assert.equal(await documentReady(handle(value), frame), true)
  assert.equal(await documentReady(handle('loading'), frame), false)
  for (const value of ['unknown', '', undefined, { ok: true }]) {
    await assert.rejects(documentReady(handle(value), frame), { code: 'BROWSER_DOCUMENT_UNACKNOWLEDGED' })
  }
})

test('a loader replaced during evaluation cannot acknowledge readiness', async () => {
  await assert.rejects(documentReady(handle('complete', { ...frame, loaderId: 'document-two' }), frame), { code: 'BROWSER_NAVIGATION_SUPERSEDED' })
})

test('missing execution contexts and evaluation exceptions fail explicitly', async () => {
  const missing = handle('complete')
  const send = missing.sendCommand
  missing.sendCommand = (method, params, options) => method === 'Page.createIsolatedWorld' ? {} : send(method, params, options)
  await assert.rejects(documentReady(missing, frame), { code: 'BROWSER_DOCUMENT_UNACKNOWLEDGED' })
  const failed = handle('complete')
  failed.sendCommand = (method, params, options) => method === 'Runtime.evaluate'
    ? { exceptionDetails: { text: 'execution context destroyed' } } : send(method, params, options)
  await assert.rejects(documentReady(failed, frame), { code: 'BROWSER_DOCUMENT_UNACKNOWLEDGED' })
})
