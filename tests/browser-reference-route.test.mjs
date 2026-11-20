// The reference HTTP surface: write boundaries, validation, and status mapping.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createReferenceRouteHandlers } from '../lib/browser-electron/reference-route.js'

const SAME_ORIGIN = {
  host: '127.0.0.1:3080',
  origin: 'http://127.0.0.1:3080',
  'sec-fetch-site': 'same-origin',
  'content-type': 'application/json',
}

function request({ method = 'GET', url = '/', headers = {}, body = '' } = {}) {
  return {
    method,
    url,
    headers,
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      if (body !== '') yield Buffer.isBuffer(body) ? body : Buffer.from(body)
    },
    destroy() {},
  }
}

function response() {
  const state = { status: 0, payload: undefined, headers: undefined }
  return {
    state,
    writeHead(status, headers) { state.status = status; state.headers = headers },
    end(text) { state.payload = text === undefined ? undefined : JSON.parse(text) },
  }
}

const reference = {
  version: 1,
  provider: 'dsh-browser',
  referenceId: 'ref-1',
  owner: { sessionId: 'session-1', browserSessionId: 'browser-1' },
  provenance: { origin: 'user-selection', entry: 'page-overlay' },
  source: { pageUrl: 'https://example.com/a', title: 'A', capturedAt: '2026-11-07T00:00:00.000Z', carrier: 'bundled' },
  parts: [{ partId: 'p1', type: 'text', text: 'quoted', anchor: { exact: 'quoted', prefix: '', suffix: '' } }],
  manifestHash: 'f'.repeat(64),
}

function service(overrides = {}) {
  return {
    list: () => [reference],
    get: id => id === 'ref-1' ? reference : undefined,
    capture: async () => ({ reference, failures: [] }),
    reveal: async () => ({ referenceId: 'ref-1', status: 'revealed', pageUrl: reference.source.pageUrl, parts: [] }),
    insertIntoDraft: async () => ({ ok: false, reason: 'draft-adapter-unavailable' }),
    ...overrides,
  }
}

test('list answers newest first with summaries, never full parts', async () => {
  const handlers = createReferenceRouteHandlers({ service: service() })
  const reply = response()
  await handlers.list(request({ url: '/dsh-builtin-browser/reference/list?limit=5' }), reply)
  assert.equal(reply.state.status, 200)
  assert.equal(reply.state.payload.references.length, 1)
  assert.equal(reply.state.payload.references[0].partCount, 1)
  assert.equal(reply.state.payload.references[0].parts[0].preview, 'quoted')
  assert.equal(reply.state.payload.references[0].parts[0].anchor, undefined)
})

test('get needs an id and reports a miss as 404', async () => {
  const handlers = createReferenceRouteHandlers({ service: service() })
  const missing = response()
  await handlers.get(request({ url: '/dsh-builtin-browser/reference/get' }), missing)
  assert.equal(missing.state.status, 400)
  const absent = response()
  await handlers.get(request({ url: '/dsh-builtin-browser/reference/get?id=none' }), absent)
  assert.equal(absent.state.status, 404)
  const found = response()
  await handlers.get(request({ url: '/dsh-builtin-browser/reference/get?id=ref-1' }), found)
  assert.equal(found.state.status, 200)
  assert.equal(found.state.payload.reference.referenceId, 'ref-1')
})

test('capture is a write: a cross-origin caller and a non-loopback peer are both refused', async () => {
  const handlers = createReferenceRouteHandlers({ service: service() })
  const body = JSON.stringify({ sessionId: 'session-1' })
  const crossOrigin = response()
  await handlers.capture(request({
    method: 'POST',
    headers: { ...SAME_ORIGIN, origin: 'http://evil.example' },
    body,
  }), crossOrigin)
  assert.equal(crossOrigin.state.status, 403)

  const forwarded = request({ method: 'POST', headers: { ...SAME_ORIGIN, 'x-forwarded-for': '10.0.0.1' }, body })
  const forwardedReply = response()
  await handlers.capture(forwarded, forwardedReply)
  assert.equal(forwardedReply.state.status, 403)

  const wrongMethod = response()
  await handlers.capture(request({ method: 'GET', headers: SAME_ORIGIN }), wrongMethod)
  assert.equal(wrongMethod.state.status, 405)
})

