/**
 * HTTP surface for browser references: list, read, capture, reveal, delivery
 * into the conversation draft, and the actual image bytes behind a reference.
 *
 * Reads are authenticated by the host cookie alone, like every other plugin
 * route. Writes add the same two browser boundaries the bridge action uses —
 * same origin and a direct loopback peer — because a capture reads the page the
 * human is looking at and a delivery writes into their draft.
 *
 * The page is never named by the caller: capture and reveal act on the browser
 * session recorded in the reference, so a request cannot point the plugin at
 * another conversation's page by inventing an id.
 * @module dsh-browser/browser-electron/reference-route
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { BrowserHttpHandler } from './authenticated-route.ts'
import { isDirectLoopback } from './authenticated-route.ts'
import { readBinaryBody, readJsonBody } from './http-body.ts'
import { replyJson } from './json-reply.ts'
import { sameOrigin } from './settings-route.ts'
import { importReferenceBundle } from '../browser-reference/import.ts'
import { validateFrameSelector } from '../browser-reference/entry.ts'
import { summarizeReference, type ReferenceSummary } from '../browser-reference/service.ts'
import type { BrowserReferenceService } from '../browser-reference/service.ts'
import type { DeliveryQueue } from '../browser-reference/delivery.ts'
import type { createSubmissionReceipts } from '../browser-reference/submission-receipts.ts'
import type { ReferenceExportFormat } from '../browser-reference/export.ts'
import type { BrowserReferenceCarrier, BrowserReferenceEntry, BrowserReferenceOrigin, BrowserReferenceTarget } from '../browser-reference/types.ts'

/** Paths this module serves. */
export const REFERENCE_LIST_ROUTE = '/dsh-builtin-browser/reference/list'
export const REFERENCE_GET_ROUTE = '/dsh-builtin-browser/reference/get'
/**
 * The id the host keys its stores on.
 *
 * The shell stamps its own DOM with \`session-<uuid>\`, and the client polls with that value, while
 * captures are stored under the bare id. Without this the dock asked for "session-…" and always got an
 * empty delivery list, so a capture from the Web sidebar never became a pill.
 * @param value - a session id in either form.
 * @returns the same id without a leading \`session-\`.
 */
export function bareSession(value: string): string {
  return value.startsWith('session-') ? value.slice('session-'.length) : value
}

/** 客户端产物的版本（mtime+size），用于让浏览器自动换到新 bundle。 */
export const CLIENT_VERSION_ROUTE = '/dsh-builtin-browser/client-version'

export const REFERENCE_CAPTURE_ROUTE = '/dsh-builtin-browser/reference/capture'
export const REFERENCE_REVEAL_ROUTE = '/dsh-builtin-browser/reference/reveal'
export const REFERENCE_INSERT_ROUTE = '/dsh-builtin-browser/reference/insert'
export const REFERENCE_EXPORT_ROUTE = '/dsh-builtin-browser/reference/export'
export const REFERENCE_IMPORT_ROUTE = '/dsh-builtin-browser/reference/import'
/** The client polls this to pick up captures that belong to its conversation. */
export const REFERENCE_DELIVERIES_ROUTE = '/dsh-builtin-browser/reference/deliveries'
/** Only the client may ACK, after the draft AND every image asset are durable. */
export const REFERENCE_DELIVERY_ACK_ROUTE = '/dsh-builtin-browser/reference/delivery/ack'
/** Remove a card: a tombstone that late retries cannot resurrect. */
export const REFERENCE_DELIVERY_REMOVE_ROUTE = '/dsh-builtin-browser/reference/delivery/remove'
/** Real bytes of a captured image, for the card thumbnail and the model block. */
export const REFERENCE_ASSET_ROUTE = '/dsh-builtin-browser/reference/asset'

/**
 * Diagnostic answer for the sidebar entry: which conversation this host serves, and
 * what its last scan of the conversation's sidebar pages found.
 */
export const REFERENCE_STATUS_ROUTE = '/dsh-builtin-browser/reference/status'

