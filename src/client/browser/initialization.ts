/**
 * Explicit lifecycle protocol for one Sidebar Browser initialization.
 *
 * Issue #55 reported a single symptom — "produced no page" — for several very
 * different failures: no tab, no Controller, a Controller that never consumed
 * the URL, and a guest that never attached. Collapsing them into one message
 * made the failure unrecoverable and undiagnosable.
 *
 * This journal keeps the exact `(session, tab, occurrence, navigation revision)`
 * a request was aimed at, the stage it reached, and — on failure — the stage
 * plus the raw reason. It is deliberately carrier-neutral: the Controller and
 * the Electron/iframe frame both advance it, and tests drive it directly.
 *
 * Stages:
 * - `accepted`: the navigation record was written for THIS occurrence/revision.
 * - `mounted`: the Controller for that occurrence exists.
 * - `navigating`: the Controller handed the URL to its frame (URL consumed).
 * - `attached`: the guest/iframe document is ready.
 * - `failed`: carries the stage transition that failed and why.
 *
 * @module dsh-client-ui-sidebar-browser/browser/initialization
 */
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'

/** How far one initialization got. */
export type BrowserInitStage = 'accepted' | 'mounted' | 'navigating' | 'attached' | 'failed'

/** Machine reason carried by a failed receipt; the UI localizes it. */
export type BrowserInitFailure =
  | 'occurrence-aborted'
  | 'controller-missing'
  | 'workspace-unavailable'
  | 'acquire-failed'
  | 'guest-bootstrap-failed'
  | 'navigation-failed'
  | 'navigation-rejected'
  | 'timeout'

/** One immutable observation of an initialization attempt. */
export interface BrowserInitReceipt {
  readonly requestId: string
  readonly sessionId: string
  readonly tabId: TabId
  /** Distinguishes a reopened tab from its previous lifetime. */
  readonly occurrenceId: string
  /** The navigation record this request was aimed at. */
  readonly navigationRevision: number
  readonly url: string
  readonly stage: BrowserInitStage
  /** Present once the carrier reports an attached guest/document. */
  readonly guestId?: string
  /** Present only when `stage === 'failed'`. */
  readonly reason?: BrowserInitFailure
  /** Original carrier failure text, when the failed stage supplied it. */
  readonly detail?: string
  /** Epoch milliseconds; diagnostic only, never used for ordering. */
  readonly at: number
}

/** Identity half of a receipt, supplied when a request starts. */
export interface BrowserInitRequest {
  readonly requestId?: string
  readonly sessionId: string
  readonly tabId: TabId
  readonly occurrenceId: string
  readonly navigationRevision: number
  readonly url: string
}

/** A stage transition may carry the guest id observed by the carrier. */
export interface BrowserInitPatch {
  readonly detail?: string
  readonly guestId?: string
  readonly navigationRevision?: number
  readonly url?: string
}

export interface BrowserInitializationJournal {
  /** Start (or restart) the request for one tab; a dead occurrence fails immediately. */
  begin(request: BrowserInitRequest, options?: { readonly aborted?: boolean }): BrowserInitReceipt
  /** Advance a live request; a request that already failed is not revived. */
  advance(tabId: TabId, stage: Exclude<BrowserInitStage, 'failed'>, patch?: BrowserInitPatch): BrowserInitReceipt | undefined
  /** Fail a live request with a machine reason, preserving its last reached stage. */
  fail(tabId: TabId, reason: BrowserInitFailure, patch?: BrowserInitPatch): BrowserInitReceipt | undefined
  get(tabId: TabId): BrowserInitReceipt | undefined
  /** Newest first, bounded: this is a diagnostic ring, not a durable log. */
  all(): readonly BrowserInitReceipt[]
  forget(tabId: TabId): void
  dispose(): void
}

/** Ready document observed in the live frame, independent of its last requested URL. */
export interface BrowserObservedPage {
  readonly url: string
  readonly guestId?: string
}

export interface BrowserInitializationReader {
  readonly protocolVersion: 1
  navigate?(query: { readonly sessionId: string; readonly tabId: TabId; readonly url: string }): boolean
  current(query: { readonly sessionId: string; readonly tabId: TabId }): BrowserObservedPage | undefined
  read(query: { readonly sessionId: string; readonly tabId: TabId; readonly url: string; readonly requestId?: string; readonly afterRequestId?: string }): BrowserInitReceipt | undefined
  wait(query: { readonly sessionId: string; readonly tabId: TabId; readonly url: string; readonly requestId?: string; readonly afterRequestId?: string }, signal: AbortSignal): Promise<BrowserInitReceipt>
}

