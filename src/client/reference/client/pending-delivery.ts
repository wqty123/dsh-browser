/**
 * Idempotent pending-delivery queue (§12.1, B27/B28).
 *
 * Intent id is the dedup key. ACK is idempotent: repeated notifications, a lost
 * ACK and late retries apply the draft change exactly once (via `onApply`).
 * Deleting a reference writes a durable tombstone so a late retry cannot
 * resurrect it. Persistence goes through an injected KeyValueStorage — the
 * module never reads `localStorage` or other globals directly.
 */
import type {
  DeliveryState,
  PendingDelivery,
  OrderedReferenceGroup,
  KeyValueStorage,
} from './types.ts'
import { DELIVERY_STATE_ORDER, createMemoryStorage } from './types.ts'
import { isOrderedReferenceGroup } from './draft-reference.ts'

export const QUEUE_FORMAT_VERSION = 1
export const DEFAULT_DELIVERY_STORAGE_KEY = 'dsh.browser-reference.deliveries'

export class DeliveryQueueError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DeliveryQueueError'
  }
}

export type DeliveryOutcome =
  | { readonly status: 'created' | 'existing' | 'advanced' | 'acknowledged' | 'already-acknowledged'; readonly delivery: PendingDelivery }
  | { readonly status: 'deleted' }
  | { readonly status: 'invalid-transition'; readonly from: DeliveryState; readonly to: DeliveryState }
  | { readonly status: 'unknown-intent' }

export interface DeliveryQueueOptions {
  readonly storage?: KeyValueStorage
  readonly key?: string
  readonly now?: () => number
  /** Called exactly once, on the first successful ACK of an intent. */
  readonly onApply?: (intentId: string, delivery: PendingDelivery) => void
}

export interface DeliveryQueue {
  capture(input: { readonly intentId: string; readonly sessionId: string; readonly group: OrderedReferenceGroup }): DeliveryOutcome
  advance(intentId: string, to: DeliveryState): DeliveryOutcome
  acknowledge(intentId: string): DeliveryOutcome
  markDeleted(referenceId: string): void
  get(intentId: string): PendingDelivery | undefined
  snapshot(): readonly PendingDelivery[]
  restore(): void
  dispose(): void
}

/** The single legal next state, or undefined at the terminal state. */
export function nextDeliveryState(state: DeliveryState): DeliveryState | undefined {
  const index = DELIVERY_STATE_ORDER.indexOf(state)
  return index < 0 ? undefined : DELIVERY_STATE_ORDER[index + 1]
}

/** Strict one-step-forward transition check (used by `advance`). */
export function isValidTransition(from: DeliveryState, to: DeliveryState): boolean {
  return nextDeliveryState(from) === to
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNonEmptyString(value: unknown, max = 512): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= max
}

function isPendingDelivery(value: unknown): value is PendingDelivery {
  if (!isRecord(value)) return false
  return isNonEmptyString(value.intentId)
    && isNonEmptyString(value.sessionId)
    && isNonEmptyString(value.referenceId)
    && typeof value.state === 'string' && DELIVERY_STATE_ORDER.includes(value.state as DeliveryState)
    && typeof value.createdAt === 'number' && Number.isFinite(value.createdAt)
    && typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
    && (value.deleted === undefined || typeof value.deleted === 'boolean')
    && isOrderedReferenceGroup(value.group)
    && (value.group as OrderedReferenceGroup).referenceId === value.referenceId
}

interface QueueSnapshot {
  readonly version: typeof QUEUE_FORMAT_VERSION
  readonly deliveries: readonly PendingDelivery[]
  readonly tombstones: readonly string[]
}

function parseSnapshot(raw: string): { deliveries: PendingDelivery[]; tombstones: Set<string> } | undefined {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || parsed.version !== QUEUE_FORMAT_VERSION) return undefined
    if (!Array.isArray(parsed.deliveries) || !Array.isArray(parsed.tombstones)) return undefined
    const deliveries: PendingDelivery[] = []
    for (const entry of parsed.deliveries as readonly unknown[]) {
      if (!isPendingDelivery(entry)) return undefined
      deliveries.push(entry)
    }
    const tombstones = new Set<string>()
    for (const entry of parsed.tombstones as readonly unknown[]) {
      if (!isNonEmptyString(entry)) return undefined
      tombstones.add(entry)
    }
    return { deliveries, tombstones }
  } catch {
    return undefined
  }
}

