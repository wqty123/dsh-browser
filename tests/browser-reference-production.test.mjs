// Production-shape integration: a REAL loopback HTTP server, REAL fetch calls,
// REAL image bytes on disk, and a REAL durable delivery log. This exercises the
// whole plugin-side path a DSH client will use:
//   capture -> deliveries(owner session) -> asset bytes -> draft+asset ACK
//   -> remove tombstone -> restart and restore.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createReferenceRouteHandlers } from '../lib/browser-electron/reference-route.js'
import { createDeliveryQueue } from '../lib/browser-reference/delivery.js'

const TEXT_A = '网页选区引用把用户看到的原文冻结下来：这一段跨越了段落、列表和引用块，'
  + '必须连同顺序一起进入当前会话的输入框，而不是只留下一个链接或一句提示。'
  + '模型需要看到真实文字，所以这里是一段足够长的正文，用来做逐字校验。HEAD-A'
const TEXT_B = '文字 B 位于图片与表格之后，用来检查混合选区的顺序是否被破坏。TAIL-B-END'
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c636000000200010005fe02fedcb7e40a0000000049454e44ae426082', 'hex')
const IMAGE_KEY = createHash('sha256').update(PNG).digest('hex')
const CELL_KEY = createHash('sha256').update('cell-image').digest('hex')

function captured(overrides = {}) {
  return {
    version: 1,
    provider: 'dsh-browser',
    referenceId: 'ref-http-1',
    owner: { sessionId: 'dsh-session-A', browserSessionId: 'browser:4a1' },
    provenance: { origin: 'user-selection', entry: 'page-overlay' },
    source: { pageUrl: 'https://example.com/report#s3', title: '季度报告', capturedAt: '2026-11-08T00:00:00.000Z', carrier: 'sidebar' },
    parts: [
      { partId: 'p1', type: 'text', text: TEXT_A, anchor: { exact: TEXT_A.slice(0, 30), prefix: '', suffix: '' } },
      { partId: 'p2', type: 'image', assetKey: IMAGE_KEY, representation: 'source-image', anchor: { src: 'https://example.com/c.png', alt: '趋势图' } },
      {
        partId: 'p3', type: 'table',
        anchor: { headers: ['指标', '一季度'], firstCells: ['营收'] },
        table: {
          rowCount: 3, columnCount: 2, completeness: 'partial-visible-rows', normalizationVersion: 1,
          cells: [
            { row: 0, column: 0, role: 'header', text: '指标', includedAs: 'text' },
            { row: 0, column: 1, role: 'header', text: '一季度', includedAs: 'text' },
            { row: 1, column: 0, text: '营收', includedAs: 'text' },
            { row: 2, column: 1, text: '单元格末值-6B', includedAs: 'text', inlineContent: [{ type: 'image', partId: 'p3i', assetKey: CELL_KEY }] },
          ],
        },
      },
      { partId: 'p4', type: 'text', text: TEXT_B, anchor: { exact: TEXT_B.slice(0, 30), prefix: '', suffix: '' } },
    ],
    manifestHash: 'b'.repeat(64),
    ...overrides,
  }
}

