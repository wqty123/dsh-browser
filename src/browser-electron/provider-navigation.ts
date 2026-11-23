import { DEFAULT_OPERATION_TIMEOUT_MS } from '../../assets/browser-policy.mjs'
import { setLastOpen } from './open-slot.ts'
import { forgetCursor } from './virtual-cursor.ts'
import { documentReady, mainDocument, type DocumentIdentity } from './document-readiness.ts'
import type { BrowserOpenRequest, BrowserSessionId } from '../browser/types.ts'
import { BrowserError } from '../browser/types.ts'
import { PROVIDER_TIMEOUTS, CDP_PAGE_NAVIGATE, delay, withTimeout, handleSendEvaluate, type ElectronViewHandle, type Tab, type Session, type CdpNavigateParams } from './provider-core.ts'
import { ProviderTabs } from './provider-tabs.ts'

/** Poll interval for the document-settle loop. */
const SETTLE_POLL_MS = 25

export abstract class ProviderNavigation extends ProviderTabs {
  async openUrl(session: BrowserSessionId, request: BrowserOpenRequest, signal?: AbortSignal): Promise<void> {
    try { setLastOpen(request.url, Date.now()) } catch { /* best effort */ }
    const s = this.session(session)
    await this.prepareCarrier(signal, s.id)
    if (request.newTab === true) {
      this.newTab(s)
    }
    // A page the human already has, at the URL being asked for, is the page they mean.
    //
    // Reported as a defect: they opened a page by hand, then a tool call drove the plugin's own
    // blank tab instead and reported nothing about the page on screen — so the obvious conclusion
    // was "the page is broken", and opening the same URL again produced a SECOND tab. Reusing the
    // existing page is both what the request says and what a person expects.
    //
    // Only an exact match after normalisation: a deliberate navigation to a different URL must not
    // be redirected to whatever page happens to be open.
    const tab = this.activeTab(s)
    const transaction = this.beginNavigation(tab, signal)
    const { navigation } = transaction
    signal = transaction.signal
    if (request.newTab !== true && await this.adoptMatchingPage(s, request.url, tab, navigation, signal)) return
    await this.navigateTab(s, tab, request.url, navigation, signal)
  }

  /** Navigate the active tab's view to a URL, honoring HTTP(S)-only admission. */
  async navigate(session: BrowserSessionId, request: { readonly url: string }, signal?: AbortSignal): Promise<void> {
    const s = this.session(session)
    await this.prepareCarrier(signal, s.id)
    const tab = this.activeTab(s)
    const transaction = this.beginNavigation(tab, signal)
    const { navigation } = transaction
    signal = transaction.signal
    await this.navigateTab(s, tab, request.url, navigation, signal)
  }

  private beginNavigation(tab: Tab, signal?: AbortSignal): { navigation: symbol; signal: AbortSignal } {
    signal?.throwIfAborted()
    const previous = tab.navigationAbort
    tab.navigation = Symbol()
    tab.navigationAbort = new AbortController()
    previous?.abort(Object.assign(new Error('a newer navigation was requested for this browser tab'), { code: 'panel-navigation-superseded' }))
    return { navigation: tab.navigation, signal: signal === undefined ? tab.navigationAbort.signal : AbortSignal.any([signal, tab.navigationAbort.signal]) }
  }

  protected checkNavigation(tab: Tab, navigation: symbol): void {
    if (tab.failure !== undefined) throw tab.failure
    if (![...this.sessions.values()].some(session => session.tabs.includes(tab))) {
      throw new BrowserError('browser: the navigation guest was closed', 'BROWSER_GUEST_CLOSED')
    }
    if (tab.navigation !== navigation) {
      throw Object.assign(new Error('a newer navigation was requested for this browser tab'), { code: 'panel-navigation-superseded' })
    }
  }

