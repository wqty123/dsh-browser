/**
 * Electron-backed browser provider: `WebContentsView` sessions driven over
 * `webContents.debugger` (CDP). The provider itself does not import Electron — it operates through the {@link ElectronBrowserViewHost} seam, which the
 * desktop shell implements with real Electron objects. That keeps this
 * package testable under plain Node and leaves the Electron dependency to the
 * shell that owns the `BrowserWindow`.
 * @module dsh-browser/browser-electron
 */

import { hostMessages } from '../../assets/browser-messages.mjs'
import { dispatchReferenceCaptureAction } from '../browser-reference/service.ts'
import { MAX_REFERENCE_COMMENT, REFERENCE_INTENT_CHANNEL, overlayScript, standaloneScript } from '../browser-reference/entry.ts'
import { noticeScript, validateFrozenCapture } from '../browser-reference/page-script.ts'
import { randomUUID } from 'node:crypto'
import type { VisitedPage } from './history-store.ts'
import type { BrowserElementTarget, BrowserHistoryEntry, BrowserProvider, BrowserSessionId, BrowserScrollRequest } from '../browser/types.ts'
import { BrowserError } from '../browser/types.ts'
import { browserSessionHandle, resolveSessionHandle, resolveTabHandle, sessionWireId, tabWireId, type BrowserTabWireId } from '../browser/handles.ts'
import { PROVIDER_TIMEOUTS, withTimeout, handleSendEvaluate, type BrowserUserAction, type ElectronViewHandle, type Tab, type Session, type ElectronBrowserProviderConfig } from './provider-core.ts'
import { ProviderMedia } from './provider-media.ts'

export { ELECTRON_BROWSER_PROVIDER_ID, CDP_PAGE_CAPTURE_SCREENSHOT, layoutSize, toExportedCookies, toCdpCookie, CDP_RUNTIME_EVALUATE, CDP_PAGE_NAVIGATE, BROWSER_KEY_NAMES } from './provider-core.ts'
export type { ElectronBrowserViewHost, BrowserUserAction, ElectronViewHandle, ElectronBrowserProviderConfig, CdpNavigateParams, CdpMouseParams, CdpInsertTextParams, CdpEvaluateParams, PresentOptions, CommandOptions, ScreenshotOptions } from './provider-core.ts'

/**
 * Consecutive failed evaluations after which the reference pump forgets an
 * adopted sidebar tab. One or two misses are a navigation; five (≈6 s at the
 * pump's 1.2 s tick) mean the page the human had is gone.
 */
const DEAD_REFERENCE_TAB_MISSES = 5

/** How long a tab that stopped answering waits before the pump tries it again. */
const DEAD_REFERENCE_TAB_RETRY_MS = 15_000

/**
 * Best-effort interrupt of a wedged page-script evaluation. `Runtime.evaluate`
 * with `awaitPromise` can hold the renderer (and the target's debugger queue)
 * behind a busy loop or a never-settling promise; terminating kills the
 * running script so subsequent commands are not stuck forever. Fire-and-forget:
 * if the interrupt itself hangs, it is ignored. Capped at
 * MAX_PENDING_TERMINATIONS per view to prevent unbounded pending entries
 * when the child is truly stuck.
 * @param handle - the view handle to terminate in.
 */
const pendingTerminations = new WeakMap<ElectronViewHandle, number>()

const MAX_PENDING_TERMINATIONS = 3

function terminatePage(handle: ElectronViewHandle): void {
  const count = pendingTerminations.get(handle) ?? 0
  if (count >= MAX_PENDING_TERMINATIONS) return
  pendingTerminations.set(handle, count + 1)
  void handle.sendCommand('Runtime.terminateExecution', undefined, { present: false, initialize: false }).finally(() => {
    pendingTerminations.set(handle, Math.max(0, (pendingTerminations.get(handle) ?? 1) - 1))
  }).catch(() => {})
}

/**
 * Browser provider over Electron views. Sessions hold an ordered list of
 * tabs; each tab is one view created by the host. The active tab receives
 * every operation; switching tabs calls the host's optional `showView` and
 * never loses state. Navigation is admitted only for HTTP(S) targets unless
 * {@link ElectronBrowserProviderConfig.httpOnly} is disabled.
 */
