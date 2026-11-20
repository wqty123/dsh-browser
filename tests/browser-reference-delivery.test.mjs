// The durable capture-to-draft hand-off. These assertions are CONTENT-level:
// a full multi-part snapshot (long real text, an image asset, a structured table,
// then more text) must survive a queue restart byte-for-byte, in the same order.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  createDeliveryQueue, imageAssetKeys, deliveryStorePath,
} from '../lib/browser-reference/delivery.js'

const TEXT_A = '第一段：网页引用的价值在于把用户真正看到的那一小段内容原样带进对话，而不是只带一个网址或者一句"请看这个页面"。'
  + '选区可能横跨多个段落、列表和引用块，冻结快照必须保留它们的先后顺序与文字本身，任何一步把它压成条数都会让模型失去依据。'
  + '这一段特意写得足够长，用来证明交付的不是几个字符的占位符。HEAD-A'
const TEXT_B = '第四段：文字 B 出现在图片和表格之后。如果实现把图片统一提到最前面，或者把表格折叠成一句说明，这里的顺序就会被破坏，'
  + '所以顺序本身也是断言对象。TAIL-B-END'

const IMAGE_BYTES = Buffer.from(
  '89504e470d0a1a0a0000000d494844520000000100000001080600000' +
  '01f15c4890000000d49444154789c6360000002000100' + '05fe02fe' + 'dcb7e40a' + '0000000049454e44ae426082',
  'hex',
)
const IMAGE_KEY = createHash('sha256').update(IMAGE_BYTES).digest('hex')
const CELL_IMAGE_KEY = createHash('sha256').update('cell-image-bytes').digest('hex')

function tablePart() {
  return {
    partId: 'p3',
    type: 'table',
    anchor: { headers: ['指标', '一季度', '二季度'], firstCells: ['营收', '成本'], cell: { row: 0, column: 0 } },
    table: {
      rowCount: 4,
      columnCount: 3,
      completeness: 'partial-visible-rows',
      normalizationVersion: 1,
      cells: [
        { row: 0, column: 0, role: 'header', text: '指标', includedAs: 'text' },
        { row: 0, column: 1, role: 'header', text: '一季度', includedAs: 'text' },
        { row: 0, column: 2, role: 'header', text: '二季度', includedAs: 'text', columnSpan: 2 },
        { row: 1, column: 0, text: '营收', includedAs: 'text', rowSpan: 2 },
        { row: 1, column: 1, text: '1,204 万', includedAs: 'text' },
        { row: 2, column: 1, text: '成本', includedAs: 'text' },
        { row: 3, column: 2, text: '单元格末值-6B', includedAs: 'text', inlineContent: [{ type: 'image', partId: 'p3-img', assetKey: CELL_IMAGE_KEY }] },
      ],
    },
  }
}

function snapshot(overrides = {}) {
  return {
    version: 1,
    provider: 'dsh-browser',
    referenceId: 'ref-content-1',
    owner: { sessionId: 'dsh-session-A', browserSessionId: 'browser:uuid-A' },
    provenance: { origin: 'user-selection', entry: 'page-overlay' },
    source: {
      pageUrl: 'https://example.com/report?q=2026#section-3',
      title: '季度经营报告（真实长文）',
      capturedAt: '2026-11-08T00:00:00.000Z',
      carrier: 'sidebar',
    },
    parts: [
      { partId: 'p1', type: 'text', text: TEXT_A, anchor: { exact: TEXT_A.slice(0, 40), prefix: '', suffix: '' } },
      { partId: 'p2', type: 'image', assetKey: IMAGE_KEY, representation: 'source-image', anchor: { src: 'https://example.com/chart.png', alt: '季度趋势图' } },
      tablePart(),
      { partId: 'p4', type: 'text', text: TEXT_B, anchor: { exact: TEXT_B.slice(0, 40), prefix: '', suffix: '' } },
    ],
    manifestHash: 'a'.repeat(64),
    ...overrides,
  }
}

function withTempPath(fn) {
  const root = mkdtempSync(join(tmpdir(), 'dsh-delivery-'))
  const path = join(root, 'reference-deliveries.jsonl')
  try { return fn(path) } finally { rmSync(root, { recursive: true, force: true }) }
}

