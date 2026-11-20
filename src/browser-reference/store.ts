/**
 * Persistent reference store: append-only JSONL beside the browser profile, so
 * a reference survives the browser process, the page, and a DSH restart.
 *
 * One line per reference. A half-written tail (crash, power loss) is dropped on
 * read rather than poisoning every later lookup. Duplicate `referenceId`s are
 * idempotent only when the content hash matches; the same id with different
 * content is refused, because a reference is an immutable snapshot.
 * @module dsh-browser/browser-reference/store
 */

import { createHash } from 'node:crypto'
import { referenceOwnerKey } from '../reference-owner.ts'
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { writeFileAtomic } from '../browser-electron/settings-store.ts'
import { dshHome } from '../browser-electron/paths.ts'
import type { BrowserReference } from './types.ts'

/** Retention limits; whichever is hit first starts trimming. */
export interface ReferenceLimits {
  /** Maximum retained references. Default 2000. */
  readonly maxEntries?: number
}

const DEFAULT_MAX_ENTRIES = 2_000
/** Rewrite the file only once it has grown this far past the cap. */
const PRUNE_SLACK = 200

/** Absolute path of the reference file, beside the browser profile. */
export function referenceStorePath(): string {
  return join(dshHome(), 'dsh-builtin-browser-host', 'references.jsonl')
}

/** Canonical JSON: sorted keys, so hashing never depends on construction order. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
}

/**
 * Hash the immutable fields of a reference.
 * @param reference - a reference with or without its `manifestHash`.
 * @returns the SHA-256 hex digest.
 */
export function manifestHashOf(reference: Omit<BrowserReference, 'manifestHash'> | BrowserReference): string {
  const { version, provider, referenceId, owner, provenance, source, parts } = reference
  return createHash('sha256').update(canonicalJson({ version, provider, referenceId, owner, provenance, source, parts })).digest('hex')
}

function readRecords(path: string): BrowserReference[] {
  if (!existsSync(path)) return []
  const lines = readFileSync(path, 'utf8').split('\n')
  const records: BrowserReference[] = []
  for (const line of lines) {
    if (line.trim() === '') continue
    let parsed: unknown
    try { parsed = JSON.parse(line) } catch { continue }
    if (!isReference(parsed)) continue
    records.push(parsed)
  }
  return records
}

export function isReference(value: unknown): value is BrowserReference {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return record.version === 1
    && record.provider === 'dsh-browser'
    && typeof record.referenceId === 'string' && record.referenceId !== ''
    && typeof record.manifestHash === 'string'
    && Array.isArray(record.parts)
    && typeof record.source === 'object' && record.source !== null
    && typeof record.provenance === 'object' && record.provenance !== null
    && typeof record.owner === 'object' && record.owner !== null
}

/** Result of one append attempt. */
export type AppendResult = 'added' | 'duplicate'

/** Whether the file's last byte is a newline (an absent or empty file counts as terminated). */
function endsWithNewline(path: string): boolean {
  if (!existsSync(path)) return true
  let size: number
  try { size = statSync(path).size } catch { return true }
  if (size === 0) return true
  let descriptor: number | undefined
  try {
    descriptor = openSync(path, 'r')
    const last = Buffer.alloc(1)
    return readSync(descriptor, last, 0, 1, size - 1) === 1 && last[0] === 0x0a
  } catch {
    return true
  } finally {
    if (descriptor !== undefined) { try { closeSync(descriptor) } catch { /* already closed */ } }
  }
}

/** The reference store for one file. */
export class ReferenceStore {
  private readonly limits: ReferenceLimits
  private readonly path: string

  constructor(path = referenceStorePath(), limits: ReferenceLimits = {}) {
    this.path = path
    this.limits = limits
  }

  private get maxEntries(): number {
    const value = this.limits.maxEntries ?? DEFAULT_MAX_ENTRIES
    return Number.isInteger(value) && value > 0 ? value : DEFAULT_MAX_ENTRIES
  }

  /**
   * Append one immutable reference.
   * @param reference - the snapshot to store.
   * @returns `added`, or `duplicate` when the identical snapshot is already stored.
   * @throws Error when the same `referenceId` exists with different content.
   */
  append(reference: BrowserReference): AppendResult {
    const expected = manifestHashOf(reference)
    if (reference.manifestHash !== expected) throw new Error('the reference manifest hash does not match its content')
    const existing = this.get(reference.referenceId)
    if (existing !== undefined) {
      if (existing.manifestHash === expected) return 'duplicate'
      throw new Error(`reference ${JSON.stringify(reference.referenceId)} already exists with different content`)
    }
    mkdirSync(dirname(this.path), { recursive: true })
    // A crash can leave a partial last line with no terminator. Appending onto it would
    // splice the new record into the garbage and lose both, so restore the boundary first.
    if (!endsWithNewline(this.path)) appendFileSync(this.path, '\n')
    appendFileSync(this.path, JSON.stringify(reference) + '\n')
    if (this.count() > this.maxEntries + PRUNE_SLACK) this.prune()
    return 'added'
  }

  /** Read one reference by id. */
  get(referenceId: string): BrowserReference | undefined {
    return readRecords(this.path).find(record => record.referenceId === referenceId)
  }

  /**
   * List references, newest last.
   * @param filter - optional session and page filters.
   * @returns the matching references.
   */
  list(filter: { readonly sessionId?: string; readonly pageUrl?: string; readonly limit?: number } = {}): BrowserReference[] {
    let records = readRecords(this.path)
    if (filter.sessionId !== undefined) records = records.filter(record => referenceOwnerKey(record.owner.sessionId ?? '') === referenceOwnerKey(filter.sessionId!))
    if (filter.pageUrl !== undefined) records = records.filter(record => record.source.pageUrl === filter.pageUrl)
    const limit = filter.limit
    return limit !== undefined && limit > 0 ? records.slice(-limit) : records
  }

  /** Number of readable records. */
  count(): number {
    return readRecords(this.path).length
  }

  /** Rewrite the file keeping only the newest `maxEntries` records. */
  prune(): void {
    const records = readRecords(this.path)
    const keep = records.slice(-this.maxEntries)
    mkdirSync(dirname(this.path), { recursive: true })
    writeFileAtomic(this.path, keep.map(record => JSON.stringify(record)).join('\n') + (keep.length === 0 ? '' : '\n'))
  }
}