export class ElectronBrowserProvider extends ProviderMedia implements BrowserProvider {
  /** Retire a provider after a carrier swap; its listeners must not act again. */
  dispose(): void {
    this.disposed = true
    this.stopReferenceEntryPump()
  }

  /** Start the page-bar pump; idempotent, unref'd so it never holds the process. */
  protected startReferenceEntryPump(): void {
    if (this.host.referenceOverlayOwner === 'client' || this.referencePump !== undefined) return
    this.referencePump = setInterval(() => { void this.pumpReferenceEntry() }, 1200)
    this.referencePump.unref?.()
  }

  /** Stop the pump (session teardown / tests). */
  stopReferenceEntryPump(): void {
    if (this.referencePump === undefined) return
    clearInterval(this.referencePump)
    this.referencePump = undefined
  }

  /**
   * Install the bar where it is missing and forward one confirmed intent.
   *
   * Re-injection is what makes this survive navigation: a new document has no
   * `__dshRefOverlayInstalled`, so the next tick installs the bar again.
   *
   * One run at a time: `setInterval` fires again whether or not the previous
   * run finished, and a page that stopped answering would otherwise stack CDP
   * commands behind the wedged renderer on every tick.
   */
  private async pumpReferenceEntry(): Promise<void> {
    if (this.referencePumping) return
    this.referencePumping = true
    try {
      await this.adoptSidebarPageForReference().catch(() => undefined)
      for (const session of [...this.sessions.values()]) {
        if (this.host.referenceOverlayOwnerFor?.(session.id) === 'client') continue
        for (const tab of [...session.tabs]) {
          await this.pumpOneTab(session, tab)
          // A tab is never dropped for being unreachable: the page is the
          // person's own sidebar page, and the host excludes every page it
          // adopted from later listings, so letting go of the handle would
          // close our only route back to it.
        }
      }
    } finally {
      this.referencePumping = false
    }
  }

  /**
   * Install or collect on one tab.
   * @returns false when the page failed enough consecutive times to be gone.
   */
  private async pumpOneTab(session: Session, tab: Tab): Promise<boolean> {
    if (tab.failure !== undefined) return false
    // A page that stopped answering is retried on a slow timer instead of being
    // dropped: navigations and renderer swaps both look like death for a moment.
    if (tab.retryAt !== undefined && Date.now() < tab.retryAt) return true
    try {
      // One round-trip per tab: a missing bar answers "install"; otherwise the
      // same evaluation hands back a confirmed intent.
      const probe = await this.evaluateInTab(tab, [
        'window.__dshRefOverlayInstalled !== true ? "install"',
        ': (window.__dshRefTake ? window.__dshRefTake() : null)',
      ].join(''), PROVIDER_TIMEOUTS.evaluation)
      tab.misses = 0
      tab.retryAt = undefined
      if (probe === 'install') {
        await this.evaluateInTab(tab, standaloneScript(overlayScript(), {}), PROVIDER_TIMEOUTS.interaction)
        return true
      }
      if (probe === null || probe === undefined) return true
      try {
        if (typeof probe !== 'object') throw new Error('reference intent is invalid')
        const record = probe as Record<string, unknown>
        if (record.type !== REFERENCE_INTENT_CHANNEL) throw new Error('reference intent channel is invalid')
        const rawComment = typeof record.comment === 'string' ? record.comment.trim() : ''
        const rawSelection = typeof record.selectionText === 'string' ? record.selectionText.trim() : ''
        const capture = validateFrozenCapture(record.capture)
        if (capture === undefined) throw new Error('reference intent has no captured content')
        await this.handleUserAction({
          type: 'capture-reference',
          windowId: session.id,
          entry: 'page-overlay',
          ...rawComment !== '' ? { comment: rawComment.slice(0, MAX_REFERENCE_COMMENT) } : {},
          ...rawSelection !== '' ? { selectionText: rawSelection } : {},
          capture,
        }, true)
      } catch (error) {
        this.referenceScan.lastError = 'capture refused: ' + (error instanceof Error ? error.message : String(error))
        process.stderr.write(`[dsh-browser] ${this.referenceScan.lastError}\n`)
        try {
          await this.evaluateInTab(tab, standaloneScript(noticeScript(hostMessages.zh.referenceFailed)), PROVIDER_TIMEOUTS.evaluation)
        } catch { /* The failure remains in host diagnostics when the guest disappears. */ }
      }
      return true
    } catch {
      // A tab mid-navigation has no execution context yet; the next tick retries.
      // A page that keeps failing backs off instead of being forgotten: the
      // handle is the only way back to a page this host adopted, and dropping it
      // made the bar stop delivering for the rest of the conversation.
      tab.misses = (tab.misses ?? 0) + 1
      if (tab.misses >= DEAD_REFERENCE_TAB_MISSES) {
        tab.misses = 0
        tab.retryAt = Date.now() + DEAD_REFERENCE_TAB_RETRY_MS
      }
      return true
    }
  }

