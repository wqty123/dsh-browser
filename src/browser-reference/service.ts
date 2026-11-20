/**
 * Browser reference service: capture a page's selection into an immutable
 * snapshot, and reveal that snapshot later in the same page.
 *
 * WHAT CROSSES THE BOUNDARY
 * The page half is external content. Everything it returns is treated as
 * untrusted input: shapes are validated field by field, strings are capped, ids
 * are assigned here rather than taken from the page, and the manifest hash is
 * recomputed over the validated snapshot. A page that returns a fabricated
 * part cannot make the store hold something the page could never prove.
 *
 * The browser itself is reached through one injected function, so the whole
 * capture/reveal flow is testable without a browser and the carrier does not
 * matter: the same script runs through the only path every carrier has.
 * @module dsh-browser/browser-reference/service
 */

import { createHash, randomUUID } from 'node:crypto'
import { referenceOwnerKey } from '../reference-owner.ts'
import { sameReferenceDocument as samePage } from '../reference-page.ts'
import { isReferenceText, MAX_REFERENCE_TEXT, referenceTextContent } from '../reference-text.ts'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { manifestHashOf, ReferenceStore, referenceStorePath } from './store.ts'
import { MAX_REFERENCE_COMMENT } from './entry.ts'
import {
  collectAssetKeys, encodeReferenceExport,
} from './export.ts'
import type { ExportAsset, ReferenceExportFormat } from './export.ts'
import { findTextQuote } from './text-quote.ts'
import {
  captureScript,
  highlightScript,
  noticeScript,
  pageFactsScript,
  pageTextScript,
  rasterizeScript,
  revealElementScript,
} from './page-script.ts'
import { frameCaptureScript, validateFrameCapture, validateFrameSelector } from './entry.ts'
import {
  clipFromFacts,
  compareImageVersion,
  maskScript,
  unmaskScript,
  validateVisibleFacts,
  versionProbeScript,
  visibleFactsScript,
} from './visible.ts'
import type {
  ScreenshotFacts,
  VersionStatus,
  VisibleCaptureMeta,
  VisibleCaptureResult,
  VisibleClip,
} from './visible.ts'
import type {
  BrowserReference,
  BrowserReferenceCarrier,
  BrowserReferenceEntry,
  BrowserReferenceOrigin,
  BrowserReferencePart,
  ImageReferencePart,
  TableAnchor,
  TableCellRun,
  TableCellSnapshot,
  TableReferencePart,
  TextReferencePart,
  BrowserReferenceTarget,
} from './types.ts'
import type {
  RawCaptureEvent,
  RawCaptureResult,
  RawCell,
  RawCellRun,
  RawElementRevealResult,
  RawHighlightResult,
  RawPageTextResult,
  RawRasterResult,
  RawTable,
} from './page-script.ts'

/** One call into the page; the host supplies this from its carrier. */
export interface ReferenceEvaluateRequest {
  readonly script: string
  readonly args?: readonly unknown[]
  readonly timeoutMs?: number
}

/** The browser capabilities the service needs, and nothing else. */
export interface ReferenceHost {
  /** Evaluate a page script; the value may be the script's JSON string. */
  evaluate(sessionId: string, request: ReferenceEvaluateRequest, signal?: AbortSignal): Promise<unknown>
  /** Whether the owning browser session is still alive. */
  exists(sessionId: string): boolean
  /** Save one URL to a local file with the session's cookies, when the carrier can. */
  download?(sessionId: string, url: string, savePath: string, signal?: AbortSignal): Promise<void>
  /**
   * Capture a clipped, read-only visible-region screenshot. Optional: a host
   * without this capability keeps the source-image / rasterised-image paths.
   */
  captureVisible?(sessionId: string, clip: VisibleClip, signal?: AbortSignal): Promise<VisibleCaptureResult>
  now?(): Date
  newId?(): string
}

type MaterializedAsset = {
  assetKey: string
  representation: 'source-image' | 'rasterized-image' | 'visible-snapshot'
  versionStatus?: VersionStatus
  visible?: VisibleCaptureMeta
}

export interface ReferenceCaptureAction {
  readonly windowId: string
  readonly entry: 'native-menu' | 'page-overlay'
  readonly frameSelector?: string
  /** The image/table this action named, even if the selection collapsed. */
  readonly target?: BrowserReferenceTarget
  /** Optional note the human typed in the selection bar (three-state §3). */
  readonly comment?: string
  /**
   * Selection text frozen by the page bar before its comment field took focus.
   * When the live selection is already collapsed, this is what the capture
   * locates (and what keeps the reference from silently capturing nothing).
   */
  readonly selectionText?: string
  /**
   * The COMPLETE ordered capture the bar froze at that same moment: text runs,
   * assets and table ranges with their anchors. Preferred over `selectionText`,
   * which can only re-locate wording and therefore loses images/tables and can
   * pick a different occurrence of the same paragraph.
   */
  readonly capture?: RawCaptureResult
}

let referenceCaptureActionHandler: ((action: ReferenceCaptureAction) => Promise<void>) | undefined

/** Register the handler for a human right-click / floating-button intent. */
export function setReferenceCaptureActionHandler(
  handler: (action: ReferenceCaptureAction) => Promise<void>,
): () => void {
  referenceCaptureActionHandler = handler
  return () => { if (referenceCaptureActionHandler === handler) referenceCaptureActionHandler = undefined }
}

/** Called by the provider when the host reports a human reference action. */
export async function dispatchReferenceCaptureAction(action: ReferenceCaptureAction): Promise<void> {
  if (referenceCaptureActionHandler === undefined) throw new Error('reference capture handler is unavailable')
  await referenceCaptureActionHandler(action)
}

/** One piece of a capture that could not be committed. */
export interface CaptureFailure {
  readonly kind: 'text' | 'image' | 'table' | 'reference'
  readonly reason: string
  /** Anything a caller can show without reading the page again. */
  readonly detail?: Readonly<Record<string, unknown>>
}

/** Result of a capture attempt. `reference` is absent when the group was refused. */
export interface CaptureOutcome {
  readonly reference?: BrowserReference
  readonly failures: readonly CaptureFailure[]
}

