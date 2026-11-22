import { REFERENCE_REVEAL_ROUTE, REFERENCE_EXPORT_ROUTE, REFERENCE_IMPORT_ROUTE, REFERENCE_DELIVERIES_ROUTE, REFERENCE_DELIVERY_ACK_ROUTE, REFERENCE_DELIVERY_REMOVE_ROUTE, REFERENCE_ASSET_ROUTE } from '../../../../../assets/browser-policy.mjs'
/**
 * Wire contract of the built-in browser's durable reference hand-off.
 *
 * These shapes MIRROR the plugin's own modules and are deliberately duplicated
 * here (instead of imported across repositories): the client package must stay
 * self-contained and compilable without the plugin checkout. Field names, the
 * flattened `/deliveries` record and the frozen `snapshot` come from
 * `dsh-browser/browser-reference/types.ts`, `delivery.ts` and
 * `browser-electron/reference-route.ts`. Every content-bearing field is kept
 * verbatim so a unit test can assert on the captured text, table cells and
 * image bytes rather than on a call count.
 *
 * @module dsh-browser-reference/production/protocol
 */

import type { ReferenceTextNode } from '../../../../reference-text.ts'

/** Exact HTTP paths served by the plugin's reference router. */
export const ROUTES = {
  deliveries: REFERENCE_DELIVERIES_ROUTE,
  asset: REFERENCE_ASSET_ROUTE,
  ack: REFERENCE_DELIVERY_ACK_ROUTE,
  remove: REFERENCE_DELIVERY_REMOVE_ROUTE,
  reveal: REFERENCE_REVEAL_ROUTE,
  export: REFERENCE_EXPORT_ROUTE,
  import: REFERENCE_IMPORT_ROUTE,
} as const

/** A part that could not be captured, kept visible so the user can retry/remove. */
export interface DeliveryFailure {
  readonly kind: 'text' | 'image' | 'table' | 'reference'
  readonly reason: string
}

export type DeliveryState = 'prepared' | 'draft-applied' | 'acknowledged' | 'consumed'

// ---- frozen snapshot (mirror of dsh-browser/browser-reference/types.ts) ----

export interface TextQuoteAnchor {
  readonly exact: string
  readonly prefix: string
  readonly suffix: string
}

export interface ImageAnchor {
  readonly src?: string
  readonly currentSrc?: string
  readonly alt?: string
  readonly selector?: string
  readonly geometry?: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
  readonly versionStatus?: 'verified' | 'changed' | 'unverifiable'
}

export interface TextReferencePart {
  readonly partId: string
  readonly type: 'text'
  readonly text: string
  readonly content?: readonly ReferenceTextNode[]
  readonly anchor: TextQuoteAnchor
}

export interface ImageReferencePart {
  readonly partId: string
  readonly type: 'image'
  readonly assetKey: string
  readonly representation: 'source-image' | 'rasterized-image' | 'visible-snapshot'
  readonly alt?: string
  readonly caption?: string
  readonly anchor: ImageAnchor
}

export type TableCellRun =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly partId: string; readonly assetKey: string }

export interface TableCellSnapshot {
  readonly row: number
  readonly column: number
  readonly rowSpan: number
  readonly columnSpan: number
  readonly role: 'header' | 'data'
  readonly text: string
  readonly includedAs: 'selection' | 'header-context'
  readonly partialText: boolean
  readonly inlineContent?: readonly TableCellRun[]
}

export interface TableAnchor {
  readonly selector?: string
  readonly caption?: string
  readonly headers: readonly string[]
  readonly firstCells: readonly string[]
  readonly cell?: { readonly row: number; readonly column: number }
}

export interface TableSnapshot {
  readonly rowCount: number
  readonly columnCount: number
  readonly cells: readonly TableCellSnapshot[]
  readonly caption?: string
  readonly completeness: 'selected-cells' | 'dom-table' | 'visible-rows' | 'aria-grid'
  readonly normalizationVersion: string
}

export interface TableReferencePart {
  readonly partId: string
  readonly type: 'table'
  readonly table: TableSnapshot
  readonly anchor: TableAnchor
}

export type BrowserReferencePart = TextReferencePart | ImageReferencePart | TableReferencePart

export interface BrowserReferenceSource {
  readonly pageUrl: string
  readonly title: string
  readonly capturedAt: string
  readonly frameUrl?: string
  readonly frameRoute?: 'main' | 'frame'
  readonly frameSelector?: string
  readonly carrier: 'sidebar' | 'bundled' | 'chrome' | 'edge'
}

export interface BrowserReferenceOwner {
  readonly sessionId?: string
  readonly browserSessionId?: string
  readonly sourcePageId?: string
}

export interface BrowserReferenceProvenance {
  readonly origin: 'user-selection' | 'agent-excerpt'
  readonly entry: 'native-menu' | 'extension-action' | 'page-overlay' | 'agent-tool'
}

/** The complete immutable capture; the client restores a draft from this. */
export interface FrozenSnapshot {
  readonly version: 1
  readonly provider: 'dsh-browser'
  readonly referenceId: string
  readonly owner: BrowserReferenceOwner
  readonly provenance: BrowserReferenceProvenance
  readonly source: BrowserReferenceSource
  readonly parts: readonly BrowserReferencePart[]
  /** The human's own note (three-state §3). Not part of the page snapshot. */
  readonly comment?: string
  readonly manifestHash: string
}

/** One flattened record returned by `GET /reference/deliveries`. */
export interface DeliveryRecord {
  readonly intentId: string
  readonly sessionId: string
  readonly browserSessionId: string
  readonly referenceId: string
  readonly state: DeliveryState
  readonly failures: readonly DeliveryFailure[]
  readonly assetKeys: readonly string[]
  /** Asset keys required before an acknowledge may succeed. */
  readonly requiredAssets: readonly string[]
  readonly draftRev?: number
  readonly snapshot: FrozenSnapshot
  readonly createdAt: string
  readonly updatedAt: string
  readonly sequence: number
}

export interface DeliveriesResponse {
  readonly tracksSubmissions?: boolean
  readonly unverified?: readonly string[]
  readonly ok: true
  readonly sequence: number
  readonly deliveries: readonly DeliveryRecord[]
}

/** `GET /reference/asset?encoding=base64` response. */
export interface AssetResponse {
  readonly ok: true
  readonly key: string
  readonly mime: string
  readonly bytes: number
  readonly sha256: string
  readonly data: string
}

export type DeliveryAckPhase = 'draft-applied' | 'acknowledged'

export interface AckRequest {
  readonly intentId: string
  readonly draftRev: number
  readonly assetKeys: readonly string[]
  readonly phase?: DeliveryAckPhase
}

export interface AckResponse {
  readonly ok: true
  readonly intentId?: string
  readonly state: DeliveryState
  readonly draftRev: number
  readonly assetKeys: readonly string[]
}

export interface RemoveResponse {
  readonly ok: true
  readonly intentId?: string
  readonly state: 'removed'
}

export interface RevealResultWire {
  readonly ok: true
  readonly code?: string
  readonly status?: string
  readonly reason?: string
  readonly note?: string
  readonly tabId?: string
  readonly frameId?: string
}

export type ExportFormat = 'jsonl' | 'markdown' | 'zip' | 'markdown-zip'

/** Transport error whose status shapes the caller's decision (409 = refuse ACK). */
export class ReferenceHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: unknown,
  ) {
    super(message)
    this.name = 'ReferenceHttpError'
  }
}
