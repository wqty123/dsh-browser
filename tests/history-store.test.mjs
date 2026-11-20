// Persistent browsing history: the store's own behaviour, plus the provider
// path that fills it during navigation. The record must outlive sessions, so
// these tests read the file back from disk rather than the provider's memory.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { HistoryStore } from '../lib/browser-electron/history-store.js'
import { ElectronBrowserProvider } from '../lib/browser-electron/provider.js'

/** A unique history file per test, so nothing leaks between them. */
function historyFile() {
  return join(mkdtempSync(join(tmpdir(), 'dsh-history-')), 'history.jsonl')
}

/** Read the history file, or '' when it does not exist yet. */
function readHistory(file) {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** Poll until fn() is truthy or the budget runs out. */
async function waitFor(fn, ms = 3000) {
  const deadline = Date.now() + ms
  for (;;) {
    if (await fn()) return true
    if (Date.now() >= deadline) return false
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/**
 * Host stub whose CDP surface answers the two probes the provider makes around
 * navigation: the per-document stamp (settle) and the URL/title read (visit).
 */
function makeHost({ url = 'https://example.com/', title = 'Example' } = {}) {
  let counter = 0
  let loads = 0
  return {
    createView() {
      return {
        id: `view${++counter}`,
        async sendCommand(method, params) {
          if (method === 'Page.navigate') { loads += 1; return {} }
          if (method === 'Runtime.evaluate') {
            const expr = params.expression ?? ''
            if (expr.includes('timeOrigin')) return { result: { value: `${loads}|complete` } }
            if (expr.includes('document.title')) return { result: { value: `${url}\u0000${title}` } }
            if (expr.trim() === 'location.href') return { result: { value: url } }
            return { result: { value: { ok: true } } }
          }
          return {}
        },
      }
    },
    destroyView() {},
    showView() {},
    groupView() {},
    onUserAction() {},
  }
}

test('appends visits and lists them newest first', () => {
  const file = historyFile()
  const store = new HistoryStore(file)
  const now = Date.now()
  store.append({ at: now - 2_000, url: 'https://a.example/one', title: 'One' })
  store.append({ at: now - 1_000, url: 'https://b.example/two' })

  const listed = store.list()
  assert.equal(listed.length, 2)
  assert.equal(listed[0].url, 'https://b.example/two', 'newest first')
  assert.equal(listed[1].title, 'One')
  assert.equal(listed[0].title, undefined, 'absent titles stay absent')
})

test('a damaged (truncated) line never hides the rest of the history', () => {
  const file = historyFile()
  const now = Date.now()
  writeFileSync(file, [
    `{"at":${now - 3_000},"url":"https://first.example/"}`,
    `{"at":${now - 2_000},"url":"https://trunc`,
    '',
    `{"at":${now - 1_000},"url":"https://third.example/","title":"Third"}`,
    'not json at all',
  ].join('\n'))

  const listed = new HistoryStore(file).list()
  assert.deepEqual(listed.map(page => page.url), ['https://third.example/', 'https://first.example/'])
})

test('filters by domain and caps the result', () => {
  const file = historyFile()
  const store = new HistoryStore(file)
  const now = Date.now()
  store.append({ at: now - 3_000, url: 'https://docs.example.com/a' })
  store.append({ at: now - 2_000, url: 'https://other.test/b' })
  store.append({ at: now - 1_000, url: 'https://docs.example.com/c' })

  assert.deepEqual(store.list({ domain: 'docs.example.com' }).map(p => p.url), [
    'https://docs.example.com/c',
    'https://docs.example.com/a',
  ])
  assert.equal(store.list({ limit: 1 }).length, 1)
  assert.equal(store.list({ limit: 1 })[0].url, 'https://docs.example.com/c')
})

test('entries past the age limit are not listed', () => {
  const file = historyFile()
  const store = new HistoryStore(file, { maxAgeDays: 1 })
  const aWeekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000
  store.append({ at: aWeekAgo, url: 'https://old.example/' })
  store.append({ at: Date.now(), url: 'https://today.example/' })

  assert.deepEqual(store.list().map(p => p.url), ['https://today.example/'])
})

test('pruning keeps the newest entries and bounds the file', () => {
  const file = historyFile()
  const store = new HistoryStore(file, { maxEntries: 3 })
  const now = Date.now()
  for (let i = 1; i <= 8; i++) store.append({ at: now - (9 - i) * 1_000, url: `https://page${i}.example/` })

  store.prune()
  assert.deepEqual(store.list().map(p => p.url), [
    'https://page8.example/',
    'https://page7.example/',
    'https://page6.example/',
  ], 'oldest entries fell off')
  assert.ok(readHistory(file).split('\n').filter(Boolean).length <= 3, 'file itself shrank')
})

test('the provider records a visit after navigation, and lists it back', async () => {
  const file = historyFile()
  const p = new ElectronBrowserProvider(makeHost({ url: 'https://example.com/page', title: 'Example Page' }), {
    history: { file },
  })
  const sid = await p.open()
  await p.navigate(sid, { url: 'https://example.com/page' })

  const recorded = await waitFor(() => readHistory(file).includes('https://example.com/page'))
  assert.ok(recorded, 'the visit reached disk')

  const listed = p.visited()
  assert.equal(listed.length, 1)
  assert.equal(listed[0].url, 'https://example.com/page')
  assert.equal(listed[0].title, 'Example Page')
  await p.close(sid)
})

test('history can be switched off entirely, and the browser keeps working', async () => {
  const file = historyFile()
  const p = new ElectronBrowserProvider(makeHost(), { history: { enabled: false, file } })
  const sid = await p.open()
  await p.navigate(sid, { url: 'https://example.com/' })

  // Give the (absent) recorder a moment to prove it stays silent.
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(readHistory(file), '', 'nothing reached disk')
  assert.deepEqual(p.visited(), [], 'nothing recorded while disabled')
  await p.close(sid)
})

// Requirements §5: the history has to be searchable, and a visit has to say which
// session made it — "the pages THIS task opened" is what makes a shared history
// usable when several sessions and a human all browse through one browser.
test('the history filters by keyword and by the session that visited', () => {
  const file = historyFile()
  const store = new HistoryStore(file)
  const now = Date.now()

  store.append({ at: now - 3_000, url: 'https://docs.example.com/start', title: 'Getting started', session: 'task-a' })
  store.append({ at: now - 2_000, url: 'https://news.example.com/world', title: 'World news', session: 'task-b' })
  store.append({ at: now - 1_000, url: 'https://shop.other.test/cart', title: 'Getting paid', session: 'task-a' })

  assert.equal(store.list({ session: 'task-a' }).length, 2, 'filtered by session')
  assert.equal(store.list({ query: 'getting' }).length, 2, 'keyword matches the title, case-insensitively')
  assert.equal(store.list({ query: 'docs.example' }).length, 1, 'keyword matches the URL too')
  assert.equal(store.list({ session: 'task-a', query: 'getting' }).length, 2, 'filters compose')
  assert.equal(store.list({ query: 'nothing-here' }).length, 0, 'a miss returns nothing')
  assert.equal(store.list({ session: 'task-a' })[0].url, 'https://shop.other.test/cart', 'newest first')
})