/** What the caller wants captured. */
export interface CaptureRequest {
  /** The DSH session that owns the reference. */
  readonly sessionId: string
  /** The browser session holding the page; defaults to `sessionId`. */
  readonly browserSessionId?: string
  readonly origin?: BrowserReferenceOrigin
  readonly entry?: BrowserReferenceEntry
  readonly carrier?: BrowserReferenceCarrier
  /**
   * Commit the parts that succeeded even when some failed. The default is the
   * design's rule: a reference is an ordered whole, so a broken image does not
   * silently become a missing one.
   */
  readonly allowPartial?: boolean
  /** Capture this table even when the selection does not touch it. */
  readonly tableSelector?: string
  /** With no live selection, register this text as an agent excerpt. */
  readonly excerptText?: string
  /**
   * A complete capture the page bar froze while the selection still existed.
   * Used verbatim; the page is only re-read to confirm it is still the same
   * document, so a changed page is reported instead of capturing other text.
   */
  readonly frozenCapture?: RawCaptureResult
  /** Capture a same-origin iframe's selection instead of the top document. */
  readonly frameSelector?: string
  /** Capture THIS image/table/text even when the selection has collapsed. */
  readonly target?: BrowserReferenceTarget
  /** The user's own note, stored with the reference and never hashed. */
  readonly comment?: string
  /**
   * Prove that a downloaded image is the version the page had loaded. Default
   * true; a page that cannot be probed is reported as unverifiable, not as a
   * verified match, but does not by itself invalidate the capture.
   */
  readonly verifyImageVersion?: boolean
  /** Allow a masked visible-region snapshot when no trustworthy source bytes exist. */
  readonly allowVisibleSnapshot?: boolean
}

/** Per-part reveal result. */
export interface RevealPartResult {
  readonly partId: string
  readonly type: 'text' | 'image' | 'table'
  readonly status: 'revealed' | 'ambiguous' | 'missing'
  readonly matches?: number
  /** True when the literal text missed and whitespace-collapsed matching found it. */
  readonly collapsed?: boolean
  readonly note?: string
}

/** How a reveal call ended. */
export interface RevealOutcome {
  readonly referenceId: string
  readonly status: 'revealed' | 'partial' | 'ambiguous' | 'missing' | 'not-found' | 'page-mismatch' | 'session-unavailable' | 'unavailable'
  readonly pageUrl: string
  /** Where the browser is now, when it could be read. */
  readonly currentUrl?: string
  readonly parts: readonly RevealPartResult[]
  readonly note?: string
}

/**
 * The reserved seam for putting a reference into a DSH draft.
 *
 * The host has no plugin-facing draft API today (the composer is package
 * internal), so this plugin captures and stores references and leaves delivery
 * to whoever implements this interface. When a host adapter is registered the
 * same service can deliver; until then `insertIntoDraft` answers honestly that
 * no adapter exists.
 */
export interface BrowserReferenceDraftAdapter {
  insertReference(reference: BrowserReference, options: { readonly sessionId: string; readonly focus?: boolean }): Promise<{ readonly applied: boolean; readonly reason?: string }>
}

/** Tunables; every default is a cap the caller can only tighten. */
export interface BrowserReferenceServiceOptions {
  /** Characters of context on each side of a text anchor. Default 32. */
  readonly context?: number
  /** Longest single text part. Default 20000 characters. */
  readonly maxTextPartLength?: number
  /** Most parts in one reference. Default 64. */
  readonly maxParts?: number
  /** Most cells captured per table. Default 2000. */
  readonly maxTableCells?: number
  /** Page text budget for capture/reveal. Default 2 000 000 characters. */
  readonly maxPageText?: number
  /** Largest image kept. Default 20 MiB. */
  readonly maxImageBytes?: number
  /** Where image bytes live. Default `reference-assets` beside the store. */
  readonly assetDir?: string
  /** Page evaluation budget. Default 20 s. */
  readonly timeoutMs?: number
  readonly sourceSession?: (owner: string, pageId: string) => Promise<string>
}

/** Every limit after clamping; the caller's values only ever tighten these. */
interface ResolvedOptions {
  context: number
  maxTextPartLength: number
  maxParts: number
  maxTableCells: number
  maxPageText: number
  maxImageBytes: number
  timeoutMs: number
}


const DEFAULTS: ResolvedOptions = {
  context: 32,
  maxTextPartLength: MAX_REFERENCE_TEXT,
  maxParts: 64,
  maxTableCells: 2_000,
  maxPageText: 2_000_000,
  maxImageBytes: 20 * 1024 * 1024,
  timeoutMs: 20_000,
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function textOf(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.slice(0, limit) : ''
}

function integerOf(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback
  return Math.min(Math.max(number, min), max)
}

function booleanOf(value: unknown): boolean {
  return value === true
}

function numberPathOf(value: unknown): readonly number[] | undefined {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) return undefined
  const path: number[] = []
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isInteger(entry) || entry < 0 || entry > 1_000_000) return undefined
    path.push(entry)
  }
  return path
}

/** Decode a data URL into bytes and its declared MIME type. */
function decodeDataUrl(url: string): { bytes: Buffer; mime: string } | undefined {
  const match = /^data:([^;,]+)((?:;[^,]*)?),([\s\S]*)$/i.exec(url)
  if (match === null) return undefined
  const mime = match[1].toLowerCase()
  const parameters = match[2].toLowerCase()
  const payload = match[3]
  try {
    const bytes = parameters.includes(';base64')
      ? Buffer.from(payload, 'base64')
      : Buffer.from(decodeURIComponent(payload), 'utf8')
    return bytes.length > 0 ? { bytes, mime } : undefined
  } catch {
    return undefined
  }
}

/** Recognise the bytes rather than trusting a page-declared MIME type. */
export function sniffImageMime(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && bytes.toString('ascii', 0, 3) === 'GIF') return 'image/gif'
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.length >= 2 && bytes[0] === 0x42 && bytes[1] === 0x4d) return 'image/bmp'
  if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    const brand = bytes.toString('ascii', 8, 12)
    if (brand === 'avif' || brand === 'avis') return 'image/avif'
  }
  const head = bytes.toString('utf8', 0, Math.min(bytes.length, 512)).trimStart().toLowerCase()
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml'
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return 'image/x-icon'
  return undefined
}

/** What a stored asset file is, beside the bytes. */
export interface ReferenceAssetMeta {
  readonly assetKey: string
  readonly mime: string
  readonly bytes: number
  readonly sourceUrl: string
  readonly representation: 'source-image' | 'rasterized-image' | 'visible-snapshot'
  readonly savedAt: string
  /** Present when the bytes came from a URL that could be version-checked. */
  readonly versionStatus?: VersionStatus
  /** Present for a visible-region snapshot. */
  readonly visible?: VisibleCaptureMeta
}

/**
 * Capture and reveal browser references for one host.
 *
 * One instance per plugin context; the store is the only shared state.
 */
export class BrowserReferenceService {
  private adapter: BrowserReferenceDraftAdapter | undefined
  private readonly assetDir: string
  private readonly host: ReferenceHost
  private readonly options: ResolvedOptions
  private readonly store: ReferenceStore
  private readonly sourceSession: BrowserReferenceServiceOptions['sourceSession']