test('capture validates the session and the enumerated fields', async () => {
  const handlers = createReferenceRouteHandlers({ service: service() })
  const noSession = response()
  await handlers.capture(request({ method: 'POST', headers: SAME_ORIGIN, body: '{}' }), noSession)
  assert.equal(noSession.state.status, 400)

  const badOrigin = response()
  await handlers.capture(request({
    method: 'POST',
    headers: SAME_ORIGIN,
    body: JSON.stringify({ sessionId: 'session-1', origin: 'somewhere-else' }),
  }), badOrigin)
  assert.equal(badOrigin.state.status, 400)
})

test('a refused capture is 422 with the failures a caller can show', async () => {
  const handlers = createReferenceRouteHandlers({
    service: service({ capture: async () => ({ failures: [{ kind: 'image', reason: 'image-unavailable' }] }) }),
  })
  const reply = response()
  await handlers.capture(request({ method: 'POST', headers: SAME_ORIGIN, body: JSON.stringify({ sessionId: 'session-1' }) }), reply)
  assert.equal(reply.state.status, 422)
  assert.deepEqual(reply.state.payload.failures, [{ kind: 'image', reason: 'image-unavailable' }])
})

test('a committed capture answers with the summary and any partial failures', async () => {
  const handlers = createReferenceRouteHandlers({
    service: service({ capture: async () => ({ reference, failures: [{ kind: 'image', reason: 'image-unavailable' }] }) }),
  })
  const reply = response()
  await handlers.capture(request({ method: 'POST', headers: SAME_ORIGIN, body: JSON.stringify({ sessionId: 'session-1' }) }), reply)
  assert.equal(reply.state.status, 200)
  assert.equal(reply.state.payload.reference.referenceId, 'ref-1')
  assert.equal(reply.state.payload.failures.length, 1)
})

test('a capture whose delivery enqueue fails is NOT reported as a success', async () => {
  // The reference is already durable; without a queue record the client can
  // never poll it. A 200 here used to produce a card that silently never
  // appeared, with no status anywhere for the user or the agent.
  const handlers = createReferenceRouteHandlers({
    service: service(),
    queue: { prepare: () => { throw new Error('disk full') } },
  })
  const reply = response()
  await handlers.capture(request({ method: 'POST', headers: SAME_ORIGIN, body: JSON.stringify({ sessionId: 'session-1' }) }), reply)
  assert.equal(reply.state.status, 409)
  assert.equal(reply.state.payload.error, 'delivery-enqueue-failed')
  assert.equal(reply.state.payload.ok, false)
  assert.equal(reply.state.payload.reference.referenceId, 'ref-1')
})

test('deliveries refuses a malformed cursor instead of replaying all history', async () => {
  const queue = tempQueue()
  queue.prepare(ownedReference('ref-1', 'session-1'))
  const handlers = createReferenceRouteHandlers({ service: service(), queue })
  for (const since of ['abc', 'Infinity', '-1', '1e309', '2.5']) {
    const reply = response()
    await handlers.deliveries(request({ url: `/dsh-builtin-browser/reference/deliveries?sessionId=session-1&since=${since}` }), reply)
    assert.equal(reply.state.status, 400, `since=${since}`)
    assert.equal(reply.state.payload.error, 'invalid since')
  }
  const first = response()
  await handlers.deliveries(request({ url: '/dsh-builtin-browser/reference/deliveries?sessionId=session-1' }), first)
  assert.equal(first.state.status, 200)
  assert.equal(first.state.payload.deliveries.length, 1)
})

test('reveal maps every outcome to a readable 200 body', async () => {
  const handlers = createReferenceRouteHandlers({
    service: service({ reveal: async () => ({ referenceId: 'ref-1', status: 'page-mismatch', pageUrl: 'a', currentUrl: 'b', parts: [] }) }),
  })
  const reply = response()
  await handlers.reveal(request({ method: 'POST', headers: SAME_ORIGIN, body: JSON.stringify({ referenceId: 'ref-1' }) }), reply)
  assert.equal(reply.state.status, 200)
  assert.equal(reply.state.payload.status, 'page-mismatch')
})