test('prepare freezes the WHOLE ordered snapshot; a restart restores it byte-for-byte', () => withTempPath(path => {
  const reference = snapshot()
  const first = createDeliveryQueue({ path })
  const prepared = first.prepare(reference, { failures: [{ kind: 'image', reason: 'one-thumbnail-failed' }] })
  assert.equal(prepared.state, 'prepared')
  assert.equal(prepared.sessionId, 'dsh-session-A')
  assert.equal(prepared.browserSessionId, 'browser:uuid-A', 'DSH session and browser session are separate ids')
  assert.equal(prepared.failures.length, 1, 'a partial capture keeps its failure visible')
  first.dispose()

  // New queue instance == DSH/browser restarted and the page is gone.
  const restarted = createDeliveryQueue({ path })
  const restored = restarted.list().deliveries[0]
  assert.ok(restored, 'delivery survived a restart')
  assert.deepEqual(restored.snapshot.parts.map(part => part.type), ['text', 'image', 'table', 'text'],
    'mixed content keeps its page order; images are not hoisted to the front')
  assert.equal(restored.snapshot.parts[0].text, TEXT_A)
  assert.equal(restored.snapshot.parts[0].text.length, TEXT_A.length)
  assert.ok(restored.snapshot.parts[0].text.startsWith('第一段：'))
  assert.ok(restored.snapshot.parts[3].text.endsWith('TAIL-B-END'))
  const table = restored.snapshot.parts[2].table
  assert.equal(table.rowCount, 4)
  assert.equal(table.columnCount, 3)
  assert.equal(table.cells.at(-1).text, '单元格末值-6B')
  assert.equal(table.cells[2].columnSpan, 2, 'merged cells survive as structure')
  assert.equal(table.completeness, 'partial-visible-rows', 'partial-selection facts are kept for the model')
  assert.equal(restored.snapshot.parts[1].assetKey, IMAGE_KEY, 'the image is a real asset binding, not a URL')
  assert.equal(restored.snapshot.source.pageUrl, 'https://example.com/report?q=2026#section-3')
  restarted.dispose()
}))

test('deliveries are isolated by REAL DSH session, not by the active conversation', () => withTempPath(path => {
  const queue = createDeliveryQueue({ path })
  queue.prepare(snapshot({ referenceId: 'ref-A' }))
  queue.prepare(snapshot({ referenceId: 'ref-B', owner: { sessionId: 'dsh-session-B', browserSessionId: 'browser:uuid-B' } }))

  const a = queue.list({ sessionId: 'dsh-session-A' }).deliveries
  const b = queue.list({ sessionId: 'dsh-session-B' }).deliveries
  assert.deepEqual(a.map(x => x.referenceId), ['ref-A'])
  assert.deepEqual(b.map(x => x.referenceId), ['ref-B'])
  // The browser session is never used as the conversation key.
  assert.equal(queue.list({ sessionId: 'browser:uuid-A' }).deliveries.length, 0)
  queue.dispose()
}))

test('prepare is idempotent per capture, but two distinct captures are two intents', () => withTempPath(path => {
  const queue = createDeliveryQueue({ path })
  const one = queue.prepare(snapshot({ referenceId: 'ref-same' }))
  const again = queue.prepare(snapshot({ referenceId: 'ref-same' }))
  assert.equal(again.sequence, one.sequence, 'a retry does not append or duplicate')
  queue.prepare(snapshot({ referenceId: 'ref-second' }))
  assert.equal(queue.list().deliveries.length, 2, 'capturing the same text twice makes two independent references')
  queue.dispose()
}))

test('ACK is refused until the draft revision AND every image asset are bound', () => withTempPath(path => {
  const queue = createDeliveryQueue({ path })
  const record = queue.prepare(snapshot())
  const required = queue.requiredAssets(record)
  assert.deepEqual(required, [IMAGE_KEY, CELL_IMAGE_KEY], 'table inline images count too')

  assert.equal(queue.acknowledge(record.intentId, { draftRev: 7, assetKeys: [] }), undefined,
    'no assets bound -> no success claim')
  assert.equal(queue.get(record.intentId).state, 'prepared')
  assert.equal(queue.acknowledge(record.intentId, { draftRev: 0, assetKeys: [...required] }), undefined,
    'an unsaved draft revision -> no success claim')
  assert.equal(queue.acknowledge(record.intentId, { draftRev: 7, assetKeys: [IMAGE_KEY] }), undefined,
    'a partially bound asset set -> no success claim')

  const applied = queue.markDraftApplied(record.intentId, { draftRev: 7, assetKeys: [...required] })
  assert.equal(applied.state, 'draft-applied')
  const acked = queue.acknowledge(record.intentId, { draftRev: 7, assetKeys: [...required] })
  assert.equal(acked.state, 'acknowledged')
  assert.equal(acked.draftRev, 7)
  queue.dispose()
}))