  /** Forget one dead adopted tab; the conversation's next page starts a fresh session. */

  /**
   * What the sidebar reference entry is doing right now.
   *
   * Served on the reference route so "there is no selection bar on my page" has an
   * answer that is not a guess: which conversation this process thinks it serves,
   * whether a page was adopted, how many the shell reported, and the last refusal.
   */
  referenceStatus(): { readonly label?: string; readonly session?: string; readonly pages: number; readonly lastError?: string } {
    return {
      ...this.referenceScan.label === undefined ? {} : { label: this.referenceScan.label },
      ...this.referenceSession === undefined ? {} : { session: this.referenceSession },
      pages: this.referenceScan.pages,
      ...this.referenceScan.lastError === undefined ? {} : { lastError: this.referenceScan.lastError },
    }
  }

  /**
   * Usable when the host says it can back views (the self-hosted host probes
   * for a usable Electron binary; the desktop shell is assumed usable).
   */
  available(): boolean {
    return this.host.available?.() ?? true
  }

  /**
   * Open a NEW browser session with its own view. Every call mints a fresh
   * session id and backing view; per-task reuse is owned by the caller (the
   * tool layer caches one session per DSH task). Sessions are isolated from
   * each other: each keeps its own tabs, active tab, and history, and only
   * the active tab of a session is made visible.
   * @param label - optional human-readable label (e.g. the DSH task id) shown
   * in the window title so a human can tell which task's page is visible.
   */
  open(label?: string): Promise<BrowserSessionId> {
    // The label is the calling DSH task, and it is handed to the view as its owner: a host shared
    // by several conversations (the desktop's) keeps one conversation's page out of another's on
    // the strength of it, so it is not decoration.
    const id = sessionWireId(browserSessionHandle(label || 'default', randomUUID()))
    const tabId = tabWireId({ ...resolveSessionHandle(id), tab: randomUUID() })
    const handle = this.host.createView(tabId)
    // Group the session's views under its own window (one window per
    // session), carrying the label for the window title. Hosts without
    // groupView keep the shared-window behavior.
    this.host.groupView?.(handle, id, label)
    this.sessions.set(id, { id, label, tabs: [{ id: tabId, handle, url: '' }], activeIndex: 0, history: [], nextSeq: 1 })
    return Promise.resolve(id)
  }

  protected async prepareCarrier(signal?: AbortSignal, scope?: BrowserSessionId): Promise<void> {
    if (this.host.prepare === undefined) return
    signal?.throwIfAborted()
    try {
      await withTimeout(this.host.prepare(scope), PROVIDER_TIMEOUTS.prepare, signal, 'browser: carrier launch timed out before navigating a guest')
      this.carrierLaunchError = undefined
    } catch (error) {
      if (!signal?.aborted) this.carrierLaunchError = error
      throw error
    }
  }

  async bindPage(session: BrowserSessionId, pageId: BrowserTabWireId): Promise<void> {
    const s = this.session(session)
    if (this.host.adoptPage === undefined || !s.label) throw new Error('sidebar page binding unsupported')
    if (s.tabs.some(tab => tab.url !== '')) throw new Error('source binding requires a fresh browser session')
    const id = tabWireId(resolveTabHandle(resolveSessionHandle(s.id), pageId))
    const handle = await this.host.adoptPage(id, this.carrierScope(s))
    const previous = [...s.tabs]
    s.tabs.splice(0, s.tabs.length, { id: this.carrierTab(s, id), handle, url: '' })
    s.activeIndex = 0
    for (const tab of previous) this.destroyTab(tab)
  }

