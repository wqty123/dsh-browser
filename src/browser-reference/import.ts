/**
 * Import the plugin's own `format=zip` export back into the local reference library.
 *
 * The archive is untrusted input. No name in it becomes a filesystem path, no hash in it is
 * trusted without being recomputed from the bytes, and no reference is stored unless its
 * canonical manifestHash matches and every asset it names was verified inside this archive.
 * Only stored (method 0) entries with a matching CRC32 are accepted: the exporter never writes
 * compressed entries, and accepting deflate here would add a decompression bomb surface for no
 * benefit. Bare JSONL, Markdown and the documentation-only `markdown-zip` packages are refused —
 * they carry no manifest to check the assets against.
 *
 * This is the plugin-local import half of design §16. It does NOT restore DSH conversation
 * messages, queues or attachment registrations, and it does not claim that a session fork is
 * complete: the host still owns `ctx.sessions.fork`.
 * @module dsh-browser/browser-reference/import
 */
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { collectAssetKeys, crc32 } from './export.ts'
import { sniffImageMime } from './service.ts'
import { isReference, manifestHashOf, ReferenceStore, referenceStorePath } from './store.ts'
import type { BrowserReference } from './types.ts'

/** Bounds that keep a hostile archive from exhausting memory or the disk. */
const MAX_ENTRIES = 5_000
const MAX_TOTAL_BYTES = 200 * 1024 * 1024
const MAX_ENTRY_BYTES = 20 * 1024 * 1024
const ASSET_KEY = /^[0-9a-f]{64}$/
const ASSET_FILE = /^[0-9a-f]{64}\.[a-z0-9]+$/
const HTTP_URL = /^https?:\/\/\S+$/i

interface BundleAsset {
  readonly mime: string
  readonly bytes: Buffer
  readonly sourceUrl?: string
}

interface DecodedBundle {
  readonly references: readonly BrowserReference[]
  readonly assets: ReadonlyMap<string, BundleAsset>
}

export interface ImportResult {
  readonly references: number
  readonly added: number
  readonly duplicates: number
  readonly assets: number
  readonly assetsWritten: number
  /** Per-reference reasons; one bad record never discards the rest of a valid package. */
  readonly rejected: readonly string[]
}

export interface ImportOptions {
  readonly store?: ReferenceStore
  readonly assetDir?: string
  readonly now?: () => Date
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function safeEntryName(name: string): boolean {
  if (name === '' || name.startsWith('/') || name.includes('\\') || name.includes('\0')) return false
  const parts = name.split('/')
  if (parts.length > 2 || parts.some(part => part === '' || part === '.' || part === '..')) return false
  if (parts.length === 1) {
    return name === 'references.jsonl' || name === 'manifest.json' || name === 'references.md'
  }
  return parts[0] === 'assets' && ASSET_FILE.test(parts[1] ?? '')
}

/**
 * Read a stored-only ZIP without trusting local-header sizes over the central directory.
 * @param zip - the archive bytes.
 * @returns entry name to verified bytes.
 */
export function parseStoredZip(zip: Buffer): Map<string, Buffer> {
  if (zip.length < 22) throw new Error('not a zip archive: too short')
  let end = -1
  const floor = Math.max(0, zip.length - 65_557)
  for (let at = zip.length - 22; at >= floor; at -= 1) {
    if (zip.readUInt32LE(at) === 0x06054B50) { end = at; break }
  }
  if (end < 0) throw new Error('not a zip archive: end of central directory not found')
  const count = zip.readUInt16LE(end + 10)
  const centralSize = zip.readUInt32LE(end + 12)
  const centralOffset = zip.readUInt32LE(end + 16)
  if (count > MAX_ENTRIES) throw new Error('the zip has too many entries')
  if (centralOffset + centralSize > zip.length) throw new Error('the zip central directory is out of bounds')

  const files = new Map<string, Buffer>()
  let cursor = centralOffset
  let total = 0
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > zip.length || zip.readUInt32LE(cursor) !== 0x02014B50) {
      throw new Error('the zip central directory is damaged')
    }
    const method = zip.readUInt16LE(cursor + 10)
    const crc = zip.readUInt32LE(cursor + 16)
    const compressed = zip.readUInt32LE(cursor + 20)
    const size = zip.readUInt32LE(cursor + 24)
    const nameLength = zip.readUInt16LE(cursor + 28)
    const extraLength = zip.readUInt16LE(cursor + 30)
    const commentLength = zip.readUInt16LE(cursor + 32)
    const localOffset = zip.readUInt32LE(cursor + 42)
    if (cursor + 46 + nameLength + extraLength + commentLength > zip.length) {
      throw new Error('the zip central directory is damaged')
    }
    const name = zip.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    cursor += 46 + nameLength + extraLength + commentLength
    if (!safeEntryName(name)) throw new Error(`the zip contains an unsafe entry name: ${JSON.stringify(name)}`)
    if (files.has(name)) throw new Error(`the zip contains a duplicate entry: ${JSON.stringify(name)}`)
    if (method !== 0 || compressed !== size) throw new Error(`the zip entry ${JSON.stringify(name)} is not stored uncompressed`)
    if (size > MAX_ENTRY_BYTES) throw new Error('a zip entry exceeds the import size limit')
    total += size
    if (total > MAX_TOTAL_BYTES) throw new Error('the zip exceeds the total import size limit')
    if (localOffset + 30 > zip.length || zip.readUInt32LE(localOffset) !== 0x04034B50) {
      throw new Error(`the zip entry ${JSON.stringify(name)} has no valid local header`)
    }
    const localNameLength = zip.readUInt16LE(localOffset + 26)
    const localExtraLength = zip.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    if (dataStart + size > zip.length) throw new Error(`the zip entry ${JSON.stringify(name)} is truncated`)
    const bytes = Buffer.from(zip.subarray(dataStart, dataStart + size))
    if (crc32(bytes) !== crc) throw new Error(`the zip entry ${JSON.stringify(name)} failed its CRC32`)
    files.set(name, bytes)
  }
  return files
}

