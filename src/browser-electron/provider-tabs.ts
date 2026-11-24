import { randomUUID } from 'node:crypto'
import type { BrowserSessionId, BrowserTab } from '../browser/types.ts'
import { BrowserError } from '../browser/types.ts'
import { browserSessionHandle, resolveSessionHandle, resolveTabHandle, sessionWireId, tabWireId, type BrowserTabWireId } from '../browser/handles.ts'
import type { CarrierPage } from '../browser/types.ts'
import { ProviderCore, type ElectronViewHandle, type Tab, type Session } from './provider-core.ts'

export abstract class ProviderTabs extends ProviderCore {
  /**
   * Bind the page the human has open in this conversation's sidebar into a session.
   *
   * Why this is the whole entry: the sidebar page is the shell's, opened by a person
   * through the address bar, so no session of ours names it and nothing injects the
   * selection bar into it. The shell DOES expose the panel's pages by conversation id
   * (`listPages`), and can hand one over (`adoptPage`) — the same pair the tools use
   * for `dsh_browser_list_tabs`. Doing it on a timer means the bar appears on a page
   * the human opened themselves, which is the only entry they actually take.
   *
   * Rescans are spaced by one idle tick, not five: the listing crosses the
   * bridge, and a page the human just opened must get its entry within a
   * couple of seconds rather than five.
   */
  protected async adoptSidebarPageForReference(): Promise<void> {
    const configured = this.config.referenceLabel
    const label = typeof configured === 'function' ? configured() : configured
    this.referenceScan.label = label
    if (label === undefined || label === '') return
    if (this.host.listPages === undefined || this.host.adoptPage === undefined) {
      this.referenceScan.lastError = 'this carrier cannot list or adopt a page it did not open'
      return
    }
    if (this.referenceScanCountdown > 0) { this.referenceScanCountdown -= 1; return }
    // One idle tick between scans: a page the human opens must get its entry
    // within a couple of seconds (measured: the shell creates the guest, then
    // the next scan adopts it). The listing is a local bridge call, not a
    // network request, so this is cheap.
    this.referenceScanCountdown = 1
    let session = this.referenceSession === undefined ? undefined : this.sessions.get(this.referenceSession)
    if (session?.label !== label) session = undefined
    const candidate: Session = session ?? {
      id: sessionWireId(browserSessionHandle(label, randomUUID())), label,
      tabs: [], activeIndex: 0, history: [], nextSeq: 1,
    }
    let pages: readonly CarrierPage[]
    try {
      // `requireRunning` is what keeps a scan from launching the human's
      // installed browser: only a carrier that is already up can have pages.
      pages = await this.host.listPages(this.carrierScope(candidate), { requireRunning: true })
    } catch (error) {
      this.referenceScan.lastError = error instanceof Error ? error.message : String(error)
      return
    }
    this.referenceScan.pages = pages.length
    const live = pages.filter(candidate => /^https?:\/\//iu.test(candidate.url))
    // NOT pruned. The host's listing already EXCLUDES the pages this process
    // adopted (that exclusion is what keeps `listTabs` from reporting one page
    // twice), so "absent from the listing" means "already adopted" as often as
    // it means "closed". Dropping those tabs would lose the bar on every page
    // the human switches away from and re-adopt it under a new handle on the
    // way back. A closed page's handle simply stops answering, and the pump
    // already skips a tab it cannot evaluate.
    if (live.length === 0) {
      this.referenceScan.lastError = 'no http page is open in this conversation\'s sidebar'
      return
    }
    let refused: string | undefined
    for (const page of live) {
      const tabId = this.carrierTab(candidate, page.id)
      const existing = session?.tabs.find(tab => tab.id === tabId)
      if (existing !== undefined) {
        // A navigation changes the URL of a page we already hold.
        if (existing.url !== page.url) existing.url = page.url
        continue
      }
      try {
        // The owner is passed so the adopted view is released with THIS
        // conversation and not swept up by, or lost to, another one.
        const handle = await this.host.adoptPage(this.carrierTab(candidate, page.id), this.carrierScope(candidate))
        if (session === undefined) {
          session = candidate
          this.sessions.set(session.id, session)
          this.referenceSession = session.id
        }
        // Append only: discovery must never switch the page the human is
        // looking at, nor open a tab they did not ask for.
        session.tabs.push({ id: tabId, handle, url: page.url })
      } catch (error) {
        refused = error instanceof Error ? error.message : String(error)
      }
    }
    if (session !== undefined) {
      session.activeIndex = Math.min(session.activeIndex, Math.max(0, session.tabs.length - 1))
    }
    this.referenceScan.lastError = session === undefined
      ? refused ?? 'no page could be adopted'
      : refused
  }

  /**
   * Bind the carrier page that already shows this URL, if there is one.
   *
   * Compare the part of a URL that says WHICH page it is: scheme, host, path and query. A hash is a
   * position inside a document, and a trailing slash is spelling, so neither makes a different page.
   * @param s - the session to bind the page into.
   * @param url - the URL being opened.
   * @returns whether an existing page was taken over.
   */
  protected async adoptMatchingPage(s: Session, url: string, target: Tab, navigation: symbol, signal?: AbortSignal): Promise<boolean> {
    if (this.host.adoptPage === undefined || this.host.listPages === undefined) return false
    const wanted = this.comparableUrl(url)
    if (wanted === undefined) return false
    let pages: readonly CarrierPage[]
    try {
      pages = await this.host.listPages(this.carrierScope(s))
    } catch {
      // A listing must not turn "nothing to reuse" into "open failed".
      return false
    }
    this.checkNavigation(target, navigation)
    const match = pages.find(page => this.comparableUrl(page.url) === wanted)
    if (match === undefined) return false
    let handle: ElectronViewHandle
    try {
      handle = await this.host.adoptPage(this.carrierTab(s, match.id), this.carrierScope(s))
    } catch {
      // The page went away between listing and adopting: fall through to an ordinary navigation.
      return false
    }
    if (target.navigation !== navigation) {
      this.host.destroyView(handle, { keepPage: true })
      this.checkNavigation(target, navigation)
    }
    const tab: Tab = { id: this.carrierTab(s, match.id), handle, url: match.url, navigation, navigationAbort: target.navigationAbort }
    delete target.navigationAbort
    s.tabs.push(tab)
    s.activeIndex = s.tabs.length - 1
    const document = await this.documentIdentity(handle, signal, () => { this.checkNavigation(tab, navigation) })
    await this.settleDocument(handle, document, signal, { frameId: document.id, loaderId: document.loaderId },
      () => { this.checkNavigation(tab, navigation) })
    this.showActive(s, true)
    return true
  }

  /** The parts of a URL that decide identity, or undefined when it cannot be parsed. */
  private comparableUrl(url: string): string | undefined {
    if (url === '' || url === 'about:blank') return undefined
    try {
      const parsed = new URL(url)
      return `${parsed.protocol}//${parsed.host}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`
    } catch {
      return undefined
    }
  }

  /** List the session's tabs with their titles. */
  async listTabs(session: BrowserSessionId): Promise<readonly BrowserTab[]> {
    const s = this.session(session)
    const result: BrowserTab[] = []
    for (let i = 0; i < s.tabs.length; i++) {
      const tab = s.tabs[i]
      if (tab === undefined) continue // defensive: array can shift under concurrency
      // A tab we know has never navigated is NOT probed: its view has committed no document, so
      // the round trip can only answer nothing — and it is the round trip that costs. A tab that
      // HAS navigated is re-read, because the page may have moved itself since; a read that fails
      // keeps the last accepted URL rather than reporting the tab as blank.
      const liveUrl = tab.failure !== undefined ? tab.url : tab.url === '' ? '' : await this.currentUrl(tab.handle).catch(() => tab.url)
      if (liveUrl !== '') tab.url = liveUrl
      result.push({
        id: tab.id,
        url: liveUrl,
        active: i === s.activeIndex,
      })
    }
    // Pages the CARRIER holds that this provider never created.
    //
    // A sidebar panel and an installed browser both open pages on their own: a click on a link
    // that targets a new page, or any `window.open`, produces a page nothing tells us about.
    // Reporting only our own tabs made those invisible to this tool and unclosable through
    // `dsh_browser_close_tab`, so they accumulated for the life of the browser. Measured on the
    // sidebar carrier: three clicks produced three webview guests while this listed one tab.
    //
    // Hosts exclude pages already attached to provider views.
    const pages = await this.host.listPages?.(this.carrierScope(s)) ?? []
    for (const page of pages) {
      // A page with no URL is a blank one the carrier opened for itself. Listing it would invite a
      // caller to act on nothing, and the blank normalisation already closes those.
      if (page.url === '' || page.url === 'about:blank') continue
      result.push({ id: this.carrierTab(s, page.id), url: page.url, active: false })
    }
    return result
  }

  /** Switch to a tab by id, making its view visible. */
  async switchTab(session: BrowserSessionId, tabId: BrowserTabWireId, options?: { readonly user?: boolean }): Promise<void> {
    const user = options?.user === true
    const s = this.session(session)
    // A page the carrier owns. Before this, switching to one threw "not open in this session" —
    // while `dsh_browser_list_tabs` was happily listing it, so the two tools disagreed and the
    // page the human was looking at could not be reached (reported as a defect).
    const carrierId = this.carrierId(s, tabId)
    if (carrierId !== undefined) {
      const existing = s.tabs.findIndex(tab => tab.id === tabId)
      if (existing !== -1) {
        await this.host.presentView?.(s.tabs[existing]!.handle, s.label, { quiet: this.isQuiet(), select: true, ...user ? { user } : {} })
        s.activeIndex = existing
        this.showActive(s, true, user)
        return
      }
      const id = carrierId
      if (this.host.adoptPage === undefined) {
        throw new BrowserError(
          'browser: this carrier cannot hand over a page it opened itself, so that page cannot be driven. '
          + 'Open the URL through dsh_browser_open instead — that creates a page this plugin owns.',
          'BROWSER_TAB_NOT_FOUND',
        )
      }
      const pages = await this.host.listPages?.(this.carrierScope(s)).catch(() => []) ?? []
      const page = pages.find(candidate => candidate.id === id)
      const handle = await this.host.adoptPage(id, this.carrierScope(s))
      try {
        // An adopted guest already has a document. Marking it as our never-opened
        // blank view makes the first snapshot/a11y return without reading it.
        const url = page?.url || await this.currentUrl(handle)
        if (url === '') throw new BrowserError('browser: the adopted page did not report its document URL', 'BROWSER_TAB_NOT_FOUND')
        const tab: Tab = { id: tabId, handle, url }
        await this.host.presentView?.(handle, s.label, { quiet: this.isQuiet(), select: true, ...user ? { user } : {} })
        s.tabs.push(tab)
        s.activeIndex = s.tabs.length - 1
        this.showActive(s, true, user)
      } catch (error) {
        this.host.destroyView(handle, { keepPage: true })
        throw error
      }
      return
    }
    const found = this.locateTab(session, tabId)
    found.s.activeIndex = found.index
    this.showActive(found.s, true, user)
  }

  /** Close one tab; closing the active tab activates the next. */
  async closeTab(session: BrowserSessionId, tabId: BrowserTabWireId): Promise<void> {
    const current = this.session(session)
    const carrierId = this.carrierId(current, tabId)
    // A page the carrier owns rather than a view we created. It was reported by `listTabs` under
    // this prefix, so closing it here is what keeps the two tools consistent — a page that can be
    // listed must be closable, or the listing reads as a contradiction.
    if (carrierId !== undefined) {
      const id = carrierId
      if (this.host.closePage === undefined) {
        return Promise.reject(new BrowserError(
          'browser: this carrier does not expose the pages it opens on its own, so that page cannot be closed',
          'BROWSER_TAB_NOT_FOUND',
        ))
      }
      await this.host.closePage(id, this.carrierScope(current))
      if (!this.session(session).tabs.some(tab => tab.id === tabId)) return
    }
    const found = this.locateTab(session, tabId)
    const s = found.s
    const index = found.index
    const removed = s.tabs[index]
    if (removed !== undefined) {
      s.tabs.splice(index, 1)
      this.destroyTab(removed, { keepPage: carrierId !== undefined })
    }
    if (s.tabs.length === 0) {
      // Session keeps one blank tab so it stays usable.
      this.newTab(s)
    } else if (index < s.activeIndex) {
      // Closing a tab before the active one shifts the array left; keep the
      // same tab active by decrementing the index.
      s.activeIndex -= 1
    } else if (index === s.activeIndex) {
      // The active tab itself was closed; activate the next tab (the one that
      // shifted into its place), or the last one when the closed tab was the
      // last.
      s.activeIndex = Math.min(index, s.tabs.length - 1)
    }
    this.showActive(s)
    return Promise.resolve()
  }

  /**
   * Find a canonical tab within the calling session.
   */
  private locateTab(session: BrowserSessionId, tabId: string): { s: Session; index: number } {
    const s = this.session(session)
    resolveTabHandle(resolveSessionHandle(session), tabId)
    const own = s.tabs.findIndex(tab => tab.id === tabId)
    if (own >= 0) return { s, index: own }
    const ownIds = s.tabs.map(t => t.id).join(', ') || '(none)'
    throw new BrowserError(
      `browser: tab "${tabId}" is not open in this session (session tabs: ${ownIds})`,
      'BROWSER_TAB_UNKNOWN',
    )
  }

  /** Close every tab and reset to one blank tab. */
  reset(session: BrowserSessionId): Promise<void> {
    const s = this.session(session)
    for (const tab of s.tabs) this.destroyTab(tab)
    s.tabs.length = 0
    this.newTab(s)
    s.activeIndex = 0
    this.showActive(s)
    return Promise.resolve()
  }

  /** Look up a session or throw the unknown-session error. */
  protected session(session: BrowserSessionId): Session {
    const existing = this.sessions.get(session)
    if (existing === undefined) {
      throw new BrowserError(`browser: session "${session}" is not open`, 'BROWSER_SESSION_UNKNOWN')
    }
    return existing
  }

  /** The active tab of a session. */
  protected activeTab(s: Session): Tab {
    if (this.carrierLaunchError !== undefined) throw this.carrierLaunchError
    const tab = s.tabs[s.activeIndex]
    if (tab === undefined) throw new BrowserError('browser: session has no active tab', 'BROWSER_TAB_UNKNOWN')
    if (tab.failure !== undefined) throw tab.failure
    return tab
  }

  /** Append a fresh tab and make it active. */
  protected newTab(s: Session): void {
    const id = tabWireId({ ...resolveSessionHandle(s.id), tab: randomUUID() })
    const handle = this.host.createView(id)
    // Same window as the session's other tabs.
    this.host.groupView?.(handle, s.id, s.label)
    s.tabs.push({ id, handle, url: '' })
    s.activeIndex = s.tabs.length - 1
    this.showActive(s)
  }

  protected carrierScope(s: Session): BrowserSessionId {
    return s.id
  }

  protected carrierTab(s: Session, id: string): BrowserTabWireId {
    const scope = resolveSessionHandle(s.id)
    return tabWireId(resolveTabHandle(scope, id))
  }

  private carrierId(s: Session, id: BrowserTabWireId): BrowserTabWireId | undefined {
    const tab = resolveTabHandle(resolveSessionHandle(s.id), id).tab
    if (!tab.startsWith('page:') && this.host.closePage === undefined) return undefined
    return id
  }

  protected destroyTab(tab: Tab, options?: { readonly keepPage?: boolean }): void {
    tab.navigationAbort?.abort(new BrowserError('browser: the navigation guest was closed', 'BROWSER_GUEST_CLOSED'))
    this.host.destroyView(tab.handle, options)
  }

  /** Find a session's tab by its backing view id (toolbar actions carry view ids). */
  protected tabByViewId(s: Session, viewId: string): Tab | undefined {
    return s.tabs.find(tab => tab.handle.id === viewId)
  }

  /**
   * Whether a session is still live. The human closing a window ends its session
   * (see {@link handleViewClosed}), so callers that cache ids must ask first.
   * @param session - the session id to test.
   */
  exists(session: BrowserSessionId): boolean {
    return this.sessions.has(session)
  }
}