  /**
   * The most recent open request, for the Web sidebar.
   *
   * On the desktop shell the host half tells the shell to place a tab (`__dshBuiltinBrowser.openPanel`)
   * through the bridge. The Web shell has no such channel, so a tool-opened page lived only in the
   * plugin's own browser while the panel stayed empty — and "open it in the sidebar" took several manual
   * steps. The client polls this one slot and places the tab itself.
   * @returns the last request and when it arrived, or undefined when nothing was opened yet.
   */
  lastOpenRequest(): { readonly url: string; readonly at: number } | undefined {
    return this.lastOpen
  }

  /**
   * Make sure the active tab's view can actually receive synthesized input.
   * Chromium drops `Input.*` events for a view with no display surface, so this
   * runs before click/type/key and fails loudly (BROWSER_VIEW_NOT_PRESENTED)
   * rather than reporting a success the page never saw.
   * @param s - the session whose active view must be presented.
   * @param signal - optional cancellation.
   * @returns the view the session's active tab has AFTER the presentation barrier.
   */
  protected async present(s: Session, signal?: AbortSignal): Promise<ElectronViewHandle> {
    const { handle } = this.activeTab(s)
    const present = this.host.presentView?.bind(this.host)
    if (present === undefined) {
      this.showActive(s)
      return this.activeTab(s).handle
    }
    signal?.throwIfAborted()
    const timeoutMs = PROVIDER_TIMEOUTS.lookup
    try {
      await withTimeout(
        present(handle, s.label, { quiet: this.isQuiet() }),
        timeoutMs,
        signal,
        `browser: presenting the page view timed out after ${timeoutMs}ms`,
      )
      this.showActive(s)
    } catch (error) {
      throw new BrowserError(
        `browser: the page view is not presented, so synthesized input would be silently dropped (${String(error)})`,
        'BROWSER_VIEW_NOT_PRESENTED',
        { cause: error },
      )
    }
    // Read the active tab AGAIN. `present` is a round-trip that can take up to the budget
    // above, and the human is invited to drive the same window (a toolbar tab switch, a
    // closed window) while the agent waits. Chromium answers `Input.*` with success even
    // for a view that has no display surface, so dispatching to a handle that is no longer
    // the visible one does not fail — it silently lands nowhere, or on the wrong page.
    //
    // Returning the re-read handle was wrong, though: `handle` above is the one that was
    // actually presented, and if the active tab changed during the round trip then the
    // re-read one was never presented at all. Handing it back meant the caller dispatched
    // to a view with no display surface — the exact failure this method exists to prevent,
    // arrived at from the other side. Either the presented view is still the active one, or
    // the caller must be told rather than given something else to aim at.
    const live = this.activeTab(s).handle
    if (live !== handle) {
      throw new BrowserError(
        'browser: the active tab changed while the page view was being presented, so synthesized input would go to an unshown view — retry, and the new page will be presented instead',
        'BROWSER_VIEW_CHANGED',
      )
    }
    return handle
  }

  /** Append one operation to the session's history. */
  protected record(
    s: Session,
    action: string,
    params: Record<string, unknown>,
    ok: boolean,
    detail?: { result?: string; error?: string },
  ): void {
    const entry: BrowserHistoryEntry = {
      seq: s.nextSeq++,
      action,
      params,
      ok,
      ...detail?.result !== undefined ? { result: detail.result } : {},
      ...detail?.error !== undefined ? { error: detail.error } : {},
      at: Date.now(),
    }
    s.history.push(entry)
    // Bound memory: keep the last 500 operations.
    if (s.history.length > 500) s.history.splice(0, s.history.length - 500)
  }

  /** Return the session's chronological operation log (newest last). */
  async history(session: BrowserSessionId): Promise<readonly BrowserHistoryEntry[]> {
    return this.session(session).history
  }