/**
 * Validate a decoded package: manifest shape, asset content hashes and reference hashes.
 * @param files - the verified ZIP entries.
 * @returns references and content-addressed assets ready to materialise.
 */
export function decodeReferenceBundle(files: ReadonlyMap<string, Buffer>): DecodedBundle {
  const manifestText = files.get('manifest.json')
  if (manifestText === undefined) {
    throw new Error('the package has no manifest.json; import a format=zip export, not markdown-zip or raw JSONL')
  }
  let parsed: unknown
  try { parsed = JSON.parse(manifestText.toString('utf8')) } catch {
    throw new Error('the package manifest is not valid JSON')
  }
  if (!isRecord(parsed) || parsed.kind !== 'dsh-browser-reference-export' || parsed.version !== 1) {
    throw new Error('the package manifest is not a version 1 browser-reference export')
  }
  const rows: readonly unknown[] = Array.isArray(parsed.assets) ? parsed.assets : []
  const assets = new Map<string, BundleAsset>()
  for (const row of rows) {
    if (!isRecord(row)) throw new Error('the package manifest has a malformed asset row')
    const assetKey = row.assetKey
    const file = row.file
    if (typeof assetKey !== 'string' || !ASSET_KEY.test(assetKey)) throw new Error('an asset key is not a SHA-256 hex digest')
    if (typeof file !== 'string' || !file.startsWith('assets/') || !safeEntryName(file)) {
      throw new Error('an asset file name is not inside the package assets directory')
    }
    const bytes = files.get(file)
    if (bytes === undefined) throw new Error(`the package is missing ${JSON.stringify(file)}`)
    if (row.bytes !== bytes.length) throw new Error(`the manifest byte count for ${assetKey} does not match the bytes`)
    if (createHash('sha256').update(bytes).digest('hex') !== assetKey) {
      throw new Error(`the bytes of ${assetKey} do not match their content hash`)
    }
    const mime = sniffImageMime(bytes)
    if (mime === undefined) throw new Error(`the bytes of ${assetKey} are not a recognised image`)
    const sourceUrl = row.sourceUrl
    if (sourceUrl !== undefined && (typeof sourceUrl !== 'string' || !HTTP_URL.test(sourceUrl))) {
      throw new Error(`the manifest source URL for ${assetKey} is not an HTTP(S) URL`)
    }
    assets.set(assetKey, {
      mime, bytes,
      ...typeof sourceUrl === 'string' ? { sourceUrl } : {},
    })
  }

  const jsonl = files.get('references.jsonl')
  if (jsonl === undefined) throw new Error('the package has no references.jsonl')
  const references: BrowserReference[] = []
  for (const line of jsonl.toString('utf8').split('\n')) {
    if (line.trim() === '') continue
    let value: unknown
    try { value = JSON.parse(line) } catch { throw new Error('references.jsonl has a malformed line') }
    if (!isReference(value)) throw new Error('references.jsonl contains a record that is not a browser reference')
    if (manifestHashOf(value) !== value.manifestHash) throw new Error(`reference ${value.referenceId} has a mismatched manifestHash`)
    for (const key of collectAssetKeys([value])) {
      if (!assets.has(key)) throw new Error(`reference ${value.referenceId} names an asset absent from the package`)
    }
    references.push(value)
  }
  return { references, assets }
}