  constructor(host: ReferenceHost, store: ReferenceStore = new ReferenceStore(), options: BrowserReferenceServiceOptions = {}) {
    this.host = host
    this.store = store
    this.sourceSession = options.sourceSession
    this.options = {
      context: integerOf(options.context, DEFAULTS.context, 0, 512),
      maxTextPartLength: integerOf(options.maxTextPartLength, DEFAULTS.maxTextPartLength, 1, MAX_REFERENCE_TEXT),
      maxParts: integerOf(options.maxParts, DEFAULTS.maxParts, 1, 1_000),
      maxTableCells: integerOf(options.maxTableCells, DEFAULTS.maxTableCells, 1, 20_000),
      maxPageText: integerOf(options.maxPageText, DEFAULTS.maxPageText, 1_000, 50_000_000),
      maxImageBytes: integerOf(options.maxImageBytes, DEFAULTS.maxImageBytes, 1_024, 200 * 1024 * 1024),
      timeoutMs: integerOf(options.timeoutMs, DEFAULTS.timeoutMs, 1_000, 300_000),
    }
    this.assetDir = options.assetDir ?? join(dirname(referenceStorePath()), 'reference-assets')
  }

  /** Register the host's draft adapter; `undefined` removes it. */
  setDraftAdapter(adapter: BrowserReferenceDraftAdapter | undefined): void {
    this.adapter = adapter
  }

  /** The store, for listings. */
  get references(): ReferenceStore {
    return this.store
  }

  /** Read one reference. */
  get(referenceId: string): BrowserReference | undefined {
    return this.store.get(referenceId)
  }

  /** List references, newest last. */
  list(filter: { readonly sessionId?: string; readonly pageUrl?: string; readonly limit?: number } = {}): BrowserReference[] {
    return this.store.list(filter)
  }

  /** Absolute path of one stored asset, or undefined when it is absent. */
  assetPath(assetKey: string): string | undefined {
    if (!/^[0-9a-f]{64}$/.test(assetKey)) return undefined
    const file = join(this.assetDir, `${assetKey}.bin`)
    return existsSync(file) ? file : undefined
  }

  /**
   * Export stored records and the image bytes they bind.
   * @param options - output shape and an optional owning-session filter.
   * @returns the encoded file.
   */
  exportBundle(options: { readonly format: ReferenceExportFormat; readonly sessionId?: string }):
    { readonly fileName: string; readonly mime: string; readonly body: Buffer } {
    const references = this.store.list(options.sessionId === undefined ? {} : { sessionId: options.sessionId })
    const assets: ExportAsset[] = []
    for (const assetKey of collectAssetKeys(references)) {
      const file = this.assetPath(assetKey)
      if (file === undefined) continue
      let bytes: Buffer
      try { bytes = readFileSync(file) } catch { continue }
      let meta: { readonly mime?: unknown; readonly sourceUrl?: unknown } = {}
      try { meta = JSON.parse(readFileSync(file.replace(/\.bin$/u, '.json'), 'utf8')) as typeof meta } catch { /* legacy asset without a sidecar */ }
      const mime = typeof meta.mime === 'string' && meta.mime !== '' ? meta.mime : sniffImageMime(bytes)
      if (mime === undefined) continue
      assets.push({
        assetKey,
        mime,
        bytes,
        ...typeof meta.sourceUrl === 'string' && meta.sourceUrl !== '' ? { sourceUrl: meta.sourceUrl } : {},
      })
    }
    return encodeReferenceExport({
      references,
      assets,
      exportedAt: (this.host.now?.() ?? new Date()).toISOString(),
    }, options.format)
  }

  /**
   * Deliver one stored reference into a draft through the registered adapter.
   * @param referenceId - the stored reference.
   * @returns `ok: false` with a reason when no adapter exists or it refused.
   */
  async insertIntoDraft(referenceId: string): Promise<{ readonly ok: boolean; readonly reason?: string }> {
    const reference = this.store.get(referenceId)
    if (reference === undefined) return { ok: false, reason: 'reference-not-found' }
    if (this.adapter === undefined) return { ok: false, reason: 'draft-adapter-unavailable' }
    const sessionId = reference.owner.sessionId
    if (sessionId === undefined || sessionId === '') return { ok: false, reason: 'reference-has-no-session' }
    try {
      const result = await this.adapter.insertReference(reference, { sessionId, focus: false })
      return result.applied ? { ok: true } : { ok: false, reason: result.reason ?? 'draft-adapter-refused' }
    } catch (error) {
      return { ok: false, reason: String(error instanceof Error ? error.message : error) }
    }
  }