/** Scope reads to a Session/tab and the requested document before exposing a receipt. */
export function createBrowserInitializationReader(
  lookup: (sessionId: string, tabId: TabId) => BrowserInitReceipt | undefined,
  subscribe?: (listener: () => void) => () => void,
  observe?: (sessionId: string, tabId: TabId) => BrowserObservedPage | undefined,
  navigate?: (sessionId: string, tabId: TabId, url: string) => boolean,
): BrowserInitializationReader {
  const canonical = (value: string): string => {
    try { return new URL(value).href } catch { return value }
  }
  const reader: BrowserInitializationReader = {
    protocolVersion: 1,
    ...(navigate === undefined ? {} : { navigate: (query: { readonly sessionId: string; readonly tabId: TabId; readonly url: string }) => navigate(query.sessionId, query.tabId, query.url) }),
    current: query => observe?.(query.sessionId, query.tabId),
    read(query) {
      const receipt = lookup(query.sessionId, query.tabId)
      if (receipt?.sessionId !== query.sessionId || receipt.tabId !== query.tabId
        || canonical(receipt.url) !== canonical(query.url)
        || (query.requestId !== undefined && receipt.requestId !== query.requestId)
        || receipt.requestId === query.afterRequestId) return undefined
      return receipt
    },
    wait(query, signal) {
      if (subscribe === undefined) return Promise.reject(new Error('initialization subscriptions unavailable'))
      return new Promise((resolve, reject) => {
        let done = false
        let requestId = query.requestId
        let unsubscribe = (): void => {}
        const finish = (error?: Error, receipt?: BrowserInitReceipt): void => {
          if (done) return
          done = true
          unsubscribe()
          signal.removeEventListener('abort', abort)
          if (error !== undefined) reject(error)
          else resolve(receipt!)
        }
        const abort = (): void => finish(signal.reason ?? new Error('source initialization aborted'))
        const check = (): void => {
          if (signal.aborted) { abort(); return }
          const latest = lookup(query.sessionId, query.tabId)
          if (requestId !== undefined && latest !== undefined && latest.requestId !== requestId) {
            finish(Object.assign(new Error('source initialization superseded'), { code: 'panel-navigation-superseded' }))
            return
          }
          const receipt = reader.read(query)
          if (receipt !== undefined) requestId ??= receipt.requestId
          if (receipt?.stage === 'failed') {
            const code = receipt.reason === 'timeout' ? 'BROWSER_DOCUMENT_TIMEOUT'
              : receipt.reason === 'occurrence-aborted' ? 'BROWSER_NAVIGATION_CANCELLED'
              : receipt.reason === 'navigation-failed' || receipt.reason === 'navigation-rejected' ? 'BROWSER_NAVIGATION_FAILED'
              : 'panel-initialization-failed'
            finish(Object.assign(new Error(receipt.detail ?? receipt.reason ?? 'source initialization failed'), { code }))
          }
          else if (receipt?.stage === 'attached') finish(undefined, receipt)
        }
        unsubscribe = subscribe(check)
        if (done) { unsubscribe(); return }
        signal.addEventListener('abort', abort, { once: true })
        check()
      })
    },
  }
  return reader
}

const HISTORY_LIMIT = 200

/**
 * Build a journal. `now` is injectable so tests get stable receipts.
 * @param options - clock and history bound.
 * @returns the journal.
 */
export function createBrowserInitializationJournal(
  options: { readonly now?: () => number; readonly historyLimit?: number; readonly onChange?: () => void } = {},
): BrowserInitializationJournal {
  const now = options.now ?? (() => Date.now())
  const limit = options.historyLimit ?? HISTORY_LIMIT
  const latest = new Map<TabId, BrowserInitReceipt>()
  let history: BrowserInitReceipt[] = []
  let serial = 0
  let disposed = false

  const publish = (receipt: BrowserInitReceipt): BrowserInitReceipt => {
    latest.set(receipt.tabId, receipt)
    history.push(receipt)
    if (history.length > limit) history = history.slice(history.length - limit)
    options.onChange?.()
    return receipt
  }

  return {
    begin(request, beginOptions = {}) {
      const receipt: BrowserInitReceipt = {
        requestId: request.requestId ?? `browser-init-${++serial}`,
        sessionId: request.sessionId,
        tabId: request.tabId,
        occurrenceId: request.occurrenceId,
        navigationRevision: request.navigationRevision,
        url: request.url,
        stage: beginOptions.aborted === true ? 'failed' : 'accepted',
        ...beginOptions.aborted === true ? { reason: 'occurrence-aborted' as const } : {},
        at: now(),
      }
      return publish(receipt)
    },
    advance(tabId, stage, patch = {}) {
      if (disposed) return undefined
      const current = latest.get(tabId)
      if (current === undefined || current.stage === 'failed') return undefined
      return publish({
        ...current,
        ...patch.navigationRevision === undefined ? {} : { navigationRevision: patch.navigationRevision },
        ...patch.url === undefined ? {} : { url: patch.url },
        ...patch.guestId === undefined ? {} : { guestId: patch.guestId },
        stage,
        at: now(),
      })
    },
    fail(tabId, reason, patch = {}) {
      if (disposed) return undefined
      const current = latest.get(tabId)
      if (current === undefined) return undefined
      if (current.stage === 'failed') return current
      return publish({
        ...current,
        ...patch.navigationRevision === undefined ? {} : { navigationRevision: patch.navigationRevision },
        ...patch.url === undefined ? {} : { url: patch.url },
        ...patch.guestId === undefined ? {} : { guestId: patch.guestId },
        stage: 'failed',
        reason,
        ...patch.detail === undefined ? {} : { detail: patch.detail },
        at: now(),
      })
    },
    get: tabId => latest.get(tabId),
    all: () => [...history].reverse(),
    forget(tabId) {
      latest.delete(tabId)
    },
    dispose() {
      disposed = true
      latest.clear()
      history = []
    },
  }
}
