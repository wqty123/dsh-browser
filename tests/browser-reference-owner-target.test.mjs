// R01/R02: real session ownership, right-click target kinds and the wire format
// between the native menu, the provider and the page capture script.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  resolveReferenceOwner, createDeliveryQueue,
} from '../lib/browser-reference/delivery.js'
import { referenceMenuTemplate } from '../lib/browser-reference/entry.js'
import { BrowserReferenceService } from '../lib/browser-reference/service.js'
import { ReferenceStore } from '../lib/browser-reference/store.js'
import { captureScript } from '../lib/browser-reference/page-script.js'
import { createReferenceRouteHandlers } from '../lib/browser-electron/reference-route.js'

// ---------------------------------------------------------------- R01 ownership

test('R01: a browser:<uuid> window is never the DSH conversation id', () => {
  const owner = resolveReferenceOwner('dsh-session-A', 'browser:4f1c')
  assert.deepEqual(owner, { sessionId: 'dsh-session-A', browserSessionId: 'browser:4f1c' })
  assert.notEqual(owner.sessionId, owner.browserSessionId)
  assert.ok(owner.sessionId.startsWith('dsh-'))
  // An older host that cannot read the conversation still records the view id.
  assert.deepEqual(resolveReferenceOwner(undefined, 'browser:4f1c'),
    { sessionId: 'browser:4f1c', browserSessionId: 'browser:4f1c' })
})

test('R01: A/B captures stay in their own conversation even when the user switches', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-owner-'))
  try {
    const queue = createDeliveryQueue({ path: join(root, 'd.jsonl') })
    const a = resolveReferenceOwner('dsh-session-A', 'browser:view-A')
    const b = resolveReferenceOwner('dsh-session-B', 'browser:view-B')
    const reference = (id, owner) => ({
      version: 1, provider: 'dsh-browser', referenceId: id,
      owner, provenance: { origin: 'user-selection', entry: 'native-menu' },
      source: { pageUrl: 'https://example.com/a', title: 'A', capturedAt: '2026-11-08T00:00:00.000Z', carrier: 'bundled' },
      parts: [{ partId: 'p1', type: 'text', text: '网页正文内容', anchor: { exact: '网页正文内容', prefix: '', suffix: '' } }],
      manifestHash: 'c'.repeat(64),
    })
    queue.prepare(reference('ref-A', a))
    queue.prepare(reference('ref-B', b))
    // The user switched to B mid-capture: A's delivery is still only A's.
    assert.deepEqual(queue.list({ sessionId: 'dsh-session-A' }).deliveries.map(x => x.referenceId), ['ref-A'])
    assert.deepEqual(queue.list({ sessionId: 'dsh-session-B' }).deliveries.map(x => x.referenceId), ['ref-B'])
    assert.equal(queue.list({ sessionId: 'browser:view-A' }).deliveries.length, 0)
    queue.dispose()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- R02 menu

test('R02: an image right-click gets its own action; ordinary edit roles are untouched', () => {
  const menu = referenceMenuTemplate({ hasSelection: true, mediaType: 'image' })
  const actions = menu.filter(item => item.kind === 'reference')
  assert.deepEqual(actions.map(item => item.target), ['text', 'image', 'table'])
  assert.deepEqual(actions.map(item => item.label), ['引用选中的文字', '引用这张图片', '引用选中的表格'])
  assert.deepEqual(menu.filter(item => item.kind === 'role').map(item => item.role),
    ['copy', 'cut', 'paste', 'selectAll'])
  assert.equal(menu.filter(item => item.kind === 'separator').length, 1, 'still ONE menu, one popup')
  assert.equal(new Set(menu.map(item => item.id)).size, menu.length)
})

test('R02: a plain text right-click offers no image action', () => {
  const actions = referenceMenuTemplate({ hasSelection: true }).filter(item => item.kind === 'reference')
  assert.deepEqual(actions.map(item => item.target), ['text', 'table'])
  assert.equal(referenceMenuTemplate().filter(item => item.kind === 'reference').length, 1)
})

// ---------------------------------------------------------------- R02 wire format

function targetFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-target-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const calls = []
  const host = {
    exists: id => id === 'session-1',
    evaluate: async (_sessionId, request) => {
      calls.push(request)
      return JSON.stringify({ ok: true, url: 'https://example.com/page', title: 'Page', events: [
        { kind: 'text', exact: '一段真实正文', prefix: '', suffix: '' },
      ] })
    },
  }
  const service = new BrowserReferenceService(host, new ReferenceStore(join(directory, 'r.jsonl')),
    { assetDir: join(directory, 'assets') })
  return { service, calls }
}

test('R02: the native target reaches the real capture script arguments', async t => {
  const { service, calls } = targetFixture(t)
  const target = { kind: 'image', srcUrl: 'https://example.com/chart.png', x: 120, y: 240 }
  const outcome = await service.capture({ sessionId: 'session-1', target })
  assert.ok(outcome.reference, 'a target capture still commits a reference')
  const request = calls.find(call => call.script === captureScript())
  assert.ok(request, 'the top-document capture script ran')
  assert.deepEqual(request.args[0].target, target, 'the target travels all the way to the page')
  assert.equal(typeof request.args[0].context, 'number')
})

test('R02: an explicit table target and an explicit text target are both forwarded', async t => {
  const { service, calls } = targetFixture(t)
  await service.capture({ sessionId: 'session-1', target: { kind: 'table', x: 10, y: 20 } })
  await service.capture({ sessionId: 'session-1', target: { kind: 'text' } })
  const targets = calls.filter(call => call.script === captureScript()).map(call => call.args[0].target)
  assert.deepEqual(targets, [{ kind: 'table', x: 10, y: 20 }, { kind: 'text' }])
})

const WRITE_HEADERS = {
  host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080',
  'sec-fetch-site': 'same-origin', 'content-type': 'application/json',
}
function request(body) {
  return {
    method: 'POST', url: '/', headers: WRITE_HEADERS,
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(body)) },
    destroy() {},
  }
}
function response() {
  const state = { status: 0, payload: undefined }
  return { state, writeHead(status) { state.status = status }, end(text) { state.payload = text === undefined ? undefined : JSON.parse(text) } }
}