  /**
   * Capture the page's current selection (or one table / one excerpt).
   * @param request - what to capture and which session owns it.
   * @param signal - cancels the page evaluations.
   * @returns the stored reference, or the failures that prevented one.
   */
  async capture(request: CaptureRequest, signal?: AbortSignal): Promise<CaptureOutcome> {
    const sessionId = referenceOwnerKey(request.sessionId)
    if (sessionId === '') return { failures: [{ kind: 'reference', reason: 'session-id-required' }] }
    const browserSessionId = (request.browserSessionId ?? request.sessionId).trim()
    if (browserSessionId === '') return { failures: [{ kind: 'reference', reason: 'browser-session-id-required' }] }
    // A frozen capture needs no browser session: the page already handed over the complete snapshot, so
    // nothing has to be read from a tab. The Web sidebar is exactly that case — its guest is an iframe
    // the plugin does not own, so it has no browser:<uuid> at all, and requiring one refused every
    // quote with "session-unavailable" (measured 422 on every attempt, in every conversation).
    const fromFrozen = request.frozenCapture !== undefined && request.browserSessionId === undefined
    if (!fromFrozen && !this.host.exists(browserSessionId)) {
      return { failures: [{ kind: 'reference', reason: 'session-unavailable' }] }
    }

    const frameSelector = request.frameSelector === undefined ? undefined : validateFrameSelector(request.frameSelector)
    if (request.frameSelector !== undefined && frameSelector === undefined) {
      return { failures: [{ kind: 'reference', reason: 'invalid-frame-selector' }] }
    }
    let raw: RawCaptureResult
    try {
      const frozen = request.frozenCapture
      if (frozen !== undefined) {
        // The bar froze this while the real range still existed. Confirm the page
        // is still the same document before trusting it: a capture from a page
        // the user navigated away from must fail loudly, not silently become a
        // quote of whatever is on screen now.
        const frozenUrl = typeof frozen.url === 'string' ? frozen.url : ''
        // Only a capture that OWNS a browser session can be re-checked against the live page. A Web
        // sidebar capture has no such session (its guest is an iframe the plugin does not own), and
        // asking for page facts anyway failed the whole capture with a browser-session error.
        // Re-check the live page whenever this capture actually HAS a browser session; a Web sidebar
        // capture has none (its guest is an iframe the plugin does not own) and can only trust the
        // snapshot the page handed over. Asking for page facts without a session failed the capture.
        if (frozenUrl !== '' && this.host.exists(browserSessionId)) {
          const facts = await this.run<{ url?: unknown }>(browserSessionId, pageFactsScript(), [], signal)
          const currentUrl = typeof facts === 'object' && facts !== null && typeof (facts as { url?: unknown }).url === 'string'
            ? String((facts as { url: string }).url)
            : ''
          // Same rule as reveal: a fragment-only change is the same document.
          if (currentUrl !== '' && !samePage(currentUrl, frozenUrl)) {
            return { failures: [{ kind: 'reference', reason: 'page-changed' }] }
          }
        }
        raw = frozen
      } else if (frameSelector !== undefined) {
        const framed = validateFrameCapture(
          await this.run<unknown>(browserSessionId, frameCaptureScript(), [{
            frameSelector, context: this.options.context,
            maxChars: this.options.maxPageText, maxCells: this.options.maxTableCells,
            ...request.tableSelector !== undefined ? { tableSelector: request.tableSelector } : {},
            ...request.excerptText !== undefined && request.excerptText !== '' ? { excerptText: request.excerptText } : {},
            ...request.target !== undefined ? { target: request.target } : {},
          }], signal),
          frameSelector,
        )
        if (framed === undefined) return { failures: [{ kind: 'reference', reason: 'frame-capture-invalid' }] }
        if (framed.ok !== true) {
          return { failures: [{ kind: 'reference', reason: `frame-capture-refused: ${framed.reason ?? 'unavailable'}` }] }
        }
        raw = {
          ok: true,
          url: framed.url,
          frameUrl: framed.frameUrl,
          title: framed.title,
          events: (framed.events ?? []) as readonly RawCaptureEvent[],
        }
      } else {
        raw = await this.run<RawCaptureResult>(browserSessionId, captureScript(), [{
          context: this.options.context,
          maxChars: this.options.maxPageText,
          maxCells: this.options.maxTableCells,
          ...request.tableSelector !== undefined ? { tableSelector: request.tableSelector } : {},
          ...request.excerptText !== undefined && request.excerptText !== '' ? { excerptText: request.excerptText } : {},
          ...request.target !== undefined ? { target: request.target } : {},
        }], signal)
      }
    } catch (error) {
      return { failures: [{ kind: 'reference', reason: `capture-failed: ${messageOf(error)}` }] }
    }
    if (raw.ok !== true) {
      return { failures: [{ kind: 'reference', reason: textOf(raw.reason, 200) || 'capture-refused' }] }
    }

    const failures: CaptureFailure[] = []
    const parts: BrowserReferencePart[] = []
    const pageUrl = textOf(raw.url, 4000)
    // Without a page address the reference can never be revealed or checked for
    // "still the same page", so it is not a usable snapshot.
    if (pageUrl === '') return { failures: [{ kind: 'reference', reason: 'page-url-missing' }] }
    const events = Array.isArray(raw.events) ? raw.events : []
    let counter = 0
    const nextPartId = (): string => `p${++counter}`

    if (events.length > this.options.maxParts) {
      failures.push({ kind: 'reference', reason: 'too-many-parts', detail: { parts: events.length, limit: this.options.maxParts } })
    }

    for (const event of events.slice(0, this.options.maxParts)) {
      if (!isRecord(event)) continue
      const kind = textOf((event as RawCaptureEvent).kind, 20)
      if (kind === 'text') {
        const textPart = this.textPart(event as RawCaptureEvent, nextPartId)
        if ('reason' in textPart) failures.push(textPart)
        else parts.push(textPart)
      } else if (kind === 'image') {
        const imagePart = await this.imagePart(browserSessionId, event as RawCaptureEvent, nextPartId, signal, {
          verifyImageVersion: request.verifyImageVersion !== false,
          allowVisibleSnapshot: request.allowVisibleSnapshot !== false,
        })
        if ('reason' in imagePart) failures.push(imagePart)
        else parts.push(imagePart)
      } else if (kind === 'table') {
        const tablePart = await this.tablePart(browserSessionId, event as RawCaptureEvent, nextPartId, signal, {
          // A cell image is one image, not "whatever region is selected"; a
          // masked visible snapshot of the table would misreport it.
          verifyImageVersion: request.verifyImageVersion !== false,
          allowVisibleSnapshot: false,
        })
        if ('reason' in tablePart) failures.push(tablePart)
        else {
          parts.push(tablePart.part)
          parts.push(...tablePart.cellImages)
          failures.push(...tablePart.failures)
        }
      } else {
        failures.push({ kind: 'reference', reason: 'unsupported-part', detail: { kind } })
      }
    }

    if (parts.length === 0) {
      failures.push({ kind: 'reference', reason: 'nothing-captured' })
      return { failures }
    }
    if (failures.length > 0 && request.allowPartial !== true) return { failures }

    const carrier = request.carrier ?? 'bundled'
    // The comment is the human's own note; bound it so a hostile page cannot
    // turn it into an unbounded record, and trim rather than reject.
    const comment = textOf(request.comment, MAX_REFERENCE_COMMENT).trim()
    const origin = request.origin ?? 'user-selection'
    const entry = request.entry ?? 'agent-tool'
    const referenceId = this.host.newId?.() ?? randomUUID()
    const frameUrl = textOf(raw.frameUrl, 4000) || pageUrl
    const withoutHash = {
      version: 1 as const,
      provider: 'dsh-browser' as const,
      referenceId,
      owner: { sessionId, browserSessionId },
      provenance: { origin, entry },
      source: {
        pageUrl,
        title: textOf(raw.title, 500),
        capturedAt: (this.host.now?.() ?? new Date()).toISOString(),
        ...frameUrl !== '' ? {
          frameUrl,
          frameRoute: frameSelector !== undefined ? 'frame' as const : 'main' as const,
          ...frameSelector !== undefined ? { frameSelector } : {},
        } : {},
        carrier,
      },
      parts,
      ...comment !== '' ? { comment } : {},
    }
    const reference: BrowserReference = { ...withoutHash, manifestHash: manifestHashOf(withoutHash) }
    try {
      this.store.append(reference)
    } catch (error) {
      return { failures: [...failures, { kind: 'reference', reason: `store-refused: ${messageOf(error)}` }] }
    }
    return { reference, failures }
  }

  /**
   * Tell the page that its capture did not become a reference.
   *
   * A refused capture used to be stderr-only: the bar closed and the reader had
   * no idea why nothing appeared. This is best-effort — a page that navigated
   * away or a carrier without an evaluate path must not fail the capture.
   *
   * @param sessionId - the browser view the bar lives in.
   * @param text - one sentence for the reader.
   */
  async notify(sessionId: string, text: string): Promise<void> {
    try {
      await this.run<unknown>(sessionId, noticeScript(text), [])
    } catch {
      // Deliberately ignored: the delivery path already reported the failure.
    }
  }

