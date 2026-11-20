/**
 * Durable hand-off between a browser capture and the DSH conversation draft.
 *
 * The plugin (Node) owns the page; the client (React) owns the composer. They
 * meet here, in an append-only event log beside the reference store. Because
 * each delivery carries the FULL frozen snapshot, the client can restore a
 * draft after the page was closed and DSH was restarted (§12.2) — it never
 * needs the browser to still be alive.
 *
 * Lifecycle (§12): prepared -> draft-applied -> acknowledged.
 * An `acknowledge` is only accepted when the client proves that the draft was
 * saved AND every image asset is bound; until then the UI must stay in the
 * "preparing" state and must not claim the reference was added (§12.1).
 * A removed intent is a tombstone: late retries never resurrect it (§12.3).
 * @module dsh-browser/browser-reference/delivery
 */

import { randomUUID } from 'node:crypto'
import { referenceOwnerKey } from '../reference-owner.ts'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, openSync, readSync, closeSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { dshHome } from '../browser-electron/paths.ts'
import type { BrowserReference, BrowserReferencePart } from './types.ts'

/** Where the delivery log lives, beside the reference store. */
export function deliveryStorePath(): string {
  return join(dshHome(), 'dsh-builtin-browser-host', 'reference-deliveries.jsonl')
}

export type DeliveryState = 'prepared' | 'draft-applied' | 'acknowledged' | 'consumed' | 'removed'

/** A part that could not be captured, kept visible so the user can retry/remove it. */
export interface DeliveryFailure {
  readonly kind: 'text' | 'image' | 'table' | 'reference'
  readonly reason: string
}

/**
 * One delivery, as the client sees it. `snapshot` is the immutable capture —
 * ordered parts, table cells, image asset keys — not a count and not a URL.
 */
export interface DeliveryRecord {
  /** Dedup key. Equal to the referenceId: retrying one capture is idempotent,
   *  while two separate captures of the same text form two intents (§12.1). */
  readonly intentId: string
  /** The REAL DSH conversation this belongs to, never `browser:<uuid>`. */
  readonly sessionId: string
  /** The plugin's browser session / view that held the page. */
  readonly browserSessionId: string
  readonly referenceId: string
  readonly state: DeliveryState
  readonly draftRev?: number
  readonly assetKeys: readonly string[]
  readonly failures: readonly DeliveryFailure[]
  readonly snapshot: BrowserReference
  readonly createdAt: string
  readonly updatedAt: string
  readonly sequence: number
}

/** One append-only line. The last line for an intent wins when folding. */
type DeliveryEvent = DeliveryRecord

export interface DeliveryQueueOptions {
  readonly path?: string
  readonly now?: () => Date
}

export interface PrepareOptions {
  /** Failures from a partial capture; shown on the card instead of hiding them. */
  readonly failures?: readonly DeliveryFailure[]
}

export interface DeliveryAck {
  /** Revision of the draft that was actually persisted. */
  readonly draftRev: number
  /** Asset keys the client bound into its durable attachment service. */
  readonly assetKeys: readonly string[]
}

export interface DeliverySnapshot {
  readonly sequence: number
  readonly deliveries: readonly DeliveryRecord[]
}

export interface DeliveryQueue {
  /** Freeze one captured reference for delivery. Idempotent per referenceId. */
  prepare(reference: BrowserReference, options?: PrepareOptions): DeliveryRecord
  /** The client wrote the draft; still waiting for asset binding + success. */
  markDraftApplied(intentId: string, ack: DeliveryAck): DeliveryRecord | undefined
  /** Only call after the draft AND all required assets are durably saved. */
  acknowledge(intentId: string, ack: DeliveryAck): DeliveryRecord | undefined
  /** The Host accepted this reference in a message; preserve its source snapshot. */
  consume(intentId: string, sessionId: string): DeliveryRecord | undefined
  /** User removed the card. A tombstone; no late retry can insert it again. */
  remove(intentId: string): DeliveryRecord | undefined
  get(intentId: string): DeliveryRecord | undefined
  /** All live deliveries, optionally for one DSH conversation. */
  list(filter?: { readonly sessionId?: string; readonly since?: number; readonly includeConsumed?: boolean }): DeliverySnapshot
  /** Asset keys required before an acknowledge may succeed. */
  requiredAssets(record: DeliveryRecord): readonly string[]
  subscribe(listener: () => void): () => void
  dispose(): void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readEvents(path: string): DeliveryEvent[] {
  if (!existsSync(path)) return []
  const text = readFileSync(path, 'utf8')
  const events: DeliveryEvent[] = []
  let cursor = 0
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (isRecord(parsed)
        && typeof parsed.intentId === 'string'
        && typeof parsed.sessionId === 'string'
        && Number.isSafeInteger(parsed.sequence) && Number(parsed.sequence) >= 0
        && (parsed.state === 'prepared' || parsed.state === 'draft-applied' || parsed.state === 'acknowledged'
          || parsed.state === 'consumed' || parsed.state === 'removed')
        && isRecord(parsed.snapshot)) {
        // Preserve legacy high-water marks, but give colliding appends their
        // own cursor in physical log order. A client which read writer A's
        // sequence must still receive writer B's later line with that number.
        cursor = Math.max(cursor + 1, Number(parsed.sequence))
        if (!Number.isSafeInteger(cursor)) continue
        events.push({ ...parsed, sessionId: referenceOwnerKey(parsed.sessionId), sequence: cursor } as unknown as DeliveryEvent)
      }
    } catch {
      // A torn tail from a crash is ignored; the next append writes a fresh line.
    }
  }
  return events
}