const EXPORT_FORMATS: readonly ReferenceExportFormat[] = ['jsonl', 'markdown', 'zip', 'markdown-zip']

const CARRIERS: readonly BrowserReferenceCarrier[] = ['sidebar', 'bundled', 'chrome', 'edge']
const ENTRIES: readonly BrowserReferenceEntry[] = ['native-menu', 'extension-action', 'page-overlay', 'agent-tool']
const ORIGINS: readonly BrowserReferenceOrigin[] = ['user-selection', 'agent-excerpt']

function stringOf(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value !== '' ? value.slice(0, max) : undefined
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? value as T : undefined
}

/** Options for the route set. */
export interface ReferenceRouteOptions {
  readonly service: BrowserReferenceService
  /** Carrier recorded for captures that do not name one (the panel's capture path). */
  readonly carrier?: () => BrowserReferenceCarrier
  /** Durable hand-off queue between capture and the conversation draft. */
  readonly queue?: DeliveryQueue
  readonly receipts?: ReturnType<typeof createSubmissionReceipts>
}

/** The handlers, one per registered exact path. */
export interface ReferenceRouteHandlers {
  readonly list: BrowserHttpHandler
  readonly get: BrowserHttpHandler
  readonly capture: BrowserHttpHandler
  readonly reveal: BrowserHttpHandler
  readonly insert: BrowserHttpHandler
  readonly export: BrowserHttpHandler
  readonly importBundle: BrowserHttpHandler
  readonly deliveries: BrowserHttpHandler
  readonly ack: BrowserHttpHandler
  readonly removeDelivery: BrowserHttpHandler
  readonly asset: BrowserHttpHandler
}

function requireWrite(request: IncomingMessage, response: ServerResponse): boolean {
  if (request.method !== 'POST') { replyJson(response, 405, { ok: false, error: 'method-not-allowed' }); return false }
  if (!sameOrigin(request, true)) { replyJson(response, 403, { ok: false, error: 'not-same-origin' }); return false }
  if (!isDirectLoopback(request)) { replyJson(response, 403, { ok: false, error: 'local-request-required' }); return false }
  return true
}

function requireRead(request: IncomingMessage, response: ServerResponse): boolean {
  if (request.method !== 'GET') { replyJson(response, 405, { ok: false, error: 'method-not-allowed' }); return false }
  return true
}