  private async navigateTab(s: Session, tab: Tab, url: string, navigation: symbol, signal?: AbortSignal): Promise<void> {
    const { handle } = tab
    this.checkNavigation(tab, navigation)
    try {
      if (this.httpOnly) {
        let parsed: URL
        try {
          parsed = new URL(url)
        } catch {
          throw new BrowserError(`browser: refusing navigation to unparseable URL "${url}"`, 'BROWSER_NAVIGATION_BLOCKED')
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new BrowserError(`browser: refusing navigation to non-HTTP(S) URL "${url}"`, 'BROWSER_NAVIGATION_BLOCKED')
        }
      }
      signal?.throwIfAborted()
      // Page.navigate can hang on an unreachable/slow host; bound it like the
      // evaluate paths so a wedged navigation surfaces as an error instead of
      // blocking the tool call forever.
      const timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS
      const deadline = Date.now() + timeoutMs
      // Document identity of the page we are leaving (see settleDocument).
      const before = await this.documentIdentity(handle, signal, () => { this.checkNavigation(tab, navigation) }, deadline).catch(() => undefined)
      this.checkNavigation(tab, navigation)
      signal?.throwIfAborted()
      const result = await withTimeout(
        handle.sendCommand(CDP_PAGE_NAVIGATE, { url } satisfies CdpNavigateParams, { deadline, signal }),
        Math.max(1, deadline - Date.now()),
        signal,
        `browser: navigation timed out after ${timeoutMs}ms`,
        // A wedged navigation quarantines the guest. A cancelled one only stops loading:
        // terminating script execution here, with no script running, would kill the next
        // evaluation instead, so the tab's next operation stalls into quarantine.
        timedOut => {
          if (tab.navigation !== navigation) return
          if (timedOut) this.interrupt(handle, timedOut)
          else void handle.sendCommand('Page.stopLoading').catch(() => {})
        },
      )
      // Page.navigate resolves even when the navigation fails; surface the
      // failure instead of leaving a silent white screen.
      this.checkNavigation(tab, navigation)
      const errorText = (result as { errorText?: string } | undefined)?.errorText
      if (typeof errorText === 'string' && errorText !== '') {
        throw new BrowserError(`browser: navigation to "${url}" failed: ${errorText}`, 'BROWSER_NAVIGATION_FAILED')
      }
      signal?.throwIfAborted()
      const acknowledgement = result as { frameId?: string; loaderId?: string } | undefined
      if (typeof acknowledgement?.frameId !== 'string' || acknowledgement.frameId === '') {
        throw new BrowserError('browser: navigation returned no frame acknowledgement', 'BROWSER_DOCUMENT_UNACKNOWLEDGED')
      }
      if (acknowledgement.loaderId === undefined ? before === undefined
        : typeof acknowledgement.loaderId !== 'string' || acknowledgement.loaderId === '') {
        throw new BrowserError('browser: navigation returned no document acknowledgement', 'BROWSER_DOCUMENT_UNACKNOWLEDGED')
      }
      tab.url = url
      await this.settleDocument(handle, before, signal, acknowledgement, () => { this.checkNavigation(tab, navigation) }, undefined, deadline)
      this.checkNavigation(tab, navigation)
      this.record(s, 'navigate', { url }, true)
      this.recordVisit(s, handle)
      this.showActive(s, true)
    } catch (error) {
      const code = (error as { code?: string })?.code
      if (tab.navigation === navigation && (code === 'BROWSER_DOCUMENT_TIMEOUT' || code === 'BROWSER_DOCUMENT_UNACKNOWLEDGED')) {
        this.quarantine(handle)
      }
      if (!(error instanceof BrowserError && (error as { code?: string }).code === 'BROWSER_NAVIGATION_BLOCKED')) {
        this.record(s, 'navigate', { url }, false, { error: String(error) })
      }
      throw error
    }
  }

  protected async documentIdentity(handle: ElectronViewHandle, signal?: AbortSignal, checkCurrent?: () => void,
    deadline = Date.now() + PROVIDER_TIMEOUTS.evaluation, allowErrorDocument = false): Promise<DocumentIdentity> {
    signal?.throwIfAborted()
    checkCurrent?.()
    return mainDocument(await withTimeout(
      handle.sendCommand('Page.getFrameTree', undefined, { present: false, initialize: false }),
      Math.max(1, Math.min(PROVIDER_TIMEOUTS.evaluation, deadline - Date.now())), signal, 'browser: document identity timed out', timedOut => {
        try { checkCurrent?.() } catch { return }
        this.interrupt(handle, timedOut)
      },
    ), { allowErrorDocument })
  }