/** Append onto a torn tail would splice two records together, so repair first. */
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

/** Image parts whose bytes must be bound before the delivery is acknowledged. */
export function imageAssetKeys(reference: BrowserReference): readonly string[] {
  const keys: string[] = []
  const visit = (part: BrowserReferencePart): void => {
    if (part.type === 'image' && typeof part.assetKey === 'string' && part.assetKey !== '') keys.push(part.assetKey)
    if (part.type === 'table') {
      for (const cell of part.table.cells) {
        for (const run of cell.inlineContent ?? []) {
          if (run.type === 'image' && typeof run.assetKey === 'string') keys.push(run.assetKey)
        }
      }
    }
  }
  for (const part of reference.parts) visit(part)
  return [...new Set(keys)]
}

/**
 * Build a queue over one append-only log.
 * @param options - custom path/clock, used by tests and by an isolated profile.
 * @returns the queue.
 */
export function createDeliveryQueue(options: DeliveryQueueOptions = {}): DeliveryQueue {
  const path = options.path ?? deliveryStorePath()
  const now = options.now ?? (() => new Date())
  const listeners = new Set<() => void>()
  let events: DeliveryEvent[] = []
  let sequence = 0
  let disposed = false

  const fileRevision = (): string => {
    try {
      const stat = statSync(path)
      return `${stat.size}:${stat.mtimeMs}:${stat.ino}`
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return ''
      throw error
    }
  }
  let observedRevision: string | undefined
  const refresh = (force = false): void => {
    const revision = fileRevision()
    if (!force && revision === observedRevision) return
    const fresh = readEvents(path)
    events = fresh
    sequence = fresh.reduce((max, event) => Math.max(max, event.sequence), 0)
    observedRevision = revision
  }

  /**
   * The file's physical line order IS the write order. Two DSH processes that
   * share one DSH_HOME can independently allocate the same numeric sequence;
   * comparing `event.sequence > previous.sequence` made the later line of an
   * unrelated intent disappear on the next restart (its card was lost for
   * good). Folding by line order keeps every intent's newest line, including
   * same-sequence writes from another process. Within one process the sequence
   * is monotonic, so this is exactly the old behaviour there.
   */
  const fold = (): Map<string, DeliveryRecord> => {
    refresh()
    const byIntent = new Map<string, DeliveryRecord>()
    const rank: Readonly<Record<DeliveryState, number>> = { prepared: 0, 'draft-applied': 1, acknowledged: 2, consumed: 3, removed: 3 }
    for (const event of events) {
      const previous = byIntent.get(event.intentId)
      // A late write from a process which read an older snapshot cannot undo
      // accepted/removed records or regress their asset-saving progress.
      if (previous !== undefined && (previous.state === 'consumed' || previous.state === 'removed'
        || rank[event.state] <= rank[previous.state])) continue
      byIntent.set(event.intentId, event)
    }
    return byIntent
  }

  const append = (record: DeliveryRecord): DeliveryRecord => {
    mkdirSync(dirname(path), { recursive: true })
    // One appendFileSync per line. Two processes sharing this jsonl used to
    // interleave the "repair the torn tail" newline with the record line;
    // fold them into a single string so a line is written in one call.
    const line = JSON.stringify(record) + '\n'
    appendFileSync(path, endsWithNewline(path) ? line : '\n' + line)
    refresh(true)
    const committed = fold().get(record.intentId) ?? record
    for (const listener of [...listeners]) {
      try { listener() } catch { /* one bad subscriber must not block the write */ }
    }
    return committed
  }

  const transition = (
    intentId: string,
    state: DeliveryState,
    ack?: DeliveryAck,
    checkAssets = false,
  ): DeliveryRecord | undefined => {
    const current = fold().get(intentId)
    if (current === undefined) return undefined
    // A removed intent is a tombstone: keep answering "not acknowledgeable"
    // (undefined -> HTTP 409) so a late ACK can never claim success. This is
    // the pre-existing contract; the delivery/remove routes and their tests
    // rely on it.
    if (current.state === 'removed') return undefined
    if (current.state === 'consumed') return current
    // `acknowledged` is terminal for ACK-like transitions: a repeated ACK or
    // a late `markDraftApplied` must NOT append, advance the sequence, or move
    // the state backwards — otherwise a consumed card reappears in
    // `/deliveries?since=` with a brand-new sequence. Answer with the current
    // record so a retried ACK is idempotent. A user-initiated REMOVAL is still
    // legal from the acknowledged state: it must write a tombstone.
    if (current.state === 'acknowledged' && state !== 'removed' && state !== 'consumed') return current
    // Re-applying the state the record already holds is a no-op write.
    // `current` is never `removed` here, so `state === 'removed'` cannot match.
    if (current.state === state) return current
    if (state === 'acknowledged' && checkAssets) {
      const required = imageAssetKeys(current.snapshot)
      const bound = new Set(ack?.assetKeys ?? [])
      if (required.some(key => !bound.has(key))) return undefined
      if (!Number.isInteger(ack?.draftRev) || (ack?.draftRev ?? 0) < 1) return undefined
    }
    const stamp = now().toISOString()
    const next: DeliveryRecord = {
      ...current,
      state,
      updatedAt: stamp,
      sequence: ++sequence,
      ...ack !== undefined ? { draftRev: ack.draftRev, assetKeys: [...ack.assetKeys] } : {},
    }
    return append(next)
  }

  return {
    prepare(reference, prepareOptions = {}) {
      if (disposed) throw new Error('delivery queue is disposed')
      const sessionId = referenceOwnerKey(reference.owner.sessionId ?? '')
      if (sessionId === undefined || sessionId === '') throw new Error('reference has no DSH session owner')
      const intentId = reference.referenceId
      const existing = fold().get(intentId)
      // A removed intent stays removed; the same capture retried later is the
      // same delivery, so neither case creates a second entry (§12.1/§12.3).
      if (existing !== undefined) return existing
      const stamp = now().toISOString()
      const record: DeliveryRecord = {
        intentId,
        sessionId,
        browserSessionId: reference.owner.browserSessionId ?? '',
        referenceId: reference.referenceId,
        state: 'prepared',
        assetKeys: [],
        failures: [...(prepareOptions.failures ?? [])],
        snapshot: reference,
        createdAt: stamp,
        updatedAt: stamp,
        sequence: ++sequence,
      }
      return append(record)
    },
    markDraftApplied(intentId, ack) {
      return transition(intentId, 'draft-applied', ack)
    },
    acknowledge(intentId, ack) {
      return transition(intentId, 'acknowledged', ack, true)
    },
    consume(intentId, sessionId) {
      const current = fold().get(intentId)
      if (current === undefined || referenceOwnerKey(current.sessionId) !== referenceOwnerKey(sessionId)) return undefined
      if (current.state === 'consumed') return current
      return transition(intentId, 'consumed')
    },
    remove(intentId) {
      const current = fold().get(intentId)
      if (current === undefined || current.state === 'removed') return current
      return transition(intentId, 'removed')
    },
    get(intentId) {
      return fold().get(intentId)
    },
    list(filter = {}) {
      const records = [...fold().values()]
        .filter(record => filter.sessionId === undefined || referenceOwnerKey(record.sessionId) === referenceOwnerKey(filter.sessionId))
        .filter(record => filter.since === undefined || record.sequence > filter.since)
        .filter(record => record.state !== 'removed')
        .filter(record => filter.includeConsumed === true || record.state !== 'consumed')
        .sort((a, b) => a.sequence - b.sequence)
      return { sequence, deliveries: records }
    },
    requiredAssets(record) {
      return imageAssetKeys(record.snapshot)
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    dispose() {
      disposed = true
      listeners.clear()
      // Do NOT clear `events`: fold() is the source of truth for every read and
      // write. Emptying it made in-flight ACK/remove requests during the plugin
      // unload window fold over nothing and answer 409/404. Keeping the log in
      // memory lets those writes settle and lets get()/list() still resolve
      // already-prepared intents after disposal (prepare still throws once
      // disposed, so no NEW capture can be enqueued).
    },
  }
}

/** A fresh intent id for a capture that is not yet a stored reference. */
export function newIntentId(): string {
  return randomUUID()
}

/**
 * Keep the two identities separate (design §3.5 / R01).
 *
 * The host reports `browser:<uuid>` — a browser session / native view. It is
 * NOT a DSH conversation. The real conversation id is read from the plugin
 * context the way the desktop host does; an older composition that cannot
 * supply one falls back to the view id, but the browser session is still
 * recorded on its own field and is never overwritten by it.
 */
export function resolveReferenceOwner(
  realSessionId: string | undefined,
  windowId: string,
): { readonly sessionId: string; readonly browserSessionId: string } {
  const browserSessionId = windowId.trim()
  const sessionId = referenceOwnerKey(realSessionId ?? '') || browserSessionId
  return { sessionId, browserSessionId }
}
