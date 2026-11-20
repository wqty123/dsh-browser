/**
 * Reference store: append-only immutability, idempotent retries, tamper and
 * conflict refusal, corrupt-tail tolerance, retention, and filters.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { appendFileSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { manifestHashOf, ReferenceStore, referenceStorePath } from '../lib/browser-reference/store.js'
import { buildTextAnchor } from '../lib/browser-reference/text-quote.js'

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-browser-ref-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return { directory, path: join(directory, 'references.jsonl') }
}

function reference(referenceId, text = 'quoted text', overrides = {}) {
  const pageText = `before ${text} after`
  const start = pageText.indexOf(text)
  const base = {
    version: 1,
    provider: 'dsh-browser',
    referenceId,
    owner: { sessionId: 'session-1' },
    provenance: { origin: 'user-selection', entry: 'page-overlay' },
    source: {
      pageUrl: 'https://example.com/article',
      title: 'An article',
      capturedAt: '2026-11-07T00:00:00.000Z',
      carrier: 'bundled',
    },
    parts: [{ partId: 'part-1', type: 'text', text, anchor: buildTextAnchor(pageText, start, start + text.length) }],
    ...overrides,
  }
  return { ...base, manifestHash: manifestHashOf(base) }
}

test('the default store lives beside the browser profile', () => {
  const path = referenceStorePath()
  assert.match(path.replaceAll('\\', '/'), /dsh-builtin-browser-host\/references\.jsonl$/)
})

test('append then read returns the same snapshot', t => {
  const { path } = fixture(t)
  const store = new ReferenceStore(path)
  const record = reference('ref-1')
  assert.equal(store.append(record), 'added')
  assert.deepEqual(store.get('ref-1'), record)
  assert.equal(store.count(), 1)
  assert.equal(existsSync(path), true)
})

test('legacy prefixed owners are discoverable without rewriting their signed snapshots', t => {
  const { path } = fixture(t)
  const store = new ReferenceStore(path)
  const legacy = reference('legacy-owner', 'frozen words', { owner: { sessionId: 'session-79b4e5bd-5bf4-49f3-b911-5d1a92b7002b' } })
  store.append(legacy)
  assert.deepEqual(store.list({ sessionId: '79b4e5bd-5bf4-49f3-b911-5d1a92b7002b' }), [legacy])
  assert.deepEqual(store.get(legacy.referenceId), legacy)
  assert.deepEqual(store.list({ sessionId: 'another-owner' }), [])
})

test('the same reference is idempotent, not duplicated', t => {
  const { path } = fixture(t)
  const store = new ReferenceStore(path)
  const record = reference('ref-1')
  store.append(record)
  assert.equal(store.append(record), 'duplicate')
  assert.equal(store.count(), 1)
})

test('the same id with different content is refused', t => {
  const { path } = fixture(t)
  const store = new ReferenceStore(path)
  store.append(reference('ref-1', 'first text'))
  assert.throws(() => store.append(reference('ref-1', 'second text')), /already exists with different content/)
})

test('a tampered manifest hash is refused', t => {
  const { path } = fixture(t)
  const store = new ReferenceStore(path)
  const record = reference('ref-1')
  assert.throws(() => store.append({ ...record, manifestHash: '0'.repeat(64) }), /manifest hash does not match/)
})

test('a half-written tail does not poison later reads', t => {
  const { path } = fixture(t)
  const store = new ReferenceStore(path)
  store.append(reference('ref-1'))
  appendFileSync(path, '{"version":1,"provider":"dsh-browser","referenceId":"trunc')
  assert.equal(store.count(), 1)
  assert.equal(store.get('ref-1')?.referenceId, 'ref-1')
  store.append(reference('ref-2'))
  assert.equal(store.count(), 2)
})

test('prune keeps only the newest references', t => {
  const { path } = fixture(t)
  const store = new ReferenceStore(path, { maxEntries: 2 })
  for (const id of ['ref-1', 'ref-2', 'ref-3', 'ref-4']) store.append(reference(id, `text ${id}`))
  store.prune()
  assert.equal(store.count(), 2)
  assert.equal(store.get('ref-1'), undefined)
  assert.equal(store.get('ref-4')?.referenceId, 'ref-4')
})

test('filters select by session and page', t => {
  const { path } = fixture(t)
  const store = new ReferenceStore(path)
  store.append(reference('ref-1'))
  store.append(reference('ref-2', 'other text', { owner: { sessionId: 'session-2' } }))
  assert.equal(store.list({ sessionId: 'session-2' }).length, 1)
  assert.equal(store.list({ pageUrl: 'https://example.com/article' }).length, 2)
  assert.equal(store.list({ pageUrl: 'https://example.com/none' }).length, 0)
  assert.deepEqual(store.list({ limit: 1 }).map(record => record.referenceId), ['ref-2'])
})