/**
 * Materialise assets and append references to the local library.
 * @param zip - the export package bytes.
 * @param options - test seams for the store, asset directory and clock.
 * @returns counts, including per-record rejections.
 */
export function importReferenceBundle(zip: Buffer, options: ImportOptions = {}): ImportResult {
  const { references, assets } = decodeReferenceBundle(parseStoredZip(zip))
  const store = options.store ?? new ReferenceStore()
  const assetDir = options.assetDir ?? join(dirname(referenceStorePath()), 'reference-assets')
  const now = options.now ?? (() => new Date())
  let assetsWritten = 0
  if (assets.size > 0) {
    mkdirSync(assetDir, { recursive: true })
    for (const [assetKey, asset] of assets) {
      const file = join(assetDir, `${assetKey}.bin`)
      if (!existsSync(file)) {
        const temp = `${file}.${process.pid}-${randomUUID()}.tmp`
        writeFileSync(temp, asset.bytes)
        renameSync(temp, file)
        assetsWritten += 1
      }
      const metaFile = join(assetDir, `${assetKey}.json`)
      if (!existsSync(metaFile)) {
        writeFileSync(metaFile, JSON.stringify({
          assetKey,
          mime: asset.mime,
          bytes: asset.bytes.length,
          ...asset.sourceUrl === undefined ? {} : { sourceUrl: asset.sourceUrl },
          representation: 'source-image',
          savedAt: now().toISOString(),
        }))
      }
    }
  }
  const rejected: string[] = []
  let added = 0
  let duplicates = 0
  for (const reference of references) {
    try {
      if (store.append(reference) === 'added') added += 1
      else duplicates += 1
    } catch (error) {
      rejected.push(`${reference.referenceId}: ${String(error)}`)
    }
  }
  return {
    references: references.length, added, duplicates,
    assets: assets.size, assetsWritten, rejected,
  }
}

export interface ForkRegistration {
  readonly created: number
  readonly duplicates: number
  /** Reference ids skipped because at least one bound asset is no longer on disk. */
  readonly missingAssets: readonly string[]
}

/**
 * Register a session fork's references in the plugin library.
 *
 * Assets are content-addressed and shared, never copied: a fork is legal only when every
 * asset the source references still exists. Reference ids are derived deterministically from
 * the target session and the original id, so replaying the same fork is idempotent. This is
 * the plugin's asset-registration half; the host still owns the actual `ctx.sessions.fork`.
 * @param sourceSessionId - the conversation being forked.
 * @param targetSessionId - the new conversation.
 * @param options - test seams for the store and asset directory.
 * @returns the registration counts.
 */
export function registerForkedReferences(
  sourceSessionId: string,
  targetSessionId: string,
  options: ImportOptions = {},
): ForkRegistration {
  const store = options.store ?? new ReferenceStore()
  const assetDir = options.assetDir ?? join(dirname(referenceStorePath()), 'reference-assets')
  const missingAssets: string[] = []
  let created = 0
  let duplicates = 0
  for (const original of store.list({ sessionId: sourceSessionId })) {
    const keys = collectAssetKeys([original])
    if (keys.some(key => !existsSync(join(assetDir, `${key}.bin`)))) {
      missingAssets.push(original.referenceId)
      continue
    }
    const referenceId = createHash('sha256').update(`fork:${targetSessionId}:${original.referenceId}`).digest('hex')
    const draft: Omit<BrowserReference, 'manifestHash'> = {
      version: 1,
      provider: 'dsh-browser',
      referenceId,
      owner: { sessionId: targetSessionId, ...original.owner.browserSessionId === undefined ? {} : { browserSessionId: original.owner.browserSessionId } },
      provenance: original.provenance,
      source: original.source,
      parts: original.parts,
    }
    const reference: BrowserReference = { ...draft, manifestHash: manifestHashOf(draft) }
    try {
      if (store.append(reference) === 'added') created += 1
      else duplicates += 1
    } catch {
      // A pre-existing id with different content means the fork was already registered with a
      // different source snapshot; leave the original untouched rather than mutate an immutable record.
      missingAssets.push(original.referenceId)
    }
  }
  return { created, duplicates, missingAssets }
}
