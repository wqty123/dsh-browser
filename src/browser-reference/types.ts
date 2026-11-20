/**
 * Browser reference records: what the user pointed at in a page, in a form a
 * later reveal can verify. One reference is an immutable snapshot of ordered
 * parts; re-capturing the same region produces a new reference instead of
 * mutating this one.
 *
 * The protocol is deliberately provider-scoped (`dsh-browser`) so other plugins
 * can own their own reference namespaces without sharing this schema.
 * @module dsh-browser/browser-reference/types
 */

import type { ReferenceTextNode } from '../reference-text.ts'

/** Where the capture happened; reveal routes back to the same carrier. */
export type BrowserReferenceCarrier = 'sidebar' | 'bundled' | 'chrome' | 'edge'

/** How the user asked for the reference. */
export type BrowserReferenceEntry = 'native-menu' | 'extension-action' | 'page-overlay' | 'agent-tool'

/** Who selected the content: a human in the page, or the agent's own read. */
export type BrowserReferenceOrigin = 'user-selection' | 'agent-excerpt'

/** A text quote selector: the selected text plus enough context to be unique. */
export interface TextQuoteAnchor {
  /** The selected text itself, original whitespace preserved. */
  readonly exact: string
  /** Up to N characters immediately before the selection, for disambiguation. */
  readonly prefix: string
  /** Up to N characters immediately after the selection. */
  readonly suffix: string
}

/** One ordered piece of a reference. */
export interface TextReferencePart {
  readonly partId: string
  readonly type: 'text'
  readonly text: string
  readonly content?: readonly ReferenceTextNode[]
  readonly anchor: TextQuoteAnchor
}

/** How an image element was found when the reference was captured. */
export interface ImageAnchor {
  /** The resolved source the browser was showing. */
  readonly src?: string
  /** `HTMLImageElement.currentSrc`, when the browser exposed one. */
  readonly currentSrc?: string
  readonly alt?: string
  /** Best-effort CSS selector, a hint only. */
  readonly selector?: string
  /** Viewport geometry at capture time, a hint only. */
  readonly geometry?: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
  /** Present only for a visible-region snapshot: how the region was masked and clipped. */
  readonly visible?: {
    readonly rects: number
    readonly partiallyVisible: boolean
    readonly clip: { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
    readonly dpr: number
    readonly visualScale: number
    readonly viewport: { readonly width: number; readonly height: number }
    readonly scroll: { readonly x: number; readonly y: number }
  }
  /** Whether the saved bytes could be checked against the page session's own copy. */
  readonly versionStatus?: 'verified' | 'changed' | 'unverifiable'
}

/**
 * An image part. `representation` says what was actually saved, never what the
 * page claimed: a source image, a rasterised vector, or a visible-region snapshot.
 */
export interface ImageReferencePart {
  readonly partId: string
  readonly type: 'image'
  readonly assetKey: string
  readonly representation: 'source-image' | 'rasterized-image' | 'visible-snapshot'
  readonly alt?: string
  readonly caption?: string
  readonly anchor: ImageAnchor
}

/** One inline run of a table cell, in reading order. */
export type TableCellRun =
  | { readonly type: 'text'; readonly text: string }
  | { readonly type: 'image'; readonly partId: string; readonly assetKey: string }

/** One cell of a table snapshot, including its merge and selection facts. */
export interface TableCellSnapshot {
  readonly row: number
  readonly column: number
  readonly rowSpan: number
  readonly columnSpan: number
  readonly role: 'header' | 'data'
  readonly text: string
  readonly content?: readonly ReferenceTextNode[]
  readonly includedAs: 'selection' | 'header-context'
  readonly partialText: boolean
  /** Text and image runs in reading order; images carry their own partId/assetKey. */
  readonly inlineContent?: readonly TableCellRun[]
}

/** How a table was found when the reference was captured. */
export interface TableAnchor {
  readonly selector?: string
  readonly caption?: string
  /** Header texts, used to recognise the same table after re-sorting. */
  readonly headers: readonly string[]
  /** First-row cell texts, a weaker hint than the headers. */
  readonly firstCells: readonly string[]
  /** Which cell was selected, for highlighting the exact cell. */
  readonly cell?: { readonly row: number; readonly column: number }
}

/** A structural table snapshot; Markdown/TSV are projections of this, not replacements. */
export interface TableSnapshot {
  readonly rowCount: number
  readonly columnCount: number
  readonly cells: readonly TableCellSnapshot[]
  readonly caption?: string
  readonly completeness: 'selected-cells' | 'dom-table' | 'visible-rows' | 'aria-grid'
  readonly normalizationVersion: string
}

/** One ordered piece of a reference. */
export interface TableReferencePart {
  readonly partId: string
  readonly type: 'table'
  readonly table: TableSnapshot
  readonly anchor: TableAnchor
}

/** Any part; `mixed` is derived from a parts array with more than one kind. */
export type BrowserReferencePart = TextReferencePart | ImageReferencePart | TableReferencePart

/** Where the content came from. */
export interface BrowserReferenceSource {
  readonly pageUrl: string
  readonly title: string
  /** ISO timestamp taken when the snapshot was confirmed, not when capture started. */
  readonly capturedAt: string
  readonly frameUrl?: string
  /** The frame that owned the selection. Defaults to 'main'; 'frame' carries a selector. */
  readonly frameRoute?: 'main' | 'frame'
  /** Best-effort selector of the owning same-origin iframe, a hint only. */
  readonly frameSelector?: string
  readonly carrier: BrowserReferenceCarrier
}

/** One immutable capture, addressed by `dsh-browser-ref:<referenceId>/<partId?>`. */
export interface BrowserReference {
  /** Protocol version for this provider's records. */
  readonly version: 1
  readonly provider: 'dsh-browser'
  readonly referenceId: string
  /** Session that received the reference; absent only for an unbound agent excerpt. */
  readonly owner: {
    readonly sessionId?: string
    /**
     * The plugin's browser session holding the page. A DSH session and a browser
     * session are different ids; reveal needs the runtime handle, and it can
     * outlive the conversation that first asked for the page.
     */
    readonly browserSessionId?: string
  }
  readonly provenance: {
    readonly origin: BrowserReferenceOrigin
    readonly entry: BrowserReferenceEntry
  }
  readonly source: BrowserReferenceSource
  readonly parts: readonly BrowserReferencePart[]
  /**
   * The user's own note, captured with the reference (three-state §3). It is a
   * separate field from the page snapshot: editing it later never rewrites the
   * quoted original, and `manifestHashOf` deliberately excludes it so an edit
   * does not invalidate the capture.
   */
  readonly comment?: string
  /** SHA-256 over the canonical snapshot fields; detects tampering and duplicate conflicts. */
  readonly manifestHash: string
}

/**
 * An explicit right-click target. A selection may collapse while the native
 * menu is open, so the action names the object it was invoked on instead of
 * re-reading the selection (§3.2 / §3.3).
 */
export interface BrowserReferenceTarget {
  readonly kind: 'text' | 'image' | 'table'
  /** Source URL reported by the browser for an image target. */
  readonly srcUrl?: string
  /** View-relative pointer position, a DOM hint only. */
  readonly x?: number
  readonly y?: number
}