/** Build every reference handler over one service. */
export function createReferenceRouteHandlers(options: ReferenceRouteOptions): ReferenceRouteHandlers {
  const { service, queue } = options
  const carrier = options.carrier ?? (() => 'bundled' as BrowserReferenceCarrier)

  const list: BrowserHttpHandler = (request, response) => {
    if (!requireRead(request, response)) return
    const url = new URL(request.url ?? '/', 'http://localhost')
    const limitText = url.searchParams.get('limit')
    const limit = limitText === null ? 20 : Number(limitText)
    const references = service.list({
      ...url.searchParams.get('sessionId') !== null ? { sessionId: bareSession(String(url.searchParams.get('sessionId'))) } : {},
      ...url.searchParams.get('pageUrl') !== null ? { pageUrl: String(url.searchParams.get('pageUrl')) } : {},
      limit: Number.isFinite(limit) ? Math.min(Math.max(Math.trunc(limit), 1), 100) : 20,
    })
    // Oldest first in the store; a panel reads newest first.
    replyJson(response, 200, { ok: true, references: references.slice().reverse().map(summarizeReference) })
  }

  const get: BrowserHttpHandler = (request, response) => {
    if (!requireRead(request, response)) return
    const url = new URL(request.url ?? '/', 'http://localhost')
    const id = url.searchParams.get('id')
    if (id === null || id === '') { replyJson(response, 400, { ok: false, error: 'id is required' }); return }
    const reference = service.get(id)
    if (reference === undefined) { replyJson(response, 404, { ok: false, error: 'reference-not-found' }); return }
    replyJson(response, 200, { ok: true, reference, summary: summarizeReference(reference) })
  }

  const capture: BrowserHttpHandler = async (request, response) => {
    if (!requireWrite(request, response)) return
    let body: Record<string, unknown>
    try {
      body = await readJsonBody<Record<string, unknown>>(request)
    } catch (error) {
      replyJson(response, 400, { ok: false, error: `unreadable body: ${String(error)}` })
      return
    }
    const sessionId = stringOf(body.sessionId, 200)
    if (sessionId === undefined) { replyJson(response, 400, { ok: false, error: 'sessionId is required' }); return }
    if (body.allowPartial !== undefined && typeof body.allowPartial !== 'boolean') {
      replyJson(response, 400, { ok: false, error: 'allowPartial must be a boolean' })
      return
    }
    const origin = body.origin === undefined ? 'user-selection' : oneOf(body.origin, ORIGINS)
    const entry = body.entry === undefined ? 'page-overlay' : oneOf(body.entry, ENTRIES)
    if (origin === undefined || entry === undefined) {
      replyJson(response, 400, { ok: false, error: 'origin or entry is not a known value' })
      return
    }
    const browserSessionId = stringOf(body.browserSessionId, 200)
    const tableSelector = stringOf(body.tableSelector, 1000)
    const excerptText = stringOf(body.excerptText, 20_000)
    let frameSelector: string | undefined
    // null means "no frame": the page-side bar sends the field explicitly, and validating null refused
  // every quote from the Web sidebar ("frameSelector is not a valid selector", measured 400 in the
  // guest's own log).
  if (body.frameSelector !== undefined && body.frameSelector !== null) {
      frameSelector = validateFrameSelector(body.frameSelector)
      if (frameSelector === undefined) {
        replyJson(response, 400, { ok: false, error: 'frameSelector is not a valid selector' })
        return
      }
    }
    // An explicit target names the image/table the human acted on. It is
    // validated here (shape, bounds, kind) so the page never receives arbitrary
    // values and a malformed target cannot silently degrade into "whatever the
    // selection happens to be".
    let target: BrowserReferenceTarget | undefined
    if (body.target !== undefined) {
      const raw = body.target
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        replyJson(response, 400, { ok: false, error: 'target must be an object' }); return
      }
      const candidate = raw as Record<string, unknown>
      const kind = candidate.kind
      if (kind !== 'text' && kind !== 'image' && kind !== 'table') {
        replyJson(response, 400, { ok: false, error: 'target.kind must be text, image or table' }); return
      }
      const srcUrl = stringOf(candidate.srcUrl, 4000)
      const x = typeof candidate.x === 'number' && Number.isFinite(candidate.x) ? candidate.x : undefined
      const y = typeof candidate.y === 'number' && Number.isFinite(candidate.y) ? candidate.y : undefined
      if ((candidate.x !== undefined && x === undefined) || (candidate.y !== undefined && y === undefined)) {
        replyJson(response, 400, { ok: false, error: 'target.x/y must be finite numbers' }); return
      }
      target = {
        kind,
        ...srcUrl !== undefined ? { srcUrl } : {},
        ...x !== undefined ? { x } : {},
        ...y !== undefined ? { y } : {},
      }
    }
    // The comment is the human's own note; an over-long one is bounded by the
    // service, but a non-string is a caller bug and is rejected.
    if (body.comment !== undefined && typeof body.comment !== 'string') {
      replyJson(response, 400, { ok: false, error: 'comment must be a string' }); return
    }
    const comment = typeof body.comment === 'string' ? body.comment : undefined
    // The page-side bar hands over a COMPLETE frozen snapshot. Forwarding it is what lets a capture
    // happen without a browser session at all: the Web sidebar's guest is an iframe the plugin does
    // not own, so it has no browser:<uuid>, and dropping this field refused every quote with
    // "session-unavailable" (measured 422 on every attempt).
    const frozenCapture = body.capture === undefined || body.capture === null ? undefined : body.capture as never
    const outcome = await service.capture({
      sessionId,
      ...browserSessionId !== undefined ? { browserSessionId } : {},
      origin,
      entry,
      carrier: oneOf(body.carrier, CARRIERS) ?? carrier(),
      ...typeof body.allowPartial === 'boolean' ? { allowPartial: body.allowPartial } : {},
      ...tableSelector !== undefined ? { tableSelector } : {},
      ...excerptText !== undefined ? { excerptText } : {},
      ...frameSelector !== undefined ? { frameSelector } : {},
      ...target !== undefined ? { target } : {},
      ...comment !== undefined ? { comment } : {},
      ...frozenCapture !== undefined ? { frozenCapture } : {},
    })
    if (outcome.reference === undefined) {
      replyJson(response, 422, { ok: false, failures: outcome.failures })
      return
    }
    // The HTTP capture path (agent tool / panel) feeds the SAME hand-off as a
    // right-click or floating entry: one durable queue, one owning session.
    if (queue !== undefined) {
      try {
        queue.prepare(outcome.reference, {
          failures: outcome.failures.map(failure => ({
            kind: failure.kind === 'text' || failure.kind === 'image' || failure.kind === 'table'
              ? failure.kind : 'reference',
            reason: failure.reason,
          })),
        })
      } catch (error) {
        // The reference is already durable, but WITHOUT a delivery the client
        // can never poll it: reporting 200 here produced the worst possible
        // state — a successful capture with a card that silently never appears.
        process.stderr.write(`[dsh-browser] reference delivery prepare failed: ${String(error)}\n`)
        replyJson(response, 409, {
          ok: false,
          error: 'delivery-enqueue-failed',
          reason: error instanceof Error ? error.message : String(error),
          reference: summarizeReference(outcome.reference),
        })
        return
      }
    }
    replyJson(response, 200, { ok: true, reference: summarizeReference(outcome.reference), failures: outcome.failures })
  }

  const reveal: BrowserHttpHandler = async (request, response) => {
    if (!requireWrite(request, response)) return
    let body: Record<string, unknown>
    try {
      body = await readJsonBody<Record<string, unknown>>(request)
    } catch (error) {
      replyJson(response, 400, { ok: false, error: `unreadable body: ${String(error)}` })
      return
    }
    const referenceId = stringOf(body.referenceId, 200)
    if (referenceId === undefined) { replyJson(response, 400, { ok: false, error: 'referenceId is required' }); return }
    const partId = stringOf(body.partId, 200)
    // Explicit jump: the caller wants the page moved to the stored URL rather
    // than a report that it is showing something else.
    const outcome = await service.reveal(referenceId, {
      ...partId !== undefined ? { partId } : {},
      ...body.navigate === true ? { navigate: true } : {},
    })
    replyJson(response, 200, { ok: true, ...outcome })
  }

  const insert: BrowserHttpHandler = async (request, response) => {
    if (!requireWrite(request, response)) return
    let body: Record<string, unknown>
    try {
      body = await readJsonBody<Record<string, unknown>>(request)
    } catch (error) {
      replyJson(response, 400, { ok: false, error: `unreadable body: ${String(error)}` })
      return
    }
    const referenceId = stringOf(body.referenceId, 200)
    if (referenceId === undefined) { replyJson(response, 400, { ok: false, error: 'referenceId is required' }); return }
    // The durable hand-off is the real path: the DSH client drains this queue
    // into the conversation draft, so a card appears only once the draft and its
    // assets are saved. A host without the queue keeps the adapter contract.
    if (queue !== undefined) {
      const reference = service.get(referenceId)
      if (reference === undefined) { replyJson(response, 404, { ok: false, reason: 'reference-not-found' }); return }
      try {
        const record = queue.prepare(reference)
        // A removed intent is a tombstone: `prepare` answers with it instead of
        // creating a second entry, so "insert" after a removal must say so rather
        // than report success for a card that will never appear.
        if (record.state === 'removed') {
          replyJson(response, 409, { ok: false, referenceId, intentId: record.intentId, state: record.state, reason: 'reference-was-removed' })
          return
        }
        replyJson(response, 200, {
          ok: true, referenceId, intentId: record.intentId, state: record.state,
        })
        return
      } catch (error) {
        replyJson(response, 409, { ok: false, reason: String(error instanceof Error ? error.message : error) })
        return
      }
    }
    const result = await service.insertIntoDraft(referenceId)
    replyJson(response, result.ok ? 200 : 409, result)
  }

  const exportBundle: BrowserHttpHandler = (request, response) => {
    if (!requireRead(request, response)) return
    const url = new URL(request.url ?? '/', 'http://localhost')
    const format = url.searchParams.get('format') ?? 'jsonl'
    if (!(EXPORT_FORMATS as readonly string[]).includes(format)) {
      replyJson(response, 400, { ok: false, error: 'format must be jsonl, markdown, zip, or markdown-zip' })
      return
    }
    const sessionId = url.searchParams.get('sessionId')
    const encoded = service.exportBundle({
      format: format as ReferenceExportFormat,
      ...sessionId !== null && sessionId !== '' ? { sessionId } : {},
    })
    response.writeHead(200, {
      'content-type': encoded.mime,
      'content-disposition': `attachment; filename="${encoded.fileName.replace(/["\\]/gu, '_')}"`,
      'content-length': String(encoded.body.length),
      'cache-control': 'no-store',
    })
    response.end(encoded.body)
  }

  /**
   * Restore a `format=zip` export. The same write boundaries as capture/insert apply: the body
   * is raw ZIP bytes (bounded), every hash is recomputed inside importReferenceBundle, and a
   * partially rejected package reports its per-reference reasons instead of claiming success.
   * The store and asset directory are the production defaults, which is what entry.ts builds the
   * service with; a caller that customises them can pass a store/assetDir through the options.
   */
  const importBundle: BrowserHttpHandler = async (request, response) => {
    if (!requireWrite(request, response)) return
    try {
      const zip = await readBinaryBody(request)
      const result = importReferenceBundle(zip)
      replyJson(response, 200, { ok: true, ...result })
    } catch (error) {
      replyJson(response, 400, { ok: false, error: `unreadable reference package: ${String(error)}` })
    }
  }

  /**
   * The client polls this with its OWN conversation id. A delivery is never
   * routed to "whatever session is active": `owner.sessionId` was fixed when
   * the page was captured, so switching conversations mid-capture cannot move
   * the reference (§3.5). Each record carries the whole frozen snapshot.
   */
  const deliveries: BrowserHttpHandler = (request, response) => {
    if (!requireRead(request, response)) return
    if (queue === undefined) { replyJson(response, 503, { ok: false, error: 'delivery-unavailable' }); return }
    const url = new URL(request.url ?? '/', 'http://localhost')
    const sessionId = url.searchParams.get('sessionId')
    // A poll must name its conversation. Answering without one would hand every
    // session's records to whoever asked, and the client would advance its cursor
    // past deliveries that were never meant for it.
    if (sessionId === null || sessionId === '') {
      replyJson(response, 400, { ok: false, error: 'sessionId is required' })
      return
    }
    const rawSince = url.searchParams.get('since')
    const since = rawSince === null ? 0 : Number(rawSince)
    // An unparsable/out-of-range cursor used to silently degrade into "no
    // since", replaying the conversation's ENTIRE history. A bad cursor is a
    // caller bug: say so instead of duplicating every old card.
    if (!Number.isSafeInteger(since) || since < 0) {
      replyJson(response, 400, { ok: false, error: 'invalid since' })
      return
    }
    const unverified = options.receipts?.recover(sessionId)
    const includeConsumed = url.searchParams.get('includeConsumed') === '1'
    const snapshot = queue.list({ sessionId, includeConsumed, ...since > 0 ? { since } : {} })
    // The cursor must never hide work that is still PENDING, whatever includeConsumed says. The client
    // advances its cursor to the queue's sequence on every poll, so a capture written between two polls
    // used to be invisible forever (measured: since=252 → 0 deliveries, since=0 → the same records).
    // Pending cards are idempotent by intentId, so re-offering them costs nothing.
    const pendingAll = queue.list({ sessionId, includeConsumed: false })
    const seen = new Set(snapshot.deliveries.map(record => String((record as { intentId?: string }).intentId)))
    const pending = [...snapshot.deliveries,
      ...pendingAll.deliveries.filter(record => !seen.has(String((record as { intentId?: string }).intentId)))]
    replyJson(response, 200, {
      ok: true,
      sequence: snapshot.sequence,
      ...(unverified === undefined ? {} : { tracksSubmissions: true, unverified }),
      deliveries: pending.map(record => ({
        intentId: record.intentId,
        sessionId: record.sessionId,
        browserSessionId: record.browserSessionId,
        referenceId: record.referenceId,
        state: record.state,
        failures: record.failures,
        assetKeys: record.assetKeys,
        requiredAssets: queue.requiredAssets(record),
        ...record.draftRev !== undefined ? { draftRev: record.draftRev } : {},
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        sequence: record.sequence,
        snapshot: record.snapshot,
      })),
    })
  }

  /**
   * `phase: 'acknowledged'` is refused unless the draft revision is real and
   * every image asset this reference needs is bound. That is the server-side
   * half of the rule "only claim success after the draft and assets are saved".
   */
  const ack: BrowserHttpHandler = async (request, response) => {
    if (!requireWrite(request, response)) return
    if (queue === undefined) { replyJson(response, 503, { ok: false, error: 'delivery-unavailable' }); return }
    let body: Record<string, unknown>
    try {
      body = await readJsonBody<Record<string, unknown>>(request)
    } catch (error) {
      replyJson(response, 400, { ok: false, error: `unreadable body: ${String(error)}` })
      return
    }
    if (body.phase === 'submitting') {
      const sessionId = stringOf(body.sessionId, 200)
      const requestId = stringOf(body.requestId, 200)
      const ids = body.intentIds
      if (sessionId === undefined || requestId === undefined || !Array.isArray(ids) || !ids.every(id => typeof id === 'string')) {
        replyJson(response, 400, { ok: false, error: 'invalid-submission' })
        return
      }
      if (!options.receipts?.bind(sessionId, requestId, ids)) {
        replyJson(response, 409, { ok: false, error: 'submission-not-bound' })
        return
      }
      replyJson(response, 200, { ok: true, state: 'submitting' })
      return
    }
    let intentId = stringOf(body.intentId, 200)
    // The records menu knows a reference id, not the intent that carried it.
    // Resolve it rather than making every caller learn the internal id.
    if (intentId === undefined) {
      const referenceId = stringOf(body.referenceId, 200)
      if (referenceId !== undefined) {
        intentId = queue.list().deliveries.find(entry => entry.referenceId === referenceId)?.intentId
      }
    }
    if (intentId === undefined) { replyJson(response, 400, { ok: false, error: 'intentId or referenceId is required' }); return }
    if (body.phase === 'consumed') {
      const sessionId = stringOf(body.sessionId, 200)
      if (sessionId === undefined) { replyJson(response, 400, { ok: false, error: 'sessionId is required' }); return }
      const record = queue.consume(intentId, sessionId)
      if (record === undefined) { replyJson(response, 409, { ok: false, error: 'delivery-owner-mismatch-or-removed' }); return }
      replyJson(response, 200, { ok: true, intentId, state: record.state, draftRev: record.draftRev ?? 0, assetKeys: record.assetKeys })
      return
    }
    if (!Number.isInteger(body.draftRev) || (body.draftRev as number) < 1) {
      replyJson(response, 400, { ok: false, error: 'draftRev must be a saved positive revision' }); return
    }
    if (!Array.isArray(body.assetKeys) || body.assetKeys.some(key => typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key))) {
      replyJson(response, 400, { ok: false, error: 'assetKeys must be content hashes' }); return
    }
    const deliveryAck = { draftRev: body.draftRev as number, assetKeys: body.assetKeys as string[] }
    const phase = body.phase === 'draft-applied' ? 'draft-applied' : 'acknowledged'
    const record = phase === 'draft-applied'
      ? queue.markDraftApplied(intentId, deliveryAck)
      : queue.acknowledge(intentId, deliveryAck)
    if (record === undefined) {
      replyJson(response, 409, { ok: false, error: 'delivery-not-acknowledgeable', reason: 'missing intent, removed, or assets not bound' })
      return
    }
    replyJson(response, 200, { ok: true, intentId, state: record.state, draftRev: record.draftRev, assetKeys: record.assetKeys })
  }

  /** Remove a card. The tombstone survives retries and a DSH restart. */
  const removeDelivery: BrowserHttpHandler = async (request, response) => {
    if (!requireWrite(request, response)) return
    if (queue === undefined) { replyJson(response, 503, { ok: false, error: 'delivery-unavailable' }); return }
    let body: Record<string, unknown>
    try {
      body = await readJsonBody<Record<string, unknown>>(request)
    } catch (error) {
      replyJson(response, 400, { ok: false, error: `unreadable body: ${String(error)}` })
      return
    }
    let intentId = stringOf(body.intentId, 200)
    // The settings panel's records menu knows a reference id, not the intent
    // that carried it — client.js `removeFromDraft` posts { referenceId }.
    // Resolve it the same way the ACK handler does, instead of answering 400
    // for a perfectly valid removal and letting the next poll re-insert the card.
    if (intentId === undefined) {
      const referenceId = stringOf(body.referenceId, 200)
      if (referenceId !== undefined) {
        intentId = queue.list().deliveries.find(entry => entry.referenceId === referenceId)?.intentId
      }
    }
    // A missing/unresolvable id means the card is already gone: `list()` drops
    // removed records, so a tombstoned reference cannot be looked up again.
    // Say so with a stable 409 rather than a misleading 400/404.
    if (intentId === undefined) { replyJson(response, 409, { ok: false, error: 'reference-was-removed' }); return }
    const record = queue.remove(intentId)
    if (record === undefined) { replyJson(response, 404, { ok: false, error: 'delivery-not-found' }); return }
    replyJson(response, 200, { ok: true, intentId, state: record.state })
  }

  /**
   * Actual bytes of a captured image. `encoding=base64` returns JSON so the
   * client can build a standard image block without a second fetch; the raw
   * form drives the card thumbnail. A reference is not "an image URL".
   */
  const asset: BrowserHttpHandler = (request, response) => {
    if (!requireRead(request, response)) return
    const url = new URL(request.url ?? '/', 'http://localhost')
    const key = url.searchParams.get('key') ?? ''
    if (!/^[0-9a-f]{64}$/.test(key)) { replyJson(response, 400, { ok: false, error: 'invalid asset key' }); return }
    const file = service.assetPath(key)
    if (file === undefined) { replyJson(response, 404, { ok: false, error: 'asset-not-found' }); return }
    let mime = 'application/octet-stream'
    try {
      const meta: unknown = JSON.parse(readFileSync(join(dirname(file), `${key}.json`), 'utf8'))
      const candidate = (meta as { mime?: unknown }).mime
      if (typeof candidate === 'string' && /^image\/[a-z0-9.+-]+$/i.test(candidate)) mime = candidate
    } catch { /* a missing sidecar still serves the bytes */ }
    let bytes: Buffer
    try {
      bytes = readFileSync(file)
    } catch {
      // The sidecar/existsSync check can race with an external asset cleanup;
      // an uncaught ENOENT here used to kill the response before any byte was
      // written, leaving the card thumbnail broken with no status at all.
      replyJson(response, 404, { ok: false, error: 'asset-not-found' })
      return
    }
    if (url.searchParams.get('encoding') === 'base64') {
      replyJson(response, 200, { ok: true, key, mime, bytes: bytes.length, sha256: key, data: bytes.toString('base64') })
      return
    }
    response.writeHead(200, {
      'content-type': mime,
      'content-length': String(bytes.length),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    })
    response.end(bytes)
  }

  return {
    list, get, capture, reveal, insert, export: exportBundle, importBundle,
    deliveries, ack, removeDelivery, asset,
  }
}