test('R02: the HTTP capture path validates a target before it reaches the page', async () => {
  const seen = []
  const capturedReference = {
    version: 1, provider: 'dsh-browser', referenceId: 'r1',
    owner: { sessionId: 'session-1', browserSessionId: 'browser:4f1c' },
    provenance: { origin: 'user-selection', entry: 'native-menu' },
    source: { pageUrl: 'https://example.com/page', title: 'Page', capturedAt: '2026-11-08T00:00:00.000Z', carrier: 'bundled' },
    parts: [{ partId: 'p1', type: 'text', text: '一段真实正文', anchor: { exact: '一段真实正文', prefix: '', suffix: '' } }],
    manifestHash: 'd'.repeat(64),
  }
  const handlers = createReferenceRouteHandlers({
    service: {
      capture: async req => { seen.push(req); return { reference: capturedReference, failures: [] } },
      list: () => [], get: () => undefined, exportBundle: () => ({}), assetPath: () => undefined,
    },
    queue: { prepare: () => ({ state: 'prepared' }), requiredAssets: () => [] },
  })
  const badKind = response()
  await handlers.capture(request({ sessionId: 'session-1', target: { kind: 'script' } }), badKind)
  assert.equal(badKind.state.status, 400)
  const badPoint = response()
  await handlers.capture(request({ sessionId: 'session-1', target: { kind: 'image', x: 'NaN' } }), badPoint)
  assert.equal(badPoint.state.status, 400)
  assert.equal(seen.length, 0, 'no invalid target reaches the browser')

  const good = response()
  await handlers.capture(request({
    sessionId: 'session-1', browserSessionId: 'browser:4f1c',
    target: { kind: 'image', srcUrl: 'https://example.com/chart.png', x: 12, y: 34 },
  }), good)
  assert.equal(good.state.status, 200)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].browserSessionId, 'browser:4f1c')
  assert.deepEqual(seen[0].target, { kind: 'image', srcUrl: 'https://example.com/chart.png', x: 12, y: 34 })
})