  /**
   * Locate one stored reference in its page. Without a `partId` the group's
   * first part is located, which is the group's reading position.
   * @param referenceId - the stored reference.
   * @param request - optional specific part.
   * @param signal - cancels the page evaluations.
   */
  async reveal(referenceId: string, request: { readonly partId?: string; readonly navigate?: boolean; readonly sourcePageId?: string } = {}, signal?: AbortSignal): Promise<RevealOutcome> {
    const reference = this.store.get(referenceId)
    if (reference === undefined) return { referenceId, status: 'not-found', pageUrl: '', parts: [], note: 'no such reference is stored' }
    const captured = reference.owner.browserSessionId ?? reference.owner.sessionId
    const live = captured !== undefined && captured !== '' && this.host.exists(captured) ? captured : undefined
    let sessionId = live
    if (request.sourcePageId !== undefined) {
      const owner = referenceOwnerKey(reference.owner.sessionId ?? '')
      if (!owner || this.sourceSession === undefined) return { referenceId, status: 'unavailable', pageUrl: reference.source.pageUrl, parts: [], note: 'sidebar source binding unsupported' }
      try { sessionId = await this.sourceSession(owner, request.sourcePageId) }
      catch (error) { return { referenceId, status: 'unavailable', pageUrl: reference.source.pageUrl, parts: [], note: messageOf(error) } }
    }
    if (sessionId === undefined) {
      return {
        referenceId,
        status: 'session-unavailable',
        pageUrl: reference.source.pageUrl,
        parts: [],
        note: 'the browser session that captured this reference is gone',
      }
    }

    let facts: { readonly url?: unknown }
    try {
      facts = await this.run<{ url?: unknown }>(sessionId, pageFactsScript(), [], signal)
    } catch (error) {
      return { referenceId, status: 'unavailable', pageUrl: reference.source.pageUrl, parts: [], note: messageOf(error) }
    }
    const currentUrl = textOf(facts.url, 4000)
    if (!samePage(currentUrl, reference.source.pageUrl)) {
      return {
        referenceId,
        status: 'page-mismatch',
        pageUrl: reference.source.pageUrl,
        currentUrl,
        parts: [],
        note: 'the session is showing another page; open the stored URL before revealing',
      }
    }

    const target = request.partId === undefined
      ? reference.parts.slice(0, 1)
      : reference.parts.filter(part => part.partId === request.partId)
    if (target.length === 0) {
      return { referenceId, status: 'not-found', pageUrl: reference.source.pageUrl, currentUrl, parts: [], note: 'no such part in this reference' }
    }

    const results: RevealPartResult[] = []
    let pageText: string | undefined
    for (const part of target) {
      if (part.type === 'text') {
        try {
          if (pageText === undefined) {
            const read = await this.run<RawPageTextResult>(sessionId, pageTextScript(), [{ maxChars: this.options.maxPageText, legacy: part.content === undefined }], signal)
            pageText = textOf(read.text, this.options.maxPageText)
          }
          const locate = findTextQuote(pageText, part.anchor)
          if (locate.status === 'found' && locate.range !== undefined) {
            const highlight = await this.run<RawHighlightResult>(sessionId, highlightScript(), [{
              start: locate.range.start,
              end: locate.range.end,
              maxChars: this.options.maxPageText,
              legacy: part.content === undefined,
            }], signal)
            results.push({
              partId: part.partId,
              type: 'text',
              status: highlight.ok === true ? 'revealed' : 'missing',
              matches: locate.matches.length,
              collapsed: locate.collapsed,
              ...highlight.ok === true ? {} : { note: textOf(highlight.reason, 200) || 'highlight-failed' },
            })
          } else {
            results.push({
              partId: part.partId,
              type: 'text',
              status: locate.status === 'ambiguous' ? 'ambiguous' : 'missing',
              matches: locate.matches.length,
              collapsed: locate.collapsed,
            })
          }
        } catch (error) {
          results.push({ partId: part.partId, type: 'text', status: 'missing', note: messageOf(error) })
        }
      } else if (part.type === 'image') {
        const result = await this.revealElement(sessionId, 'image', {
          ...part.anchor,
          ...part.alt !== undefined ? { alt: part.alt } : {},
        }, signal)
        results.push({ partId: part.partId, type: 'image', status: result.status, matches: result.matches })
      } else {
        const result = await this.revealElement(sessionId, 'table', part.anchor, signal)
        results.push({ partId: part.partId, type: 'table', status: result.status, matches: result.matches })
      }
    }

    const revealed = results.filter(result => result.status === 'revealed').length
    const status: RevealOutcome['status'] = revealed === results.length
      ? 'revealed'
      : revealed > 0 ? 'partial' : results.some(result => result.status === 'ambiguous') ? 'ambiguous' : 'missing'
    return { referenceId, status, pageUrl: reference.source.pageUrl, currentUrl, parts: results }
  }

  private async revealElement(
    sessionId: string,
    kind: 'image' | 'table',
    anchor: object,
    signal?: AbortSignal,
  ): Promise<{ status: 'revealed' | 'ambiguous' | 'missing'; matches?: number }> {
    try {
      const result = await this.run<RawElementRevealResult>(sessionId, revealElementScript(), [{
        kind,
        anchor,
      }], signal)
      const status = result.status === 'found' ? 'revealed' : result.status === 'ambiguous' ? 'ambiguous' : 'missing'
      return { status, ...typeof result.matches === 'number' ? { matches: result.matches } : {} }
    } catch {
      return { status: 'missing' }
    }
  }

  /** Validate one text event into a part, or a failure. */
  private textPart(event: RawCaptureEvent, nextPartId: () => string): TextReferencePart | CaptureFailure {
    const exact = textOf(event.exact, this.options.maxTextPartLength + 1)
    if (exact.trim() === '') return { kind: 'text', reason: 'empty-text' }
    if (exact.length > this.options.maxTextPartLength) {
      return { kind: 'text', reason: 'text-too-long', detail: { characters: exact.length, limit: this.options.maxTextPartLength } }
    }
    if (event.content !== undefined && (!isReferenceText(event.content)
      || referenceTextContent(event.content).replace(/\s/gu, '') !== exact.replace(/\s/gu, ''))) {
      return { kind: 'text', reason: 'invalid-text-content' }
    }
    return {
      partId: nextPartId(),
      type: 'text',
      text: exact,
      ...(event.content === undefined ? {} : { content: event.content }),
      anchor: {
        exact,
        prefix: textOf(event.prefix, 512),
        suffix: textOf(event.suffix, 512),
      },
    }
  }