async function startServer(root, queue) {
  const assets = join(root, 'reference-assets')
  mkdirSync(assets, { recursive: true })
  writeFileSync(join(assets, `${IMAGE_KEY}.bin`), PNG)
  writeFileSync(join(assets, `${IMAGE_KEY}.json`), JSON.stringify({ assetKey: IMAGE_KEY, mime: 'image/png', bytes: PNG.length }))
  writeFileSync(join(assets, `${CELL_KEY}.bin`), Buffer.from('cell-image'))
  writeFileSync(join(assets, `${CELL_KEY}.json`), JSON.stringify({ assetKey: CELL_KEY, mime: 'image/png', bytes: 10 }))

  let capturedRef = captured()
  const service = {
    list: () => [capturedRef],
    get: () => capturedRef,
    capture: async () => ({ reference: capturedRef, failures: [{ kind: 'image', reason: 'thumbnail-unverifiable' }] }),
    reveal: async () => ({ referenceId: capturedRef.referenceId, status: 'revealed', pageUrl: capturedRef.source.pageUrl, parts: [] }),
    insertIntoDraft: async () => ({ ok: true }),
    exportBundle: () => ({ fileName: 'x.jsonl', mime: 'application/jsonl', body: Buffer.from('') }),
    assetPath: key => {
      const file = join(assets, `${key}.bin`)
      return /^[0-9a-f]{64}$/.test(key) ? file : undefined
    },
  }
  const handlers = createReferenceRouteHandlers({ service, queue })
  const routes = new Map([
    ['/dsh-builtin-browser/reference/capture', handlers.capture],
    ['/dsh-builtin-browser/reference/deliveries', handlers.deliveries],
    ['/dsh-builtin-browser/reference/delivery/ack', handlers.ack],
    ['/dsh-builtin-browser/reference/delivery/remove', handlers.removeDelivery],
    ['/dsh-builtin-browser/reference/asset', handlers.asset],
    ['/dsh-builtin-browser/reference/insert', handlers.insert],
  ])
  const server = createServer((req, res) => {
    const handler = routes.get(new URL(req.url, 'http://localhost').pathname)
    if (handler === undefined) { res.writeHead(404).end(); return }
    Promise.resolve(handler(req, res)).catch(error => {
      if (!res.headersSent) res.writeHead(500)
      res.end(JSON.stringify({ error: String(error) }))
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  const headers = {
    host: `127.0.0.1:${server.address().port}`,
    origin: base,
    'sec-fetch-site': 'same-origin',
    'content-type': 'application/json',
  }
  const post = async (path, body) => {
    const res = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify(body) })
    return { status: res.status, json: await res.json() }
  }
  const get = async path => {
    const res = await fetch(base + path, { headers })
    return { status: res.status, json: await res.json() }
  }
  return {
    base, post, get, capturedRef,
    close: () => new Promise(resolve => server.close(resolve)),
    service,
  }
}

test('real HTTP: capture delivers a full ordered snapshot to its OWN conversation only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ref-http-'))
  const path = join(root, 'reference-deliveries.jsonl')
  try {
    const queue = createDeliveryQueue({ path })
    const server = await startServer(root, queue)
    try {
      const capture = await server.post('/dsh-builtin-browser/reference/capture', {
        sessionId: 'dsh-session-A', browserSessionId: 'browser:4a1', origin: 'user-selection', entry: 'page-overlay',
      })
      assert.equal(capture.status, 200)

      const mine = await server.get('/dsh-builtin-browser/reference/deliveries?sessionId=dsh-session-A')
      assert.equal(mine.status, 200)
      assert.equal(mine.json.deliveries.length, 1, 'capture automatically queued a delivery')
      const delivery = mine.json.deliveries[0]
      assert.equal(delivery.sessionId, 'dsh-session-A')
      assert.equal(delivery.browserSessionId, 'browser:4a1')
      assert.equal(delivery.state, 'prepared')
      assert.equal(delivery.failures[0].reason, 'thumbnail-unverifiable', 'partial failure stays visible')
      assert.deepEqual(delivery.requiredAssets, [IMAGE_KEY, CELL_KEY])
      assert.deepEqual(delivery.snapshot.parts.map(p => p.type), ['text', 'image', 'table', 'text'])
      assert.equal(delivery.snapshot.parts[0].text, TEXT_A)
      assert.ok(delivery.snapshot.parts[0].text.length > 100, 'not a placeholder')
      assert.equal(delivery.snapshot.parts[2].table.cells.at(-1).text, '单元格末值-6B')
      assert.equal(delivery.snapshot.parts[3].text, TEXT_B)

      const other = await server.get('/dsh-builtin-browser/reference/deliveries?sessionId=dsh-session-B')
      assert.equal(other.json.deliveries.length, 0, 'switching conversations cannot move the reference')
    } finally {
      await server.close()
      queue.dispose()
    }

    // Restart with a fresh queue and a fresh server: the frozen content is restored.
    const restartedQueue = createDeliveryQueue({ path })
    const restarted = await startServer(root, restartedQueue)
    try {
      const restored = await restarted.get('/dsh-builtin-browser/reference/deliveries?sessionId=dsh-session-A')
      assert.equal(restored.json.deliveries.length, 1)
      assert.equal(restored.json.deliveries[0].snapshot.parts[0].text, TEXT_A)
      assert.equal(restored.json.deliveries[0].snapshot.parts[3].text, TEXT_B)
    } finally {
      await restarted.close()
      restartedQueue.dispose()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('real HTTP: asset endpoint serves REAL bytes whose hash equals the asset key', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ref-http-'))
  try {
    const queue = createDeliveryQueue({ path: join(root, 'd.jsonl') })
    const server = await startServer(root, queue)
    try {
      const result = await server.get(`/dsh-builtin-browser/reference/asset?key=${IMAGE_KEY}&encoding=base64`)
      assert.equal(result.status, 200)
      assert.equal(result.json.mime, 'image/png')
      const bytes = Buffer.from(result.json.data, 'base64')
      assert.equal(bytes.length, PNG.length)
      assert.equal(createHash('sha256').update(bytes).digest('hex'), IMAGE_KEY, 'the client receives actual bytes')

      const raw = await fetch(`${server.base}/dsh-builtin-browser/reference/asset?key=${IMAGE_KEY}`, {
        headers: { host: new URL(server.base).host, origin: server.base, 'sec-fetch-site': 'same-origin' },
      })
      assert.equal(raw.status, 200)
      assert.equal(raw.headers.get('content-type'), 'image/png')
      assert.deepEqual(Buffer.from(await raw.arrayBuffer()), PNG)
      const bad = await server.get('/dsh-builtin-browser/reference/asset?key=not-a-hash&encoding=base64')
      assert.equal(bad.status, 400)
    } finally {
      await server.close()
      queue.dispose()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('real HTTP: ACK only succeeds after a saved draft revision and all assets; remove is a tombstone', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ref-http-'))
  try {
    const queue = createDeliveryQueue({ path: join(root, 'd.jsonl') })
    const server = await startServer(root, queue)
    try {
      await server.post('/dsh-builtin-browser/reference/capture', { sessionId: 'dsh-session-A', browserSessionId: 'browser:4a1' })
      const intentId = 'ref-http-1'
      const ackPath = '/dsh-builtin-browser/reference/delivery/ack'

      const noAssets = await server.post(ackPath, { intentId, draftRev: 3, assetKeys: [] })
      assert.equal(noAssets.status, 409, 'the UI must not claim success before assets are durable')
      const noDraft = await server.post(ackPath, { intentId, draftRev: 0, assetKeys: [IMAGE_KEY, CELL_KEY] })
      assert.equal(noDraft.status, 400)
      const partial = await server.post(ackPath, { intentId, draftRev: 3, assetKeys: [IMAGE_KEY] })
      assert.equal(partial.status, 409)

      const applied = await server.post(ackPath, { intentId, phase: 'draft-applied', draftRev: 3, assetKeys: [IMAGE_KEY, CELL_KEY] })
      assert.equal(applied.json.state, 'draft-applied')
      const acked = await server.post(ackPath, { intentId, draftRev: 3, assetKeys: [IMAGE_KEY, CELL_KEY] })
      assert.equal(acked.status, 200)
      assert.equal(acked.json.state, 'acknowledged')

      const removed = await server.post('/dsh-builtin-browser/reference/delivery/remove', { intentId })
      assert.equal(removed.json.state, 'removed')
      const list = await server.get('/dsh-builtin-browser/reference/deliveries?sessionId=dsh-session-A')
      assert.equal(list.json.deliveries.length, 0, 'a late retry cannot re-insert the removed card')
      const lateAck = await server.post(ackPath, { intentId, draftRev: 9, assetKeys: [IMAGE_KEY, CELL_KEY] })
      assert.equal(lateAck.status, 409)
    } finally {
      await server.close()
      queue.dispose()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test("real HTTP: the panel's { referenceId } remove is accepted (client.js contract)", async () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ref-http-'))
  try {
    const queue = createDeliveryQueue({ path: join(root, 'd.jsonl') })
    const server = await startServer(root, queue)
    try {
      await server.post('/dsh-builtin-browser/reference/capture', { sessionId: 'dsh-session-A', browserSessionId: 'browser:4a1' })
      // client.js:1319 removeFromDraft posts { referenceId }, NOT { intentId }.
      const removed = await server.post('/dsh-builtin-browser/reference/delivery/remove', { referenceId: 'ref-http-1' })
      assert.equal(removed.status, 200)
      assert.equal(removed.json.state, 'removed', 'the tombstone is written and returned')
      const list = await server.get('/dsh-builtin-browser/reference/deliveries?sessionId=dsh-session-A')
      assert.equal(list.json.deliveries.length, 0, 'the card stays out of the next poll')

      // A second remove with the same referenceId can no longer be resolved
      // (list() drops removed records): a stable 409, not a misleading 400.
      const again = await server.post('/dsh-builtin-browser/reference/delivery/remove', { referenceId: 'ref-http-1' })
      assert.equal(again.status, 409)
      assert.equal(again.json.error, 'reference-was-removed')
    } finally {
      await server.close()
      queue.dispose()
    }
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
