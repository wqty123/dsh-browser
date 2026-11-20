// The agent-facing seam over the shared start-page shortcut section.
//
// The sidebar UI edits the same `browser-startpage` settings section, so every
// case here is about the two writers agreeing: validation before the settings
// layer, and a concurrent edit surviving a stale revision instead of being
// overwritten by a list computed before it happened.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createShortcutStore,
  MAX_SHORTCUTS,
  ShortcutError,
  normalizeShortcut,
} from '../lib/browser-electron/startpage-shortcuts.js'

/**
 * A settings double with one writable section and an injectable concurrent write.
 * @param initial - stored shortcuts.
 */
function fakeSettings(initial) {
  let shortcuts = [...initial]
  let revision = 1
  const queued = []
  return {
    describe: () => [{ ns: 'browser-startpage', revision, value: { shortcuts } }],
    async update(_ns, patch, expected) {
      if (expected !== revision) throw new Error('settings revision conflict')
      // Simulate the sidebar writing between our read and our write: land that
      // change, then refuse the stale revision.
      const racer = queued.shift()
      if (racer !== undefined) {
        shortcuts = [...shortcuts, racer]
        revision += 1
        throw new Error('settings revision conflict')
      }
      shortcuts = [...patch.shortcuts]
      revision += 1
    },
    raceOnce(entry) { queued.push(entry) },
    get shortcuts() { return shortcuts },
    get revision() { return revision },
  }
}

const A = { id: 'a', title: 'A', url: 'https://a.example/' }
const C = { id: 'c', title: 'C', url: 'https://c.example/' }

test('a concurrent shortcut added by the sidebar survives our add', async () => {
  const settings = fakeSettings([A])
  const store = createShortcutStore(() => settings)
  settings.raceOnce({ id: 'b', title: 'B', url: 'https://b.example/' })

  const result = await store.add({ title: 'C', url: 'https://c.example/' })

  // The old implementation retried with the array it had computed BEFORE the
  // race and silently dropped `b`.
  assert.deepEqual(result.shortcuts.map(entry => entry.id), ['a', 'b', result.shortcut.id])
  assert.deepEqual(settings.shortcuts.map(entry => entry.id), ['a', 'b', result.shortcut.id])
  assert.equal(settings.shortcuts[2].url, 'https://c.example/')
})

test('a concurrent add survives a removal instead of being overwritten', async () => {
  const settings = fakeSettings([A, C])
  const store = createShortcutStore(() => settings)
  settings.raceOnce({ id: 'b', title: 'B', url: 'https://b.example/' })

  const result = await store.remove('a')

  assert.equal(result.removed, true)
  assert.deepEqual(result.shortcuts.map(entry => entry.id), ['c', 'b'])
  assert.deepEqual(settings.shortcuts.map(entry => entry.id), ['c', 'b'])
})

test('removing an absent id is a successful no-op that writes nothing', async () => {
  const settings = fakeSettings([A])
  const before = settings.revision
  const store = createShortcutStore(() => settings)

  const result = await store.remove('missing')

  assert.equal(result.removed, false)
  assert.equal(settings.revision, before, 'no revision bump for a no-op')
})

test('a duplicate destination is refused before anything is written', async () => {
  const settings = fakeSettings([A])
  const store = createShortcutStore(() => settings)

  await assert.rejects(() => store.add({ title: 'A again', url: 'https://a.example/' }), /already exists/)
  assert.equal(settings.shortcuts.length, 1)
})

test('duplicate detection compares parsed addresses, not literal spellings', async () => {
  const settings = fakeSettings([{ id: 'a', title: 'A', url: 'https://A.example' }])
  const store = createShortcutStore(() => settings)
  // Same destination with a trailing slash, a default port and a lower-cased
  // host: three spellings that used to occupy three of the 48 slots.
  for (const url of ['https://a.example/', 'https://a.example:443/', 'https://A.example']) {
    await assert.rejects(() => store.add({ title: 'A again', url }), /already exists/)
  }
  assert.equal(settings.shortcuts.length, 1)
  const other = await store.add({ title: 'B', url: 'https://b.example/' })
  assert.equal(other.shortcuts.length, 2)
})

test('the shared limit is enforced by the store, not only by the schema', async () => {
  const full = Array.from({ length: MAX_SHORTCUTS }, (_, index) => ({
    id: `s${index}`, title: `S${index}`, url: `https://s${index}.example/`,
  }))
  const store = createShortcutStore(() => fakeSettings(full))
  await assert.rejects(() => store.add({ title: 'one more', url: 'https://extra.example/' }), /at most/)
})

test('normalisation bounds title, icon and address, and mints a unique id', () => {
  assert.throws(() => normalizeShortcut({ title: '  ', url: 'https://a.example/' }), ShortcutError)
  assert.throws(() => normalizeShortcut({ title: 'x', url: 'javascript:alert(1)' }), /must start with http/)
  assert.throws(() => normalizeShortcut({ title: 'x', url: 'https://a.example/', iconKey: 'i'.repeat(33) }), /icon key/)

  const first = normalizeShortcut({ title: 'Same', url: 'https://one.example/' })
  const second = normalizeShortcut({ title: 'Same', url: 'https://two.example/' })
  assert.notEqual(first.id, second.id, 'two adds in the same millisecond still differ')
})

test('a missing settings service is reported as unavailable, not as an empty list', async () => {
  const store = createShortcutStore(() => undefined)
  assert.throws(() => store.list(), /not available/)
  await assert.rejects(() => store.add({ title: 'x', url: 'https://x.example/' }), /not available/)
})

// The sidebar keeps rows whose `target` is still being repaired. They fail
// isShortcutRecord (empty title / non-http URL) but are NOT ours to delete.
// A write must be a minimal edit over the RAW array, never the filtered one.
const BROKEN = { id: 'broken', title: '', url: 'not-a-url' }

test('an add keeps a malformed sidebar row in the written section', async () => {
  const settings = fakeSettings([A, BROKEN])
  const store = createShortcutStore(() => settings)

  const result = await store.add({ title: 'C', url: 'https://c.example/' })

  assert.deepEqual(settings.shortcuts.map(entry => entry.id), ['a', 'broken', result.shortcut.id],
    'the row the sidebar is still repairing is NOT dropped by our write')
  assert.deepEqual(result.shortcuts.map(entry => entry.id), ['a', result.shortcut.id],
    'the returned view still hides the malformed row')
})

test('a remove keeps a malformed sidebar row in the written section', async () => {
  const settings = fakeSettings([A, C, BROKEN])
  const store = createShortcutStore(() => settings)

  const result = await store.remove('a')

  assert.equal(result.removed, true)
  assert.deepEqual(settings.shortcuts.map(entry => entry.id), ['c', 'broken'],
    'the malformed row is not filtered out of the write')
  assert.deepEqual(result.shortcuts.map(entry => entry.id), ['c'],
    'the returned view still hides the malformed row')
})