  /** Validate one image event, materialise its bytes, or fail it. */
  private async imagePart(
    sessionId: string,
    event: RawCaptureEvent,
    nextPartId: () => string,
    signal?: AbortSignal,
    policy: { readonly verifyImageVersion: boolean; readonly allowVisibleSnapshot: boolean } = {
      verifyImageVersion: true, allowVisibleSnapshot: true,
    },
  ): Promise<ImageReferencePart | CaptureFailure> {
    const currentSrc = textOf(event.currentSrc, 4000)
    const src = textOf(event.src, 4000)
    const attributeSrc = textOf(event.attributeSrc, 4000)
    const dataUrl = textOf(event.dataUrl, Math.ceil(this.options.maxImageBytes * 4 / 3) + 4096)
    const alt = textOf(event.alt, 500)
    const selector = textOf(event.selector, 1000)
    const path = numberPathOf(event.path)
    if (currentSrc === '' && src === '' && attributeSrc === '' && dataUrl === '' && selector === '' && path === undefined) {
      return { kind: 'image', reason: 'image-has-no-source' }
    }
    const saved = await this.materializeImage(sessionId, {
      urls: [...new Set([dataUrl, currentSrc, src, attributeSrc].filter(url => url !== ''))],
      ...path !== undefined ? { path } : {},
      ...selector !== '' ? { selector } : {},
    }, signal, policy)
    if ('reason' in saved) return { kind: 'image', reason: saved.reason, ...saved.detail !== undefined ? { detail: saved.detail } : {} }
    const partId = nextPartId()
    const anchorSrc = /^data:/i.test(src) ? '' : src
    const anchorCurrent = /^data:/i.test(currentSrc) ? '' : currentSrc
    return {
      partId,
      type: 'image',
      assetKey: saved.assetKey,
      representation: saved.representation,
      ...alt !== '' ? { alt } : {},
      ...textOf(event.caption, 500) !== '' ? { caption: textOf(event.caption, 500) } : {},
      anchor: {
        ...anchorSrc !== '' ? { src: anchorSrc } : {},
        ...anchorCurrent !== '' ? { currentSrc: anchorCurrent } : {},
        ...alt !== '' ? { alt } : {},
        ...selector !== '' ? { selector } : {},
        ...isRecord(event.geometry) ? { geometry: {
          x: integerOf(event.geometry.x, 0, -1_000_000, 1_000_000),
          y: integerOf(event.geometry.y, 0, -1_000_000, 1_000_000),
          w: integerOf(event.geometry.w, 0, 0, 1_000_000),
          h: integerOf(event.geometry.h, 0, 0, 1_000_000),
        } } : {},
        ...saved.versionStatus !== undefined ? { versionStatus: saved.versionStatus } : {},
        ...saved.visible !== undefined ? { visible: {
          rects: saved.visible.rects,
          partiallyVisible: saved.visible.partiallyVisible,
          clip: {
            x: saved.visible.clip.x, y: saved.visible.clip.y,
            width: saved.visible.clip.width, height: saved.visible.clip.height,
          },
          dpr: saved.visible.dpr,
          visualScale: saved.visible.visualScale,
          viewport: saved.visible.viewport,
          scroll: saved.visible.scroll,
        } } : {},
      },
    }
  }

  /**
   * Try the page's real bytes first, then a page-side raster, then — only when
   * the host can take a read-only clipped screenshot — a masked visible-region
   * snapshot. Remember which one the stored asset actually is.
   *
   * B33/B57: a URL may serve a newer asset between selection and download.
   * When the page session can still be probed and its digest disagrees with the
   * downloaded bytes, those bytes are NEVER advertised as 'source-image'.
   * An unprobeable page is reported as unverifiable, not as a verified match.
   */
  private async materializeImage(
    sessionId: string,
    image: { readonly urls: readonly string[]; readonly path?: readonly number[]; readonly selector?: string },
    signal?: AbortSignal,
    policy: { readonly verifyImageVersion: boolean; readonly allowVisibleSnapshot: boolean } = {
      verifyImageVersion: true, allowVisibleSnapshot: true,
    },
  ): Promise<MaterializedAsset | { reason: string; detail?: Record<string, unknown> }> {
    let versionChangedUrl = ''
    for (const url of image.urls) {
      if (/^data:image\//i.test(url)) {
        const decoded = decodeDataUrl(url)
        if (decoded !== undefined && decoded.bytes.length <= this.options.maxImageBytes) {
          const saved = this.saveAsset(decoded.bytes, '', 'source-image')
          if (saved !== undefined) return saved
        }
        continue
      }
      if (/^https?:/i.test(url) && this.host.download !== undefined) {
        const temp = join(this.assetDir, '.tmp', `${randomUUID()}.bin`)
        mkdirSync(dirname(temp), { recursive: true })
        try {
          await this.host.download(sessionId, url, temp, signal)
          const bytes = readFileSync(temp)
          if (bytes.length > 0 && bytes.length <= this.options.maxImageBytes) {
            let status: VersionStatus = 'unverifiable'
            if (policy.verifyImageVersion) {
              try {
                const probe = await this.run<unknown>(sessionId, versionProbeScript(), [{ url }], signal)
                status = compareImageVersion(probe, bytes)
              } catch {
                // A blocked page fetch, a dead session or a timed-out evaluate
                // is not evidence either way. Keep the old honest behaviour and
                // record the uncertainty in the asset sidecar.
                status = 'unverifiable'
              }
            }
            if (status === 'changed') {
              versionChangedUrl = url
              continue
            }
            const saved = this.saveAsset(bytes, url, 'source-image', { versionStatus: status })
            if (saved !== undefined) return { ...saved, versionStatus: status }
          }
        } catch { /* the page-side raster below is the next honest attempt */ } finally {
          try { rmSync(temp, { force: true }) } catch { /* temp file already gone */ }
        }
      }
    }

    let rasterReason: string | undefined
    try {
      const raster = await this.run<RawRasterResult>(sessionId, rasterizeScript(), [{
        path: image.path,
        selector: image.selector,
        maxDimension: 1600,
      }], signal)
      if (raster.ok === true && typeof raster.dataUrl === 'string') {
        const decoded = decodeDataUrl(raster.dataUrl)
        if (decoded !== undefined && decoded.bytes.length <= this.options.maxImageBytes) {
          const sourceUrl = image.urls.find(url => !/^data:/i.test(url)) ?? ''
          const saved = this.saveAsset(decoded.bytes, sourceUrl, 'rasterized-image')
          if (saved !== undefined) return saved
        }
      } else {
        rasterReason = textOf(raster.reason, 100) || 'raster-failed'
      }
    } catch (error) {
      rasterReason = messageOf(error)
    }

    if (policy.allowVisibleSnapshot) {
      const visible = await this.tryVisibleSnapshot(sessionId, signal)
      if (visible !== undefined) return visible
    }
    if (versionChangedUrl !== '') {
      return {
        reason: 'image-version-changed',
        detail: { url: versionChangedUrl.slice(0, 300), status: 'changed' },
      }
    }
    if (rasterReason !== undefined) return { reason: 'image-unavailable', detail: { page: rasterReason } }
    return { reason: 'image-not-an-image' }
  }

