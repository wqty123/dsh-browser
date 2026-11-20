/**
 * Shared value types for the browser-reference client feature.
 *
 * These types mirror the host vocabulary (PromptContentPart, DraftSnapshot,
 * QueueAction, DeliveryState) without importing host modules: the package is a
 * self-contained, additive contract the host may wire in later.
 */

import type { ReferenceTable, ReferenceTextNode } from '../../../reference-text.ts'

/** Kinds of captured parts that can appear inside one ordered reference group. */
export type BrowserReferencePartKind = 'text' | 'image' | 'table'

/** Readiness of one captured part (partial failures stay visible, B20). */
export type BrowserReferencePartStatus = 'ready' | 'failed'

/** One captured fragment of a web page. */
export interface BrowserReferencePart {
  readonly kind: BrowserReferencePartKind
  /** Stable identity of this fragment, used as the second URI segment. */
  readonly partId: string
  /** Reference this fragment belongs to (must equal its group's referenceId). */
  readonly referenceId: string
  /** Persisted asset binding for image/table parts. */
  readonly assetKey?: string
  /** Extracted text for text/table parts. */
  readonly text?: string
  readonly content?: readonly ReferenceTextNode[]
  readonly table?: ReferenceTable
  readonly mimeType?: string
  readonly label?: string
  readonly status?: BrowserReferencePartStatus
}

/** An ordered, collapsible group of fragments captured together (§3.4). */
export interface OrderedReferenceGroup {
  readonly referenceId: string
  readonly parts: readonly BrowserReferencePart[]
}

/** Delivery lifecycle (§12): captured → assets-ready → prepared → draft-applied → acknowledged. */
export type DeliveryState =
  | 'captured'
  | 'assets-ready'
  | 'prepared'
  | 'draft-applied'
  | 'acknowledged'

export const DELIVERY_STATE_ORDER: readonly DeliveryState[] = [
  'captured', 'assets-ready', 'prepared', 'draft-applied', 'acknowledged',
]

/** One pending delivery, keyed by intent id for idempotency (§12.1, B27/B28). */
export interface PendingDelivery {
  readonly intentId: string
  readonly sessionId: string
  readonly referenceId: string
  readonly group: OrderedReferenceGroup
  readonly state: DeliveryState
  readonly createdAt: number
  readonly updatedAt: number
  /** Tombstone: a deleted reference stays deleted even under late retries. */
  readonly deleted?: boolean
}

/** A waitable, cancellable source-reveal intent (§14.1). */
export interface RevealRequest {
  readonly referenceId: string
  readonly partId?: string
  readonly sessionId: string
  readonly signal?: AbortSignal
  /**
   * Ask the plugin to move its page to the stored URL before locating.
   *
   * "回到原文" means going there; without this the only answer for a sidebar
   * parked on another page is "cannot locate".
   */
  readonly navigate?: boolean
}

/**
 * Why a reveal ended.
 *
 * The plugin distinguishes causes that need different advice ("the sidebar is
 * on another page" vs "the quoted text is gone"), so they are named here too:
 * collapsing all of them into `unavailable` produced one misleading sentence
 * ("侧栏浏览器当前不可用") for very different situations.
 */
export type RevealStatus =
  | 'revealed'
  | 'cancelled'
  | 'superseded'
  | 'unknown-reference'
  | 'session-mismatch'
  | 'not-found'
  | 'session-unavailable'
  | 'page-mismatch'
  | 'missing'
  | 'ambiguous'
  | 'unavailable'

export interface RevealResult {
  readonly status: RevealStatus
  readonly reason?: string
}

/** Host-neutral projection target, matching the shape consumed by Session.prompt. */
export type PromptContentPart =
  | { readonly type: 'text'; readonly text: string }
  | {
      readonly type: 'image'
      readonly assetKey: string
      readonly partId?: string
      readonly referenceId?: string
    }
  | {
      readonly type: 'table'
      readonly table?: ReferenceTable
      readonly text: string
      readonly partId?: string
      readonly referenceId?: string
    }

/** Persisted semantic draft state: plain text plus ordered reference groups. */
export interface DraftReferenceState {
  /** Monotonic revision used for compare-and-set edits. */
  readonly draftRev: number
  readonly text: string
  readonly groups: readonly OrderedReferenceGroup[]
}

export type CasRejectReason =
  | 'stale-revision'
  | 'invalid-group'
  | 'invalid-span'
  | 'not-found'
  | 'duplicate'

export type CasResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly reason: CasRejectReason; readonly expectedRev: number }

/** Injectable localStorage-like surface; the package never touches globals directly. */
export interface KeyValueStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

/** In-memory storage, used by tests and as a no-global fallback. */
export function createMemoryStorage(seed?: Readonly<Record<string, string>>): KeyValueStorage {
  const map = new Map<string, string>(seed === undefined ? [] : Object.entries(seed))
  return {
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value) },
    removeItem: key => { map.delete(key) },
  }
}

/** One reference chip as the host editor accepts it (mirrors the host's `ReferenceInsert`). */
export interface ReferenceChipInsert {
  readonly source: string
  readonly ref: string
  readonly label: string
  readonly appearance?: 'session' | 'file' | 'folder'
  readonly clipboardText: string
}
