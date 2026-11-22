// ZIP import: the export/import round trip, hash verification, hostile archives and fork
// registration. All packages are built with the production exporter, so a change to either side
// that breaks the format fails here rather than in a real user's library.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { createZip, referenceZip, assetFileName } = await import('../lib/browser-reference/export.js')
const { manifestHashOf, ReferenceStore } = await import('../lib/browser-reference/store.js')
const { buildTextAnchor } = await import('../lib/browser-reference/text-quote.js')
const {
  importReferenceBundle, parseStoredZip, decodeReferenceBundle, registerForkedReferences,
} = await import('../lib/browser-reference/import.js')

/** Bytes that sniffImageMime accepts, without needing a real PNG encoder. */
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52])
const OTHER_PNG = Buffer.concat([PNG, Buffer.from([1, 2, 3, 4])])
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-browser-import-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return {
    directory,
    assetDir: join(directory, 'assets'),
    store: new ReferenceStore(join(directory, 'references.jsonl')),
  }
}

function makeReference(referenceId, assetKey, sessionId = 'session-1') {
  const pageText = 'before quoted text after'
  const start = pageText.indexOf('quoted text')
  const base = {
    version: 1,
    provider: 'dsh-browser',
    referenceId,
    owner: { sessionId },
    provenance: { origin: 'user-selection', entry: 'page-overlay' },
    source: {
      pageUrl: 'https://example.com/article', title: 'An article',
      capturedAt: '2026-11-07T00:00:00.000Z', carrier: 'bundled',
    },
    parts: [
      { partId: 'part-1', type: 'text', text: 'quoted text', anchor: buildTextAnchor(pageText, start, start + 'quoted text'.length) },
      { partId: 'part-2', type: 'image', assetKey, representation: 'source-image', anchor: { src: 'https://example.com/a.png' } },
    ],
  }
  return { ...base, manifestHash: manifestHashOf(base) }
}

function packageOf(reference, assetKey, bytes = PNG) {
  return referenceZip({
    references: [reference],
    assets: [{ assetKey, mime: 'image/png', bytes, sourceUrl: 'https://example.com/a.png' }],
    exportedAt: '2026-11-07T00:00:00.000Z',
  })
}

test('a production zip export imports back with its asset re-materialised', t => {
  const { assetDir, store } = fixture(t)
  const assetKey = sha256(PNG)
  const reference = makeReference('ref-1', assetKey)
  const result = importReferenceBundle(packageOf(reference, assetKey), { store, assetDir })

  assert.deepEqual(
    { references: result.references, added: result.added, assets: result.assets, assetsWritten: result.assetsWritten, rejected: result.rejected.length },
    { references: 1, added: 1, assets: 1, assetsWritten: 1, rejected: 0 },
  )
  assert.deepEqual(store.get('ref-1'), reference, 'the stored snapshot is byte-identical')
  assert.ok(existsSync(join(assetDir, `${assetKey}.bin`)), 'the content-addressed asset is on disk')
  assert.equal(readFileSync(join(assetDir, `${assetKey}.bin`)).equals(PNG), true)
  assert.equal(JSON.parse(readFileSync(join(assetDir, `${assetKey}.json`), 'utf8')).mime, 'image/png')
})

test('importing the same package twice is idempotent', t => {
  const { assetDir, store } = fixture(t)
  const assetKey = sha256(PNG)
  const zip = packageOf(makeReference('ref-1', assetKey), assetKey)
  importReferenceBundle(zip, { store, assetDir })
  const second = importReferenceBundle(zip, { store, assetDir })
  assert.equal(second.added, 0)
  assert.equal(second.duplicates, 1)
  assert.equal(second.assetsWritten, 0, 'an already stored asset is not rewritten')
  assert.equal(store.count(), 1)
})

test('bytes whose SHA-256 does not match the manifest assetKey are refused', t => {
  const { assetDir, store } = fixture(t)
  const assetKey = sha256(PNG)
  const reference = makeReference('ref-1', assetKey)
  const files = parseStoredZip(packageOf(reference, assetKey))
  const assetFile = `assets/${assetFileName(assetKey, 'image/png')}`
  files.set(assetFile, OTHER_PNG)
  // A length change is caught even earlier by the byte-count check.
  assert.throws(() => decodeReferenceBundle(files), /byte count/)
  // Keep the declared length consistent so the tampered bytes reach the content-hash check.
  const manifest = JSON.parse(files.get('manifest.json').toString('utf8'))
  manifest.assets[0].bytes = OTHER_PNG.length
  for (const row of manifest.references) row.assets[0].bytes = OTHER_PNG.length
  files.set('manifest.json', JSON.stringify(manifest, null, 2) + '\n')
  const repacked = createZip([...files].map(([name, data]) => ({ name, data })))
  assert.throws(() => decodeReferenceBundle(files), /content hash/)
  assert.throws(() => importReferenceBundle(repacked, { store, assetDir }), /content hash/)
  assert.equal(store.count(), 0, 'nothing is written when the package fails validation')
})