  /**
   * B58/B12/B10: mask every rectangle outside the selection, capture only the
   * visible intersection, then remove the mask even when the capture fails.
   * The mask (not an oversized clip) is what keeps a multi-column selection
   * free of the neighbouring column's content.
   */
  private async tryVisibleSnapshot(sessionId: string, signal?: AbortSignal): Promise<MaterializedAsset | undefined> {
    if (this.host.captureVisible === undefined) return undefined
    let facts: ScreenshotFacts | undefined
    try {
      facts = validateVisibleFacts(await this.run<unknown>(sessionId, visibleFactsScript(), [], signal))
    } catch { return undefined }
    if (facts === undefined) return undefined
    const planned = clipFromFacts(facts)
    if (planned === undefined) return undefined
    // The mask is applied BEFORE the screenshot and removed in `finally`. The
    // flag is set before the page call, not after it returns: a timed-out call
    // may still have run, and leaving the shade over the human's page would be a
    // visible, permanent side effect of a failed capture.
    let maskAttempted = false
    try {
      maskAttempted = true
      await this.run<unknown>(sessionId, maskScript(), [{
        rects: facts.rects,
        viewportWidth: facts.viewportWidth,
        viewportHeight: facts.viewportHeight,
      }], signal)
      const shot = await this.host.captureVisible(sessionId, planned.clip, signal)
      const decoded = decodeDataUrl(shot.dataUrl)
      if (decoded === undefined || decoded.bytes.length === 0 || decoded.bytes.length > this.options.maxImageBytes) return undefined
      const saved = this.saveAsset(decoded.bytes, '', 'visible-snapshot', { visible: planned.meta })
      if (saved === undefined) return undefined
      return { ...saved, visible: planned.meta }
    } catch {
      return undefined
    } finally {
      if (maskAttempted) {
        // No signal on purpose: an aborted or timed-out capture is exactly when
        // the page most needs its shade removed, so cleanup must not be cancelled.
        try { await this.run<unknown>(sessionId, unmaskScript(), []) } catch { /* best effort cleanup */ }
      }
    }
  }

  /** Write content-addressed bytes plus a metadata sidecar. */
  private saveAsset(
    bytes: Buffer,
    sourceUrl: string,
    representation: 'source-image' | 'rasterized-image' | 'visible-snapshot',
    extra: { readonly versionStatus?: VersionStatus; readonly visible?: VisibleCaptureMeta } = {},
  ): MaterializedAsset | undefined {
    const mime = sniffImageMime(bytes)
    if (mime === undefined) return undefined
    const assetKey = createHash('sha256').update(bytes).digest('hex')
    mkdirSync(this.assetDir, { recursive: true })
    const file = join(this.assetDir, `${assetKey}.bin`)
    if (!existsSync(file)) {
      const temp = `${file}.${process.pid}-${randomUUID()}.tmp`
      writeFileSync(temp, bytes)
      renameSync(temp, file)
    }
    const meta: ReferenceAssetMeta = {
      assetKey,
      mime,
      bytes: bytes.length,
      sourceUrl,
      representation,
      savedAt: (this.host.now?.() ?? new Date()).toISOString(),
      ...extra.versionStatus !== undefined ? { versionStatus: extra.versionStatus } : {},
      ...extra.visible !== undefined ? { visible: extra.visible } : {},
    }
    const metaFile = join(this.assetDir, `${assetKey}.json`)
    if (!existsSync(metaFile)) {
      // Same atomic temp + rename as the .bin above: two processes (or a crash
      // mid-write) must never leave a half-written sidecar that /asset would
      // silently serve as application/octet-stream.
      const temp = `${metaFile}.${process.pid}-${randomUUID()}.tmp`
      writeFileSync(temp, JSON.stringify(meta))
      renameSync(temp, metaFile)
    }
    return { assetKey, representation }
  }