  /**
   * Page.navigate resolves at navigation COMMIT, not at load: the new document
   * is already current (so location.href and document.title are the new page's)
   * while its DOM is still being parsed. dsh_browser_open snapshots immediately
   * after navigating, which is why it could report the right title with zero
   * interactive elements — and why a separate dsh_browser_snapshot right after
   * always found them.
   *
   * The CDP frame/loader acknowledgement, not elapsed time or URL equality,
   * identifies the document whose parse readiness can complete the transaction.
   */
  protected async settleDocument(handle: ElectronViewHandle, before: DocumentIdentity | undefined, signal?: AbortSignal,
    acknowledgement?: { readonly frameId?: string; readonly loaderId?: string }, checkCurrent?: () => void,
    historyEntry?: number, deadline = Date.now() + DEFAULT_OPERATION_TIMEOUT_MS, allowErrorDocument = false): Promise<void> {
    // The document is being replaced, so the synthetic pointer drawn into the old one
    // is gone. Dropping the remembered position is what lets it be painted again:
    // without this, a paint at coincidentally identical coordinates would be skipped
    // and the pointer would never come back after a navigation.
    forgetCursor(handle)
    for (;;) {
      signal?.throwIfAborted()
      checkCurrent?.()
      const remaining = deadline - Date.now()
      if (remaining <= 0) {
        this.quarantine(handle)
        throw new BrowserError('browser: the navigation document was not ready within its deadline', 'BROWSER_DOCUMENT_TIMEOUT')
      }
      const ready = await withTimeout((async () => {
        if (historyEntry !== undefined) {
          const history = await handle.sendCommand('Page.getNavigationHistory') as { entries?: Array<{ id?: number }>; currentIndex?: number }
          if (history.entries?.[history.currentIndex ?? -1]?.id !== historyEntry) return false
        }
        const current = await this.documentIdentity(handle, signal, checkCurrent, deadline, allowErrorDocument)
        if (acknowledgement?.frameId !== undefined && current.id !== acknowledgement.frameId) {
          throw new BrowserError('browser: navigation frame was superseded', 'BROWSER_NAVIGATION_SUPERSEDED')
        }
        const loader = acknowledgement?.loaderId ?? (acknowledgement === undefined ? undefined : before?.loaderId)
        if (loader !== undefined && current.loaderId !== loader) {
          if (current.loaderId === before?.loaderId) return false
          throw new BrowserError('browser: navigation document was superseded', 'BROWSER_NAVIGATION_SUPERSEDED')
        }
        if (acknowledgement === undefined && current.loaderId === before?.loaderId) return false
        return documentReady(handle, current, () => {
          signal?.throwIfAborted()
          checkCurrent?.()
          if (Date.now() >= deadline) {
            this.quarantine(handle)
            throw new BrowserError('browser: document readiness deadline expired', 'BROWSER_DOCUMENT_TIMEOUT')
          }
        })
      })(), remaining, signal, 'browser: document readiness timed out', timedOut => {
        try { checkCurrent?.() } catch { return }
        this.interrupt(handle, timedOut)
      })
      signal?.throwIfAborted()
      checkCurrent?.()
      if (ready) return
      await delay(Math.min(SETTLE_POLL_MS, Math.max(0, deadline - Date.now())), signal)
    }
  }