test('a reference with a forged manifestHash is refused', t => {
  const { assetDir, store } = fixture(t)
  const assetKey = sha256(PNG)
  const reference = { ...makeReference('ref-1', assetKey), manifestHash: '0'.repeat(64) }
  const files = parseStoredZip(packageOf(reference, assetKey))
  assert.throws(() => decodeReferenceBundle(files), /manifestHash/)
  assert.equal(store.count(), 0)
})

test('a reference naming an asset the package does not carry is refused', t => {
  const { assetDir, store } = fixture(t)
  const assetKey = sha256(PNG)
  const missing = sha256(OTHER_PNG)
  const reference = makeReference('ref-1', missing)
  const files = parseStoredZip(packageOf(reference, assetKey))
  assert.throws(() => decodeReferenceBundle(files), /absent from the package/)
})

test('a documentation-only package without a manifest is refused', t => {
  const { assetDir, store } = fixture(t)
  const zip = createZip([
    { name: 'references.jsonl', data: '' },
    { name: 'references.md', data: '# notes' },
  ])
  assert.throws(() => importReferenceBundle(zip, { store, assetDir }), /no manifest\.json/)
})

test('a zip-slip entry name is refused before any byte is used', () => {
  const zip = createZip([{ name: '../references.jsonl', data: '' }])
  assert.throws(() => parseStoredZip(zip), /unsafe entry name/)
})

test('a compressed entry is refused; CRC damage is detected', t => {
  const { assetDir, store } = fixture(t)
  const assetKey = sha256(PNG)
  const reference = makeReference('ref-1', assetKey)
  const zip = Buffer.from(packageOf(reference, assetKey))
  // Flip the central directory compression method of the first entry from stored (0) to deflate (8).
  let end = -1
  for (let at = zip.length - 22; at >= 0; at -= 1) {
    if (zip.readUInt32LE(at) === 0x06054B50) { end = at; break }
  }
  zip.writeUInt16LE(8, zip.readUInt32LE(end + 16) + 10)
  assert.throws(() => importReferenceBundle(zip, { store, assetDir }), /not stored uncompressed/)

  const damaged = Buffer.from(packageOf(reference, assetKey))
  damaged[30 + 'references.jsonl'.length] ^= 0x40 // first data byte of references.jsonl
  assert.throws(() => importReferenceBundle(damaged, { store, assetDir }), /CRC32/)
})

test('a fork registers references only while their assets exist, and replay is idempotent', t => {
  const { assetDir, store } = fixture(t)
  const assetKey = sha256(PNG)
  const reference = makeReference('ref-1', assetKey)
  store.append(reference)
  mkdirSync(assetDir, { recursive: true })
  writeFileSync(join(assetDir, `${assetKey}.bin`), PNG)

  const first = registerForkedReferences('session-1', 'session-2', { store, assetDir })
  assert.equal(first.created, 1)
  assert.deepEqual(first.missingAssets, [])
  const forked = store.list({ sessionId: 'session-2' })
  assert.equal(forked.length, 1)
  assert.notEqual(forked[0].referenceId, 'ref-1')
  assert.equal(forked[0].manifestHash, manifestHashOf(forked[0]), 'the fork has a valid hash of its own')
  assert.equal(forked[0].parts[1].assetKey, assetKey, 'content-addressed assets are shared, not copied')

  const replay = registerForkedReferences('session-1', 'session-2', { store, assetDir })
  assert.equal(replay.created, 0)
  assert.equal(replay.duplicates, 1)

  rmSync(join(assetDir, `${assetKey}.bin`))
  const missing = registerForkedReferences('session-1', 'session-3', { store, assetDir })
  assert.equal(missing.created, 0)
  assert.deepEqual(missing.missingAssets, ['ref-1'], 'a fork with dangling assets is not registered')
})