  /** Validate one table event into a part plus the image parts its cells carry. */
  private async tablePart(
    sessionId: string,
    event: RawCaptureEvent,
    nextPartId: () => string,
    signal?: AbortSignal,
    policy: { readonly verifyImageVersion: boolean; readonly allowVisibleSnapshot: boolean } = {
      verifyImageVersion: true, allowVisibleSnapshot: false,
    },
  ): Promise<{ part: TableReferencePart; cellImages: ImageReferencePart[]; failures: CaptureFailure[] } | CaptureFailure> {
    const raw = event.table
    if (!isRecord(raw)) return { kind: 'table', reason: 'table-missing' }
    const table = raw as RawTable
    const rawCells = Array.isArray(table.cells) ? table.cells : []
    if (rawCells.length === 0) return { kind: 'table', reason: 'table-empty' }
    if (booleanOf(table.truncated) || rawCells.length > this.options.maxTableCells) {
      return {
        kind: 'table',
        reason: 'table-too-large',
        detail: { cells: rawCells.length, limit: this.options.maxTableCells },
      }
    }

    const failures: CaptureFailure[] = []
    const cellImages: ImageReferencePart[] = []
    const cells: TableCellSnapshot[] = []
    // The table comes first in `parts`, so it takes its id before the cell images it carries:
    // ids must read in part order or a caller citing `p1` would mean the image, not the table.
    const tablePartId = nextPartId()
    let firstSelectedCell: { row: number; column: number } | undefined

    for (const candidate of rawCells) {
      if (!isRecord(candidate)) continue
      const cell = candidate as RawCell
      const row = integerOf(cell.row, -1, 0, 100_000)
      const column = integerOf(cell.column, -1, 0, 10_000)
      if (row < 0 || column < 0) continue
      const role = cell.role === 'header' ? 'header' : 'data'
      const includedAs = cell.includedAs === 'header-context' ? 'header-context' : 'selection'
      const runs: TableCellRun[] = []
      for (const rawRun of Array.isArray(cell.inlineContent) ? cell.inlineContent.slice(0, 50) : []) {
        if (!isRecord(rawRun)) continue
        const run = rawRun as RawCellRun
        if (run.type === 'text') {
          const text = textOf(run.text, 2000)
          if (text !== '') runs.push({ type: 'text', text })
        } else if (run.type === 'image') {
          const saved = await this.materializeImage(sessionId, {
            urls: [...new Set([textOf(run.currentSrc, 4000), textOf(run.src, 4000)].filter(url => url !== ''))],
          }, signal, policy)
          if ('reason' in saved) {
            failures.push({ kind: 'image', reason: `cell-image: ${saved.reason}`, detail: { row, column } })
            continue
          }
          const partId = nextPartId()
          runs.push({ type: 'image', partId, assetKey: saved.assetKey })
          cellImages.push({
            partId,
            type: 'image',
            assetKey: saved.assetKey,
            representation: saved.representation,
            anchor: {
              ...textOf(run.currentSrc, 4000) !== '' ? { currentSrc: textOf(run.currentSrc, 4000) } : {},
              ...textOf(run.src, 4000) !== '' ? { src: textOf(run.src, 4000) } : {},
              ...textOf(run.alt, 500) !== '' ? { alt: textOf(run.alt, 500) } : {},
            },
          })
        }
      }
      const snapshot: TableCellSnapshot = {
        row,
        column,
        rowSpan: integerOf(cell.rowSpan, 1, 1, 1000),
        columnSpan: integerOf(cell.columnSpan, 1, 1, 200),
        role,
        text: textOf(cell.text, 2000),
        includedAs,
        partialText: booleanOf(cell.partialText),
        ...runs.length > 0 ? { inlineContent: runs } : {},
      }
      if (firstSelectedCell === undefined && includedAs === 'selection') firstSelectedCell = { row, column }
      cells.push(snapshot)
    }
    if (cells.length === 0) return { kind: 'table', reason: 'table-empty' }

    const headers: string[] = []
    const firstCells: string[] = []
    for (const cell of cells) {
      // Every header the page captured is a locate hint: one selected header and one kept as
      // context are equally good at recognising the same table after a re-render.
      if (cell.role === 'header' && headers.length < 8 && cell.text !== '' && !headers.includes(cell.text)) headers.push(cell.text)
      if (cell.row === 0 && firstCells.length < 8) firstCells.push(cell.text)
    }
    const completeness = table.completeness === 'visible-rows' || table.completeness === 'dom-table' || table.completeness === 'aria-grid'
      ? table.completeness
      : 'selected-cells'
    const anchor: TableAnchor = {
      ...textOf(event.selector, 1000) !== '' ? { selector: textOf(event.selector, 1000) } : {},
      ...textOf(table.caption, 500) !== '' ? { caption: textOf(table.caption, 500) } : {},
      headers,
      firstCells,
      ...firstSelectedCell !== undefined ? { cell: firstSelectedCell } : {},
    }
    return {
      part: {
        partId: tablePartId,
        type: 'table',
        table: {
          rowCount: integerOf(table.rowCount, 0, 0, 100_000),
          columnCount: integerOf(table.columnCount, 0, 0, 10_000),
          cells,
          ...textOf(table.caption, 500) !== '' ? { caption: textOf(table.caption, 500) } : {},
          completeness,
          normalizationVersion: '1',
        },
        anchor,
      },
      cellImages,
      failures,
    }
  }

  private async run<T>(sessionId: string, script: string, args: readonly unknown[], signal?: AbortSignal): Promise<T> {
    const value = await this.host.evaluate(sessionId, {
      script,
      args,
      timeoutMs: this.options.timeoutMs,
    }, signal)
    const parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value
    if (!isRecord(parsed)) throw new Error('browser reference: the page returned no usable result')
    return parsed as T
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** What a list row or tool answer carries; the full parts stay in the store. */
export interface ReferenceSummary {
  readonly referenceId: string
  readonly title: string
  readonly pageUrl: string
  readonly capturedAt: string
  readonly carrier: BrowserReferenceCarrier
  readonly origin: BrowserReferenceOrigin
  readonly entry: BrowserReferenceEntry
  readonly partCount: number
  readonly parts: readonly { readonly partId: string; readonly type: string; readonly preview: string }[]
}

/**
 * Project one reference into the compact shape a list or a tool answer shows.
 * @param reference - the stored snapshot.
 */
export function summarizeReference(reference: BrowserReference): ReferenceSummary {
  return {
    referenceId: reference.referenceId,
    title: reference.source.title,
    pageUrl: reference.source.pageUrl,
    capturedAt: reference.source.capturedAt,
    carrier: reference.source.carrier,
    origin: reference.provenance.origin,
    entry: reference.provenance.entry,
    partCount: reference.parts.length,
    parts: reference.parts.map(part => {
      if (part.type === 'text') {
        return { partId: part.partId, type: 'text', preview: part.text.replace(/\s+/g, ' ').slice(0, 160) }
      }
      if (part.type === 'image') {
        return { partId: part.partId, type: 'image', preview: part.alt ?? part.caption ?? part.anchor.src ?? '' }
      }
      const shape = `${part.table.rowCount}x${part.table.columnCount}`
      return { partId: part.partId, type: 'table', preview: part.table.caption !== undefined ? `${part.table.caption} (${shape})` : shape }
    }),
  }
}

/** The browser surface the service needs; `BrowserRuntime` satisfies it structurally. */
export interface BrowserRuntimeLike {
  execute(
    session: string,
    request: { readonly script: string; readonly args?: readonly unknown[]; readonly timeoutMs?: number },
    signal?: AbortSignal,
  ): Promise<{ readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly exception: string }>
  exists(session: string): boolean
  download(session: string, request: { readonly url: string; readonly savePath: string }, signal?: AbortSignal): Promise<{ readonly path: string }>
}

/**
 * Build the service against the plugin's browser runtime.
 * @param browser - the `ctx.browser` runtime.
 * @param options - optional caps and store overrides.
 */
export function createReferenceService(
  browser: BrowserRuntimeLike,
  options: BrowserReferenceServiceOptions & {
    readonly store?: ReferenceStore
    /** Optional: a read-only clipped screenshot for masked visible snapshots. */
    readonly visibleCapture?: (sessionId: string, clip: VisibleClip, signal?: AbortSignal) => Promise<VisibleCaptureResult>
  } = {},
): BrowserReferenceService {
  const { store, visibleCapture, ...rest } = options
  return new BrowserReferenceService({
    evaluate: async (sessionId, request, signal) => {
      const result = await browser.execute(sessionId, {
        script: request.script,
        ...request.args !== undefined ? { args: request.args } : {},
        ...request.timeoutMs !== undefined ? { timeoutMs: request.timeoutMs } : {},
      }, signal)
      if (!result.ok) throw new Error(result.exception)
      return result.value
    },
    exists: sessionId => browser.exists(sessionId),
    download: async (sessionId, url, savePath, signal) => {
      await browser.download(sessionId, { url, savePath }, signal)
    },
    ...visibleCapture !== undefined ? { captureVisible: visibleCapture } : {},
  }, store ?? new ReferenceStore(), rest)
}