test('a removed card is a tombstone: retries and late ACK cannot resurrect it', () => withTempPath(path => {
  const queue = createDeliveryQueue({ path })
  const record = queue.prepare(snapshot())
  assert.equal(queue.remove(record.intentId).state, 'removed')
  assert.equal(queue.list().deliveries.length, 0)

  // A late "prepare" from a retrying capture, then a late ACK: neither shows up.
  const retry = queue.prepare(snapshot())
  assert.equal(retry.state, 'removed')
  assert.equal(queue.acknowledge(record.intentId, { draftRev: 1, assetKeys: imageAssetKeys(snapshot()) }), undefined)
  assert.equal(queue.list().deliveries.length, 0)
  queue.dispose()
}))

test('incremental polling with since returns only newer transitions', () => withTempPath(path => {
  const queue = createDeliveryQueue({ path })
  const first = queue.prepare(snapshot({ referenceId: 'ref-1' }))
  const second = queue.prepare(snapshot({ referenceId: 'ref-2' }))
  const all = queue.list()
  assert.equal(all.deliveries.length, 2)
  const incremental = queue.list({ since: first.sequence })
  assert.deepEqual(incremental.deliveries.map(x => x.intentId), ['ref-2'])
  assert.ok(incremental.sequence >= second.sequence)
  queue.dispose()
}))

test('a torn last line from a crash is ignored and the next append is a clean record', () => withTempPath(path => {
  const queue = createDeliveryQueue({ path })
  queue.prepare(snapshot({ referenceId: 'ref-intact' }))
  queue.dispose()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, '{"intentId":"half-written-json', { flag: 'a' })
  const restarted = createDeliveryQueue({ path })
  assert.deepEqual(restarted.list().deliveries.map(x => x.intentId), ['ref-intact'])
  restarted.prepare(snapshot({ referenceId: 'ref-after-crash' }))
  assert.equal(restarted.list().deliveries.length, 2)
  restarted.dispose()
}))

test('two processes sharing one log keep every intent even when sequences collide', () => withTempPath(path => {
  // A second DSH process can start from the same file and allocate the SAME
  // numeric sequence for a different intent. The old `sequence > previous`
  // fold dropped the later line on the next restart: that card was lost for
  // good. File order is authoritative, so both intents must survive.
  const first = createDeliveryQueue({ path })
  const a = first.prepare(snapshot({ referenceId: 'ref-A' }))
  first.dispose()
  const otherProcess = { ...a, intentId: 'ref-B', referenceId: 'ref-B' }
  writeFileSync(path, `${JSON.stringify(otherProcess)}\n`, { flag: 'a' })
  const restarted = createDeliveryQueue({ path })
  assert.deepEqual(restarted.list().deliveries.map(x => x.intentId).sort(), ['ref-A', 'ref-B'])
  restarted.dispose()
}))