  /** Go back (-1) or forward (+1) in the active tab's navigation history. */
  private async historyStep(session: BrowserSessionId, direction: -1 | 1, signal?: AbortSignal): Promise<void> {
    const s = this.session(session)
    const tab = this.activeTab(s)
    const { handle } = tab
    const transaction = this.beginNavigation(tab, signal)
    const { navigation } = transaction
    signal = transaction.signal
    signal?.throwIfAborted()
    const timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS
    const deadline = Date.now() + timeoutMs
    const hist = await withTimeout(
      handle.sendCommand('Page.getNavigationHistory'),
      timeoutMs,
      signal,
      `browser: history read timed out after ${timeoutMs}ms`,
    ) as { entries?: Array<{ id?: number; url?: string }>; currentIndex?: number }
    this.checkNavigation(tab, navigation)
    const entries = hist.entries ?? []
    const currentIndex = hist.currentIndex ?? -1
    const target = currentIndex + direction
    if (target < 0 || target >= entries.length) {
      // Nothing to step to; treat it as a successful no-op so the agent can
      // proceed without an error dance.
      this.record(s, direction === -1 ? 'back' : 'forward', {}, true)
      return
    }
    const entry = entries[target]
    if (entry?.id === undefined) throw new BrowserError('browser: history entry missing id', 'BROWSER_HISTORY_INVALID')
    // A history step is a navigation too: the classic A→B→A redirect would
    // otherwise read the outgoing document's identity (see settleDocument).
    const before = await this.documentIdentity(handle, signal, () => { this.checkNavigation(tab, navigation) }, deadline, true)
    const inPage = await withTimeout(handleSendEvaluate(handle, `(() => {
      if (typeof navigation === 'undefined') return false;
      const entry = navigation.entries().find(entry => entry.index === navigation.currentEntry.index + ${direction});
      return entry?.url === ${JSON.stringify(entry.url)} && entry.sameDocument === true;
    })()`), Math.max(1, deadline - Date.now()), signal, 'browser: history document identity timed out', timedOut => { this.interrupt(handle, timedOut) })
    this.checkNavigation(tab, navigation)
    signal?.throwIfAborted()
    await withTimeout(
      handle.sendCommand('Page.navigateToHistoryEntry', { entryId: entry.id }),
      Math.max(1, deadline - Date.now()),
      signal,
      `browser: history navigation timed out after ${timeoutMs}ms`,
      () => { if (tab.navigation === navigation) void handle.sendCommand('Page.stopLoading').catch(() => {}) },
    )
    await this.settleDocument(handle, before, signal,
      inPage.ok && inPage.value === true ? { frameId: before.id, loaderId: before.loaderId } : undefined,
      () => { this.checkNavigation(tab, navigation) }, entry.id, deadline, true)
    this.record(s, direction === -1 ? 'back' : 'forward', {}, true)
    this.recordVisit(s, handle)
    this.showActive(s)
  }

  /** Go back in the active tab's history. */
  async back(session: BrowserSessionId, signal?: AbortSignal): Promise<void> {
    return this.historyStep(session, -1, signal)
  }

  /** Go forward in the active tab's history. */
  async forward(session: BrowserSessionId, signal?: AbortSignal): Promise<void> {
    return this.historyStep(session, 1, signal)
  }

  /** Reload the active tab. */
  async reload(session: BrowserSessionId, signal?: AbortSignal): Promise<void> {
    const s = this.session(session)
    const tab = this.activeTab(s)
    const { handle } = tab
    const transaction = this.beginNavigation(tab, signal)
    const { navigation } = transaction
    signal = transaction.signal
    signal?.throwIfAborted()
    const timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS
    const deadline = Date.now() + timeoutMs
    // Same-URL reload: only the per-load document identity can tell the new
    // document from the old one, so capture it before reloading.
    const before = await this.documentIdentity(handle, signal, () => { this.checkNavigation(tab, navigation) }, deadline, true)
    this.checkNavigation(tab, navigation)
    signal?.throwIfAborted()
    await withTimeout(
      handle.sendCommand('Page.reload', { ignoreCache: false }),
      Math.max(1, deadline - Date.now()),
      signal,
      `browser: reload timed out after ${timeoutMs}ms`,
      // Best-effort: cancel the reload if it wedges the debugger queue.
      () => { if (tab.navigation === navigation) void handle.sendCommand('Page.stopLoading').catch(() => {}) },
    )
    await this.settleDocument(handle, before, signal, undefined, () => { this.checkNavigation(tab, navigation) }, undefined, deadline, true)
    this.record(s, 'reload', {}, true)
    this.recordVisit(s, handle)
    this.showActive(s)
  }

  /** Read the current URL of a view through CDP. */
  protected async currentUrl(handle: ElectronViewHandle): Promise<string> {
    // Bound the read: a wedged renderer would otherwise hang listTabs.
    const timeoutMs = PROVIDER_TIMEOUTS.lookup
    const result = await withTimeout(
      handleSendEvaluate(handle, 'location.href'),
      timeoutMs,
      undefined,
      `browser: url read timed out after ${timeoutMs}ms`,
      timedOut => { this.interrupt(handle, timedOut) },
    )
    return result.ok && typeof result.value === 'string' ? result.value : ''
  }
}