// ------------------------------------------------------- three-state §3 comment

test('three-state §3: the comment is stored beside the snapshot and never hashed', async t => {
  // Build the service inline so this file stays independent of the other suite.
  const { mkdtempSync: mk, rmSync: rm } = await import('node:fs')
  const { tmpdir: tmp } = await import('node:os')
  const { join: j } = await import('node:path')
  const { BrowserReferenceService } = await import('../lib/browser-reference/service.js')
  const { ReferenceStore, manifestHashOf } = await import('../lib/browser-reference/store.js')

  const directory = mk('dsh-comment-')
  t.after(() => rm(directory, { recursive: true, force: true }))
  const host = {
    evaluate: async () => JSON.stringify({
      ok: true, url: 'https://example.com/a', title: 'An article',
      events: [{ kind: 'text', exact: '被引用的正文', prefix: '', suffix: '' }],
    }),
    exists: () => true,
  }
  const service = new BrowserReferenceService(host, new ReferenceStore(j(directory, 'r.jsonl')), {
    assetDir: j(directory, 'assets'),
  })

  const withComment = await service.capture({
    sessionId: 'dsh-A', origin: 'user-selection', entry: 'page-overlay',
    comment: '  请对比这一段与第二节  ',
  })
  assert.ok(withComment.reference, 'capture committed')
  assert.equal(withComment.reference.comment, '请对比这一段与第二节', 'trimmed note is kept verbatim')
  // The note is an annotation, not page content: the capture hash is unchanged.
  assert.equal(withComment.reference.manifestHash, manifestHashOf(withComment.reference))

  const without = await service.capture({
    sessionId: 'dsh-A', origin: 'user-selection', entry: 'page-overlay',
  })
  assert.equal(without.reference.comment, undefined, 'an empty note adds no field')

  // An over-long note is cut at the shared bound instead of being rejected.
  const huge = await service.capture({
    sessionId: 'dsh-A', origin: 'user-selection', entry: 'page-overlay', comment: 'y'.repeat(5000),
  })
  assert.equal(huge.reference.comment.length, 2000)

  // The delivery snapshot carries the note to the host card.
  const queue = createDeliveryQueue({ path: j(directory, 'd.jsonl') })
  queue.prepare(withComment.reference)
  const listed = queue.list({ sessionId: 'dsh-A' }).deliveries
  assert.equal(listed.length, 1)
  assert.equal(listed[0].snapshot.comment, '请对比这一段与第二节')
  queue.dispose()
})

test('R03: "add to conversation" enqueues a real delivery instead of a dead adapter', async () => {
  const prepared = []
  const stored = {
    version: 1, provider: 'dsh-browser', referenceId: 'ref-queue',
    owner: { sessionId: 'dsh-A', browserSessionId: 'browser:7a' },
    provenance: { origin: 'user-selection', entry: 'page-overlay' },
    source: { pageUrl: 'https://example.com/a', title: 'A', capturedAt: '2026-11-08T00:00:00.000Z', carrier: 'bundled' },
    parts: [{ partId: 'p1', type: 'text', text: '正文', anchor: { exact: '正文', prefix: '', suffix: '' } }],
    manifestHash: 'e'.repeat(64),
  }
  const handlers = createReferenceRouteHandlers({
    service: {
      capture: async () => ({ failures: [] }),
      list: () => [], get: id => (id === 'ref-queue' ? stored : undefined),
      exportBundle: () => ({}), assetPath: () => undefined,
    },
    queue: {
      prepare: reference => {
        prepared.push(reference)
        return { intentId: 'intent-1', state: 'prepared' }
      },
      requiredAssets: () => [],
    },
  })

  const ok = response()
  await handlers.insert(request({ referenceId: 'ref-queue' }), ok)
  assert.equal(ok.state.status, 200)
  assert.equal(ok.state.payload.intentId, 'intent-1', 'the client ACKs by intent id')
  assert.equal(prepared.length, 1)
  assert.equal(prepared[0].referenceId, 'ref-queue')

  const missing = response()
  await handlers.insert(request({ referenceId: 'nope' }), missing)
  assert.equal(missing.state.status, 404)
})