  /**
   * Record one page visit in the persistent browsing history. Fire-and-forget by
   * design: a visit must never delay or fail the navigation that produced it,
   * and the title is only worth reading once the document has settled.
   * @param s - the session that drove the visit.
   * @param handle - the view whose document just loaded.
   */
  protected recordVisit(s: Session, handle: ElectronViewHandle): void {
    const store = this.historyStore
    if (store === undefined) return
    // The settings panel can switch recording off at runtime; the static config
    // only supplies the startup default. The RETENTION limits are read here too: they were
    // parsed and stored but never handed to the store, so editing maxEntries or maxAgeDays in
    // the file changed nothing — the switch worked and the numbers beside it did not.
    if (this.settingsSource !== undefined) {
      const live = this.settingsSource().history
      if (!live.enabled) return
      store.updateLimits({ maxEntries: live.maxEntries, maxAgeDays: live.maxAgeDays })
    }
    void handleSendEvaluate(handle, 'location.href + "\\u0000" + (document.title || "")')
      .then(result => {
        if (!result.ok || typeof result.value !== 'string') return
        const [url = '', title = ''] = result.value.split('\u0000')
        // Internal documents are not visits: an untouched browser is not history.
        if (url === '' || url.startsWith('about:') || url.startsWith('devtools:')) return
        store.append({
          at: Date.now(),
          url,
          ...title.trim() !== '' ? { title: title.trim() } : {},
          ...s.label !== undefined ? { session: s.label } : {},
        })
        store.prune()
      })
      .catch(() => { /* best-effort: history is never worth surfacing an error */ })
  }

  /**
   * List persisted visits, newest first — what `dsh_browser_visited` reads back.
   * @param options - result cap and an optional hostname filter.
   * @returns the matching visits, or an empty list when history is disabled.
   */
  visited(options: { readonly limit?: number; readonly domain?: string; readonly query?: string; readonly session?: string } = {}): readonly VisitedPage[] {
    return this.historyStore?.list(options) ?? []
  }

  /**
   * Replay one recorded operation by sequence number. Navigate/click/type are
   * re-issued against the current page; execute re-runs its script. The
   * replayed step is appended to history as a new entry.
   * @param session - the session id.
   * @param seq - the recorded entry's sequence number to replay.
   */
  async replay(session: BrowserSessionId, seq: number): Promise<void> {
    const s = this.session(session)
    const entry = s.history.find(e => e.seq === seq)
    if (entry === undefined) {
      throw new BrowserError(`browser: no history entry with seq ${seq}`, 'BROWSER_HISTORY_UNKNOWN')
    }
    switch (entry.action) {
      case 'navigate': {
        const url = entry.params.url
        if (typeof url !== 'string') throw new BrowserError(`browser: history seq ${seq} navigate has no url`, 'BROWSER_HISTORY_INVALID')
        await this.navigate(session, { url })
        this.record(s, 'replay', { seq, of: entry.action, url }, true)
        return
      }
      case 'click': {
        const target = entry.params.target as BrowserElementTarget | undefined
        if (target !== undefined) {
          await this.click(session, { target })
          this.record(s, 'replay', { seq, of: entry.action, target }, true)
          return
        }
        const x = entry.params.x
        const y = entry.params.y
        if (typeof x !== 'number' || typeof y !== 'number') throw new BrowserError(`browser: history seq ${seq} click has no coordinates`, 'BROWSER_HISTORY_INVALID')
        await this.click(session, { x, y })
        this.record(s, 'replay', { seq, of: entry.action, x, y }, true)
        return
      }
      case 'type': {
        const text = entry.params.text
        if (typeof text !== 'string') throw new BrowserError(`browser: history seq ${seq} type has no text`, 'BROWSER_HISTORY_INVALID')
        const target = entry.params.target as BrowserElementTarget | undefined
        await this.type(session, { text, ...target !== undefined ? { target } : {} })
        this.record(s, 'replay', { seq, of: entry.action, text, ...target !== undefined ? { target } : {} }, true)
        return
      }
      case 'scroll': {
        await this.scroll(session, entry.params as BrowserScrollRequest)
        this.record(s, 'replay', { seq, of: entry.action }, true)
        return
      }
      case 'key': {
        const key = entry.params.key
        if (typeof key !== 'string') throw new BrowserError(`browser: history seq ${seq} key has no key`, 'BROWSER_HISTORY_INVALID')
        await this.key(session, { key })
        this.record(s, 'replay', { seq, of: entry.action, key }, true)
        return
      }
      case 'execute': {
        const script = entry.params.script
        if (typeof script !== 'string') throw new BrowserError(`browser: history seq ${seq} execute has no script`, 'BROWSER_HISTORY_INVALID')
        const recordedArgs = entry.params.args
        const args = Array.isArray(recordedArgs)
          ? recordedArgs.filter((a): a is string | number | boolean => typeof a === 'string' || typeof a === 'number' || typeof a === 'boolean')
          : undefined
        const result = await this.execute(session, { script, ...args !== undefined && args.length > 0 ? { args } : {} })
        this.record(s, 'replay', { seq, of: entry.action, script, ...args !== undefined && args.length > 0 ? { args } : {} }, result.ok, result.ok ? { result: String(result.value) } : { error: result.exception })
        return
      }
      default:
        throw new BrowserError(`browser: history seq ${seq} action "${entry.action}" is not replayable`, 'BROWSER_HISTORY_NOT_REPLAYABLE')
    }
  }

