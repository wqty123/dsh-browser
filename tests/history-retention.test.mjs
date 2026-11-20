import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HistoryStore } from '../lib/browser-electron/history-store.js'

function fixture(t, limits = {}) {
  const root = fs.mkdtempSync(join(tmpdir(), 'dsh-retention-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const file = join(root, 'history.jsonl')
  return { file, store: new HistoryStore(file, limits) }
}

const lines = file => fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))

test('tightening the entry cap hides excess visits immediately and prunes without another append', t => {
  const { file, store } = fixture(t)
  for (let i = 0; i < 5; i++) store.append({ at: Date.now(), url: `https://example.com/${i}` })
  store.prune()
  store.updateLimits({ maxEntries: 2 })
  assert.deepEqual(store.list().map(page => page.url), ['https://example.com/4', 'https://example.com/3'])
  store.prune()
  assert.equal(lines(file).length, 2)
})

test('age expiry removes old records from disk even below the count threshold', t => {
  const { file, store } = fixture(t, { maxAgeDays: 1 })
  const now = Date.now()
  store.append({ at: now - 3 * 86_400_000, url: 'https://expired.example/' })
  store.append({ at: now, url: 'https://current.example/' })
  store.prune()
  assert.deepEqual(lines(file).map(page => page.url), ['https://current.example/'])
})

test('existing visits age out on a later prune even without a new visit', t => {
  const { file, store } = fixture(t, { maxAgeDays: 1 })
  const now = Date.now()
  store.append({ at: now, url: 'https://expires-later.example/' })
  store.prune()
  const clock = mock.method(Date, 'now', () => now + 2 * 86_400_000)
  try { store.prune() } finally { clock.mock.restore() }
  assert.deepEqual(lines(file), [])
})

test('ordinary append/prune calls batch full history reads and rewrites', t => {
  const { file, store } = fixture(t, { maxEntries: 100 })
  const realRead = fs.readFileSync
  const realRename = fs.renameSync
  let reads = 0
  let writes = 0
  const read = mock.method(fs, 'readFileSync', (target, ...rest) => {
    if (target === file) reads++
    return realRead(target, ...rest)
  })
  const rename = mock.method(fs, 'renameSync', (from, to) => {
    if (to === file) writes++
    return realRename(from, to)
  })
  syncBuiltinESMExports()
  try {
    for (let i = 0; i < 200; i++) {
      store.append({ at: Date.now(), url: `https://example.com/${i}` })
      store.updateLimits({ maxEntries: 100 })
      store.prune()
    }
    assert.ok(reads <= 4, `expected batched reads, got ${reads}`)
    assert.ok(writes <= 3, `expected batched writes, got ${writes}`)
  } finally {
    read.mock.restore()
    rename.mock.restore()
    syncBuiltinESMExports()
  }
  assert.equal(store.list().length, 100)
})