test('insert reports the reserved adapter as a conflict, not a crash', async () => {
  const handlers = createReferenceRouteHandlers({ service: service() })
  const reply = response()
  await handlers.insert(request({ method: 'POST', headers: SAME_ORIGIN, body: JSON.stringify({ referenceId: 'ref-1' }) }), reply)
  assert.equal(reply.state.status, 409)
  assert.equal(reply.state.payload.reason, 'draft-adapter-unavailable')
})

function binaryResponse() {
  const state = { status: 0, headers: undefined, payload: undefined }
  return {
    state,
    writeHead(status, headers) { state.status = status; state.headers = headers },
    end(buffer) { state.payload = buffer },
  }
}

test('export serves the requested format with a bounded file name', async () => {
  const seen = []
  const handlers = createReferenceRouteHandlers({
    service: service({
      exportBundle: options => {
        seen.push(options)
        return { fileName: 'refs.jsonl', mime: 'application/x-ndjson', body: Buffer.from('{"id":1}\n') }
      },
    }),
  })
  const reply = binaryResponse()
  await handlers.export(request({ url: '/dsh-builtin-browser/reference/export?format=jsonl&sessionId=session-1' }), reply)
  assert.equal(reply.state.status, 200)
  assert.equal(reply.state.headers['content-type'], 'application/x-ndjson')
  assert.equal(reply.state.headers['content-disposition'], 'attachment; filename="refs.jsonl"')
  assert.equal(reply.state.payload.toString('utf8'), '{"id":1}\n')
  assert.deepEqual(seen, [{ format: 'jsonl', sessionId: 'session-1' }])

  const invalid = binaryResponse()
  await handlers.export(request({ url: '/dsh-builtin-browser/reference/export?format=pdf' }), invalid)
  assert.equal(invalid.state.status, 400)
})

// Import is a write with the same boundaries as capture/insert. Success paths are covered in
// browser-reference-import.test.mjs against temporary stores: a route test must never import into
// the real DSH_HOME library, so these cases all fail BEFORE any filesystem write.
const { createZip } = await import('../lib/browser-reference/export.js')
const IMPORT_ROUTE = '/dsh-builtin-browser/reference/import'

test('import is a write: cross-origin, forwarded and wrong-method callers are refused', async () => {
  const handlers = createReferenceRouteHandlers({ service: service() })
  const zip = Buffer.from('not a zip')
  const crossOrigin = response()
  await handlers.importBundle(request({
    method: 'POST',
    headers: { ...SAME_ORIGIN, origin: 'http://evil.example', 'content-type': 'application/zip' },
    body: zip,
  }), crossOrigin)
  assert.equal(crossOrigin.state.status, 403)
  assert.equal(crossOrigin.state.payload.error, 'not-same-origin')

  const forwarded = response()
  await handlers.importBundle(request({
    method: 'POST',
    headers: { ...SAME_ORIGIN, 'x-forwarded-for': '10.0.0.1', 'content-type': 'application/zip' },
    body: zip,
  }), forwarded)
  assert.equal(forwarded.state.status, 403)

  const wrongMethod = response()
  await handlers.importBundle(request({ method: 'GET', headers: SAME_ORIGIN }), wrongMethod)
  assert.equal(wrongMethod.state.status, 405)
})

test('a malformed or documentation-only package is a 400 with a readable reason', async () => {
  const handlers = createReferenceRouteHandlers({ service: service() })
  const headers = { ...SAME_ORIGIN, 'content-type': 'application/zip' }

  const junk = response()
  await handlers.importBundle(request({ method: 'POST', headers, body: Buffer.from('not a zip') }), junk)
  assert.equal(junk.state.status, 400)
  assert.match(junk.state.payload.error, /unreadable reference package/)

  const docsOnly = response()
  await handlers.importBundle(request({
    method: 'POST', headers,
    body: createZip([
      { name: 'references.jsonl', data: '' },
      { name: 'references.md', data: '# notes' },
    ]),
  }), docsOnly)
  assert.equal(docsOnly.state.status, 400)
  assert.match(docsOnly.state.payload.error, /no manifest\.json/)
})

// --- delivery routes: session scoping and the remove tombstone -----------------

import { createDeliveryQueue } from '../lib/browser-reference/delivery.js'
import { createSubmissionReceipts } from '../lib/browser-reference/submission-receipts.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function tempQueue() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-ref-route-'))
  return createDeliveryQueue({ path: join(dir, 'reference-deliveries.jsonl') })
}