  /** Close the session and destroy all its views. Idempotent. */
  async close(session: BrowserSessionId): Promise<void> {
    const existing = this.sessions.get(session)
    if (existing !== undefined) {
      this.sessions.delete(session)
      for (const tab of existing.tabs) this.destroyTab(tab)
      // Releasing the browser at session end is a setting, not fixed behaviour
      // (requirements §3). A self-hosted carrier already tore its window down with
      // the views above; the desktop's sidebar does not, so it is asked explicitly
      // — and its cookies plus the browsing history outlive the page either way.
      try {
        if (this.settingsSource !== undefined && this.settingsSource().ui.closeWithSession) {
          // Never release another conversation's pages.
          await this.host.releasePage?.(this.carrierScope(existing))
        }
      } finally {
        await this.host.retireSession?.(session)
      }
    }
  }

  protected interrupt(handle: ElectronViewHandle, timedOut: boolean): void {
    if (timedOut) this.quarantine(handle)
    else terminatePage(handle)
  }

  protected quarantine(handle: ElectronViewHandle): void {
    for (const session of this.sessions.values()) {
      const tab = session.tabs.find(tab => tab.handle === handle)
      if (tab === undefined || tab.failure !== undefined) continue
      tab.failure = new BrowserError('browser: this guest stopped acknowledging operations and is quarantined; close this tab or explicitly reset the session before retrying', 'BROWSER_GUEST_QUARANTINED')
      terminatePage(handle)
    }
  }

  /**
   * The sessions a viewer may watch, which is exactly the sessions that exist.
   *
   * Served so the browser page can build a frame URL without guessing: the provider names its
   * sessions, and an id invented by a client is refused at the route. Ids only — no URL, no title,
   * no target handle — because the point is to let the panel address a session, not to describe
   * what is in it.
   * @returns the live session ids.
   */
  watchableSessions(): readonly BrowserSessionId[] {
    return [...this.sessions.keys()]
  }

  takeoverTargets(owner: string): readonly { session: BrowserSessionId; owner: string; tabId: string; pageId: string; url: string }[] {
    return [...this.sessions.values()].filter(s => (s.label ?? 'default').replace(/^session-/u, '') === owner).flatMap(s => {
      const tab = s.tabs[s.activeIndex]
      return tab && !tab.failure && /^https?:\/\//u.test(tab.url)
        ? [{ session: s.id, owner: s.label ?? 'default', tabId: tab.id, pageId: tab.id, url: tab.url }] : []
    })
  }

  /**
   * The human closed a browser window: the session that window showed is over.
   * Ending it here is what makes the next call a clean start rather than a
   * resurrection of an invisible window. Browsing history and login state live
   * on disk, so nothing the human cares about is lost with it.
   * @param windowId - the group key the host reported, which is the session id.
   */
  protected async handleViewClosed(windowId: string): Promise<void> {
    if (typeof windowId !== 'string' || windowId === '') return
    const s = this.sessions.get(windowId as BrowserSessionId)
    if (s === undefined) return
    await this.close(s.id).catch(() => { /* the window is already gone */ })
  }