/** Build the queue; construction restores any persisted state (restart recovery). */
export function createDeliveryQueue(options: DeliveryQueueOptions = {}): DeliveryQueue {
  const storage = options.storage ?? createMemoryStorage()
  const key = options.key ?? DEFAULT_DELIVERY_STORAGE_KEY
  const now = options.now ?? (() => Date.now())
  const onApply = options.onApply
  let deliveries = new Map<string, PendingDelivery>()
  let tombstones = new Set<string>()
  let disposed = false

  function persist(): void {
    const snapshot: QueueSnapshot = {
      version: QUEUE_FORMAT_VERSION,
      deliveries: [...deliveries.values()],
      tombstones: [...tombstones],
    }
    storage.setItem(key, JSON.stringify(snapshot))
  }

  function load(): void {
    const raw = storage.getItem(key)
    if (raw === null) { deliveries = new Map(); tombstones = new Set(); return }
    const parsed = parseSnapshot(raw)
    if (parsed === undefined) { deliveries = new Map(); tombstones = new Set(); return }
    deliveries = new Map(parsed.deliveries.map(delivery => [delivery.intentId, delivery]))
    tombstones = parsed.tombstones
  }

  function guard(): void {
    if (disposed) throw new DeliveryQueueError('delivery queue is disposed')
  }

  load()

  return {
    capture(input) {
      guard()
      const existing = deliveries.get(input.intentId)
      if (existing !== undefined) {
        if (existing.deleted === true || tombstones.has(existing.referenceId)) return { status: 'deleted' }
        return { status: 'existing', delivery: existing }
      }
      // B28: a late retry for an already-deleted reference stays deleted.
      if (tombstones.has(input.group.referenceId)) return { status: 'deleted' }
      const timestamp = now()
      const delivery: PendingDelivery = {
        intentId: input.intentId,
        sessionId: input.sessionId,
        referenceId: input.group.referenceId,
        group: input.group,
        state: 'captured',
        createdAt: timestamp,
        updatedAt: timestamp,
      }
      deliveries.set(input.intentId, delivery)
      persist()
      return { status: 'created', delivery }
    },
    advance(intentId, to) {
      guard()
      const current = deliveries.get(intentId)
      if (current === undefined) return { status: 'unknown-intent' }
      if (current.deleted === true || tombstones.has(current.referenceId)) return { status: 'deleted' }
      if (!isValidTransition(current.state, to)) return { status: 'invalid-transition', from: current.state, to }
      const updated: PendingDelivery = { ...current, state: to, updatedAt: now() }
      deliveries.set(intentId, updated)
      persist()
      return { status: 'advanced', delivery: updated }
    },
    acknowledge(intentId) {
      guard()
      const current = deliveries.get(intentId)
      if (current === undefined) return { status: 'unknown-intent' }
      if (current.deleted === true || tombstones.has(current.referenceId)) return { status: 'deleted' }
      // Idempotent: a repeated / late ACK never re-applies the draft change.
      if (current.state === 'acknowledged') return { status: 'already-acknowledged', delivery: current }
      const updated: PendingDelivery = { ...current, state: 'acknowledged', updatedAt: now() }
      deliveries.set(intentId, updated)
      persist()
      // Exactly-once application point: ACK means draft + assets are saved (§12.1).
      onApply?.(intentId, updated)
      return { status: 'acknowledged', delivery: updated }
    },
    markDeleted(referenceId) {
      guard()
      tombstones.add(referenceId)
      for (const [id, delivery] of deliveries) {
        if (delivery.referenceId === referenceId && delivery.deleted !== true) {
          deliveries.set(id, { ...delivery, deleted: true, updatedAt: now() })
        }
      }
      persist()
    },
    get(intentId) { return deliveries.get(intentId) },
    snapshot() { return [...deliveries.values()] },
    restore() { load() },
    dispose() {
      if (disposed) return
      disposed = true
      deliveries.clear()
      tombstones.clear()
    },
  }
}