function ownedReference(referenceId, sessionId) {
  return { ...reference, referenceId, owner: { ...reference.owner, sessionId } }
}

test('the accepted Session request retires only its bound references across Host and client restarts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ref-accepted-'))
  const rpc = 'ab536ce4-8fd1-4070-a3ca-2ac9302b250a'
  const events = []
  let live = { events }
  const start = () => {
    const queue = createDeliveryQueue({ path: join(root, 'deliveries.jsonl') })
    const receipts = createSubmissionReceipts(queue, () => live, join(root, 'receipts'))
    return { queue, receipts, handlers: createReferenceRouteHandlers({ service: service(), queue, receipts }) }
  }
  let host = start()
  host.queue.prepare(ownedReference('ref-bound', 'owner'))
  host.queue.prepare(ownedReference('ref-stays', 'owner'))
  const bind = async (sessionId, ids) => {
    const result = response()
    await host.handlers.ack(request({ method: 'POST', headers: SAME_ORIGIN,
      body: JSON.stringify({ phase: 'submitting', requestId: rpc, sessionId, intentIds: ids }) }), result)
    return result.state.status
  }
  assert.equal(await bind('wrong', ['ref-bound']), 409)
  assert.equal(await bind('owner', ['ref-bound']), 200)
  assert.equal(await bind('owner', ['ref-stays']), 409)
  const event = { type: 'agent/inbox/spliced', data: { inserted: [{ source: { kind: 'user', rpcId: rpc } }] } }
  host.receipts.observe('wrong', event)
  assert.equal(host.queue.get('ref-bound').state, 'prepared')
  host.queue.dispose()
  events.push(event)
  live = undefined
  host = start()
  const read = async () => {
    const reply = response()
    await host.handlers.deliveries(request({ url: '/?sessionId=owner&includeConsumed=1' }), reply)
    return reply.state.payload
  }
  assert.deepEqual((await read()).unverified, ['ref-bound'])
  live = { events }
  const recovered = await read()
  assert.deepEqual(recovered.unverified, [])
  assert.equal(recovered.deliveries.find(d => d.referenceId === 'ref-bound').state, 'consumed')
  assert.equal(recovered.deliveries.find(d => d.referenceId === 'ref-stays').state, 'prepared')
  assert.equal((await read()).sequence, recovered.sequence)
  host.queue.dispose()
})

test('deliveries refuses to answer without a session id', async () => {
  // Answering an unscoped poll would hand every conversation's records to the
  // caller, and the client advances its cursor for whatever it receives.
  const queue = tempQueue()
  queue.prepare(ownedReference('ref-1', 'session-1'))
  const handlers = createReferenceRouteHandlers({ service: service(), queue })
  const reply = response()
  await handlers.deliveries(request({ url: '/dsh-builtin-browser/reference/deliveries' }), reply)
  assert.equal(reply.state.status, 400)
  assert.equal(reply.state.payload.error, 'sessionId is required')
})

test('deliveries returns only the asking conversation\'s records', async () => {
  const queue = tempQueue()
  queue.prepare(ownedReference('ref-a', 'session-a'))
  queue.prepare(ownedReference('ref-b', 'session-b'))
  const handlers = createReferenceRouteHandlers({ service: service(), queue })

  const mine = response()
  await handlers.deliveries(request({ url: '/dsh-builtin-browser/reference/deliveries?sessionId=session-a' }), mine)
  assert.equal(mine.state.status, 200)
  assert.deepEqual(mine.state.payload.deliveries.map(record => record.referenceId), ['ref-a'])
})

test('insert after a removal reports the tombstone instead of a silent success', async () => {
  const queue = tempQueue()
  const referenceOne = ownedReference('ref-1', 'session-1')
  queue.prepare(referenceOne)
  queue.remove('ref-1')
  const handlers = createReferenceRouteHandlers({ service: service(), queue })
  const reply = response()
  await handlers.insert(request({
    method: 'POST',
    url: '/dsh-builtin-browser/reference/insert',
    headers: SAME_ORIGIN,
    body: JSON.stringify({ referenceId: 'ref-1' }),
  }), reply)
  assert.equal(reply.state.status, 409)
  assert.equal(reply.state.payload.reason, 'reference-was-removed')
})