test('the queue lives beside the reference store under DSH_HOME', () => {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = join(tmpdir(), 'dsh-home-probe')
  try {
    assert.ok(deliveryStorePath().includes('dsh-builtin-browser-host'))
    assert.ok(deliveryStorePath().endsWith('reference-deliveries.jsonl'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('acknowledged is terminal: a repeated ACK does not append or advance the sequence', () => withTempPath(path => {
  const queue = createDeliveryQueue({ path })
  const record = queue.prepare(snapshot())
  const ack = { draftRev: 7, assetKeys: [...queue.requiredAssets(record)] }
  const first = queue.acknowledge(record.intentId, ack)
  assert.equal(first.state, 'acknowledged')
  const sequenceAfterFirst = queue.list().sequence

  const again = queue.acknowledge(record.intentId, ack)
  assert.equal(again.state, 'acknowledged', 'a retried ACK answers with the unchanged terminal record')
  assert.equal(again.sequence, first.sequence, 'no ++sequence for a terminal record')
  assert.equal(queue.list().sequence, sequenceAfterFirst, 'no new event line was appended')
  assert.deepEqual(queue.list({ since: first.sequence }).deliveries.map(x => x.intentId), [],
    'a consumed card must not reappear in an incremental poll')
  queue.dispose()
}))

test('a late draft-applied never rolls an acknowledged record backwards', () => withTempPath(path => {
  const queue = createDeliveryQueue({ path })
  const record = queue.prepare(snapshot())
  const ack = { draftRev: 7, assetKeys: [...queue.requiredAssets(record)] }
  queue.markDraftApplied(record.intentId, ack)
  const acked = queue.acknowledge(record.intentId, ack)
  assert.equal(acked.state, 'acknowledged')
  const sequenceAfterAck = queue.list().sequence

  const late = queue.markDraftApplied(record.intentId, { draftRev: 8, assetKeys: [] })
  assert.equal(late.state, 'acknowledged', 'a late draft-applied must not revert the state')
  assert.equal(late.draftRev, 7, 'nor overwrite the committed draft revision')
  assert.equal(queue.list().sequence, sequenceAfterAck, 'and must not append/advance the sequence')
  queue.dispose()
}))

test('dispose keeps in-flight records readable instead of folding over an empty log', () => withTempPath(path => {
  const queue = createDeliveryQueue({ path })
  const record = queue.prepare(snapshot())
  queue.dispose()
  // A plugin reload disposes the queue, but an ACK/remove already in flight
  // must still find its intent. Emptying `events` in dispose() made fold()
  // empty and returned 409/404 for those writes.
  assert.equal(queue.get(record.intentId).state, 'prepared')
  assert.deepEqual(queue.list().deliveries.map(x => x.intentId), [record.intentId])
  const acked = queue.acknowledge(record.intentId, { draftRev: 7, assetKeys: [...queue.requiredAssets(record)] })
  assert.equal(acked.state, 'acknowledged', 'an in-flight ACK still settles against the retained log')
  queue.dispose()
}))

test('live queue instances observe another writer without reopening and keep incremental cursors monotonic', () => withTempPath(path => {
  const first = createDeliveryQueue({ path })
  const second = createDeliveryQueue({ path })
  try {
    const one = first.prepare(snapshot({ referenceId: 'writer-one' }))
    const two = second.prepare(snapshot({ referenceId: 'writer-two' }))
    assert.ok(two.sequence > one.sequence)
    assert.deepEqual(first.list({ since: one.sequence }).deliveries.map(record => record.referenceId), ['writer-two'])
    assert.deepEqual(second.list().deliveries.map(record => record.referenceId), ['writer-one', 'writer-two'])
  } finally { first.dispose(); second.dispose() }
}))

test('a legacy writer sequence collision cannot hide a new delivery behind an already-read cursor', () => withTempPath(path => {
  const queue = createDeliveryQueue({ path })
  try {
    const first = queue.prepare(snapshot({ referenceId: 'read-before-foreign-append' }))
    const cursor = queue.list().sequence
    const foreign = { ...first, intentId: 'foreign-append', referenceId: 'foreign-append', snapshot: snapshot({ referenceId: 'foreign-append' }) }
    writeFileSync(path, JSON.stringify(foreign) + '\n', { flag: 'a' })
    const next = queue.list({ since: cursor })
    assert.equal(next.deliveries.length, 1)
    assert.equal(next.deliveries[0].referenceId, 'foreign-append')
    assert.ok(next.deliveries[0].sequence > cursor)
  } finally { queue.dispose() }
}))

test('consumption is owner-scoped, idempotent and survives both restart and a stale foreign ACK', () => withTempPath(path => {
  const queue = createDeliveryQueue({ path })
  const prepared = queue.prepare(snapshot({ referenceId: 'accepted-reference' }))
  const acked = queue.acknowledge(prepared.intentId, { draftRev: 1, assetKeys: [...queue.requiredAssets(prepared)] })
  assert.equal(queue.consume(prepared.intentId, 'another-session'), undefined)
  assert.equal(queue.get(prepared.intentId).state, 'acknowledged')
  const consumed = queue.consume(prepared.intentId, prepared.sessionId)
  assert.equal(consumed.state, 'consumed')
  assert.equal(queue.consume(prepared.intentId, prepared.sessionId).sequence, consumed.sequence)
  assert.deepEqual(queue.list().deliveries, [], 'older clients never see already-consumed drafts')
  writeFileSync(path, JSON.stringify(acked) + '\n', { flag: 'a' })
  assert.equal(queue.get(prepared.intentId).state, 'consumed', 'a stale process cannot resurrect the accepted quote')
  const restarted = createDeliveryQueue({ path })
  try {
    assert.equal(restarted.get(prepared.intentId).state, 'consumed')
    assert.equal(restarted.list({ includeConsumed: true }).deliveries[0].snapshot.referenceId, prepared.referenceId)
    assert.deepEqual(restarted.list().deliveries, [])
  } finally { queue.dispose(); restarted.dispose() }
}))