  /**
   * Route a user-initiated action from the host's UI into the session model.
   * Fire-and-forget by design: a user action failing (e.g. an unreachable
   * URL typed into the address bar) must never crash the host UI loop — it
   * is reported to the host (toolbar) when the host supports it, else logged.
   */
  protected async handleUserAction(action: BrowserUserAction, propagate = false): Promise<void> {
    const s = this.sessions.get(action.windowId as BrowserSessionId)
    if (s === undefined) {
      // The window the human clicked in has no live session here (session
      // closed, or a child restart changed identity). Never swallow the click
      // silently — surface it so the toolbar can tell the human what happened.
      const message = `action ${action.type} failed: no live browser session for window "${action.windowId}"`
      process.stderr.write(`[dsh-browser] ${message}\n`)
      this.notifyUserActionError(action, new Error('no live browser session'))
      if (propagate) throw new Error('no live browser session')
      return
    }
    try {
      switch (action.type) {
        case 'capture-reference':
          // The human clicked a native menu item or the page's floating entry.
          // Delivery is owned by the plugin entry, which holds the reference
          // service; the provider only routes the action to the right session.
          await dispatchReferenceCaptureAction({
            windowId: action.windowId,
            entry: action.entry,
            ...action.frameSelector !== undefined ? { frameSelector: action.frameSelector } : {},
            ...action.target !== undefined ? { target: action.target } : {},
            ...action.comment !== undefined ? { comment: action.comment } : {},
            ...action.selectionText !== undefined ? { selectionText: action.selectionText } : {},
            ...action.capture !== undefined ? { capture: action.capture } : {},
          })
          return
        case 'navigate':
          await this.openUrl(s.id, { url: action.url })
          return
        case 'newTab':
          this.newTab(s)
          if (action.url !== undefined && action.url !== '') {
            await this.navigate(s.id, { url: action.url })
          }
          return
        case 'activateTab': {
          const tab = this.tabByViewId(s, action.viewId)
          if (tab !== undefined) await this.switchTab(s.id, tab.id)
          return
        }
        case 'closeTab': {
          const tab = this.tabByViewId(s, action.viewId)
          if (tab !== undefined) await this.closeTab(s.id, tab.id)
          return
        }
        case 'back':
          await this.back(s.id)
          return
        case 'forward':
          await this.forward(s.id)
          return
        case 'reload':
          await this.reload(s.id)
          return
      }
    } catch (error) {
      this.notifyUserActionError(action, error)
      if (propagate) throw error
    }
  }

  /**
   * Report a failed user action to the host UI (toolbar), when supported.
   *
   * Two properties matter here, because this runs inside the catch of an async
   * handler (issue #16):
   *  - the receiver must be preserved. Reading the method off the host and calling
   *    it unbound runs the host's implementation with `this === undefined`, so its
   *    very first statement (`void this.ready()`) throws, the throw escapes the
   *    async catch as an unhandled rejection, and the whole DSH host exits;
   *  - this method must be incapable of throwing. Reporting a failed action is
   *    diagnostics: it can never be allowed to become the failure.
   */
  private notifyUserActionError(action: BrowserUserAction, error: unknown): void {
    const message = `action ${action.type} failed: ${String(error)}`
    let reported = false
    try {
      const notify = this.host.notifyUserActionError?.bind(this.host)
      if (notify !== undefined) {
        // Bound at the call: an unbound call here kills the host process (issue #16).
        notify(action.windowId, message)
        reported = true
      }
    } catch (notifyError) {
      // Contained on purpose; the log line below still carries the original cause.
      process.stderr.write(`[dsh-browser] host notify failed: ${String(notifyError)}\n`)
    }
    if (!reported) process.stderr.write(`[dsh-browser] user action failed: ${message}\n`)
  }

  /**
   * Whether the operator asked for quiet mode (`ui.quiet`).
   *
   * Read live on every call rather than captured at construction: the panel writes the document
   * and the next operation is expected to honour it, without a restart.
   * @returns true when the carrier must present views without taking the screen over.
   */
  protected isQuiet(): boolean {
    return this.settingsSource?.().ui.quiet === true
  }

  /**
   * Ask the host to show the active tab's view, carrying the session label.
   *
   * The two halves are sequential, not alternatives. `showView` makes the view the
   * visible one — which is what keeps what the human sees in step with what the agent
   * drives, and what lets `capturePage` return an image at all (a hidden view captures
   * empty) — while `collapse` folds the carrier's own chrome away when the user asked
   * for no auto-expand. Making them exclusive meant that with auto-expand off this
   * method did nothing at all on carriers without `collapse` (the self-hosted one),
   * silently desynchronising the two and failing every screenshot.
   */
  protected showActive(s: Session, select = false): void {
    const quiet = this.isQuiet()
    const active = s.tabs[s.activeIndex]
    if (active !== undefined) this.host.showView?.(active.handle, s.label, { quiet, ...select ? { select: true } : {} })
    if (quiet || select) return
    const autoExpand = this.settingsSource === undefined || this.settingsSource().ui.autoExpandOnce
    if (autoExpand) return
    // Best effort: a carrier that owns no presentation (self-hosted) simply has none.
    void this.host.collapse?.().catch(() => undefined)
  }
}
