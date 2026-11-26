/** Carrier-independent tab commands and renderer-facing state. */
import { createSnapshotStore, type BoundActions, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { BrowserFrameState } from './BrowserFrame.ts'
import type { BrowserPage, BrowserPageFactory } from './BrowserPage.ts'
import { currentBrowserTarget, type BrowserTabState } from './BrowserPersistence.ts'
import { resolveOmniboxInput, type OmniboxPreferences, type OmniboxRefusal } from './omnibox.ts'
import type { BrowserStore } from './store.ts'
import { parseBrowserAddress, type BrowserTarget } from './url.ts'
import { StartPageBinding, type BrowserStartPageInjected } from '../startpage/binding.ts'
import type { ShortcutDraft } from '../startpage/model.ts'
import { createBrowserInitializationJournal } from './initialization.ts'
import type {
  BrowserInitFailure,
  BrowserInitReceipt,
  BrowserInitializationJournal,
  BrowserObservedPage,
} from './initialization.ts'

/** Live tab state; navigation comes from its provider and draft validation stays local. */
export interface BrowserControllerState {
  readonly frame: BrowserFrameState
  /** Saved address offered for explicit restoration before any page has been requested. */
  readonly restoreTarget: BrowserTarget | undefined
  readonly addressFailure: OmniboxRefusal | undefined
  /** Counts explicit navigation commands; a page changing on its own leaves the address draft intact. */
  readonly commandRevision: number
  /** Prefilled new-shortcut form requested from the tab's actions menu. */
  readonly shortcutDraft: ShortcutDraft | undefined
  /** Last explicit initialization receipt for this occurrence; failed stages are visible. */
  readonly initialization: BrowserInitReceipt | undefined
}

/** Construction inputs for one tab occurrence. */
export interface BrowserControllerOptions {
  readonly tabId: TabId
  readonly signal: AbortSignal
  readonly applicationOrigin: string
  readonly initial: BrowserTabState | undefined
  readonly actions: BoundActions<BrowserStore>
  readonly createPage: BrowserPageFactory
  readonly openTab: (url: string) => void
  /** Shared search selection read at submission time, never captured at mount. */
  readonly omnibox?: () => OmniboxPreferences
  /** DSH Session this occurrence belongs to; recorded in every receipt. */
  readonly sessionId?: string
  /** Distinguishes this mount from a reopened tab of the same id. */
  readonly occurrenceId?: string
  /** Shared lifecycle journal; one per Browser plugin, not per tab. */
  readonly journal?: BrowserInitializationJournal
}

/** Owns input validation and page lifetime without inspecting the carrier type. */
export class BrowserController implements HostObservable<BrowserControllerState> {
  private readonly page: BrowserPage
  private readonly store: SnapshotStore<BrowserControllerState>
  private readonly unsubscribe: () => void
  private actions: BoundActions<BrowserStore>
  private checkpoint: BrowserTabState | undefined
  private disposed = false
  private disposal: Promise<void> | undefined
  private readonly abort = (): void => { void this.dispose() }
  private unsubscribeCarrier: (() => void) | undefined
  /** Last URL/revision this controller consumed, so a re-mount is not a reload. */
  private applied: { readonly url: string; readonly revision: number } | undefined
  /** The navigation record this occurrence is currently aimed at. */
  private navigationRevision = 0
  private readonly journal: BrowserInitializationJournal
  private readonly sessionId: string
  private readonly occurrenceId: string
  private readonly options: BrowserControllerOptions
  constructor(options: BrowserControllerOptions) {
    this.options = options
    this.actions = options.actions
    this.journal = options.journal ?? createBrowserInitializationJournal()
    this.sessionId = options.sessionId ?? ''
    this.occurrenceId = options.occurrenceId ?? `${options.tabId}:0`
    this.checkpoint = options.initial
    this.page = options.createPage({
      tabId: options.tabId,
      initial: options.initial,
      persist: (state) => {
        if (this.disposed) return
        this.checkpoint = state
        this.actions.replace(options.tabId, state)
      },
      openRequested: (value) => {
        if (this.disposed) return
        const result = parseBrowserAddress(value, options.applicationOrigin)
        if (!result.ok) { this.addressFailed(result.reason); return }
        options.openTab(result.target.url)
      },
    })
    this.store = createSnapshotStore({ frame: this.page.frame.getSnapshot(),
      restoreTarget: currentBrowserTarget(this.checkpoint), addressFailure: undefined, commandRevision: 0,
      shortcutDraft: undefined, initialization: undefined })
    this.unsubscribe = this.page.frame.subscribe(() => {
      if (this.disposed) return
      const current = this.store.getSnapshot()
      const frame = this.page.frame.getSnapshot()
      const changed = frame.target?.url !== current.frame.target?.url
      this.store.set({ frame, restoreTarget: frame.target === undefined ? currentBrowserTarget(this.checkpoint) : undefined,
        addressFailure: changed ? undefined : current.addressFailure,
        commandRevision: current.commandRevision,
        shortcutDraft: current.shortcutDraft,
        initialization: current.initialization })
      this.advanceFromFrame(frame)
    })
    const lifecycle = this.page.frame.lifecycle
    if (lifecycle !== undefined) {
      this.unsubscribeCarrier = lifecycle.subscribe(() => {
        if (this.disposed) return
        const carrier = lifecycle.getSnapshot()
        // `latest` is indexed only by tab, so a late carrier event from one
        // occurrence must never write another occurrence's receipt.
        const current = this.ownReceipt()
        if (carrier.stage === 'guest') {
          // A replacement guest for THIS occurrence (a physical unmount/remount
          // recreates the guest under the same Controller) must not be blocked
          // by a `failed` receipt left by a superseded mount. Begin a fresh
          // receipt so the later dom-ready can advance it to `attached`.
          if (current !== undefined && current.stage === 'failed') {
            this.journal.begin({
              sessionId: this.sessionId, tabId: this.options.tabId,
              occurrenceId: this.occurrenceId, navigationRevision: this.navigationRevision,
              url: this.applied?.url ?? current.url,
            })
          }
        } else if (carrier.stage === 'ready') {
          this.advanceFromFrame(this.page.frame.getSnapshot())
        } else if (carrier.stage === 'failed') {
          // `ownReceipt` already scopes this to the current occurrence.
          if (current !== undefined && current.stage !== 'failed') {
            this.journal.fail(this.options.tabId, carrier.reason ?? 'guest-bootstrap-failed',
              carrier.detail === undefined ? {} : { detail: carrier.detail })
          }
        }
        this.publishInitialization()
      })
    }
    options.signal.addEventListener('abort', this.abort, { once: true })
  }

  /** @returns immutable state for the common toolbar. */
  getSnapshot = (): BrowserControllerState => this.store.getSnapshot()
  /** @param listener - state invalidation. @returns unsubscribe callback. */
  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener)

  /**
   * Attach the page without transferring ownership of its tab occurrence.
   * @param viewportId - mounted content container.
   * @returns physical attachment cleanup only.
   */
  mount(viewportId: string): () => void {
    this.publishSaved()
    return this.page.presentation.mount(viewportId)
  }

  /**
   * Bind this controller to one committed tab occurrence and consume its target.
   * Called on every mount: a re-mount with the same URL/revision is a no-op, a
   * new revision is a real navigation, and an empty page can still be filled.
   * @param initialUrl - the navigation record's URL at this mount, or absence.
   * @param navigationRevision - the record revision this mount represents.
   */
  applyMount(initialUrl: string | undefined, navigationRevision: number): void {
    if (this.disposed) return
    this.navigationRevision = navigationRevision
    const adoption = this.page.adoption
    if (adoption !== undefined && this.applied === undefined) {
      this.applied = { url: adoption.url, revision: navigationRevision }
      const receipt = this.journal.begin({ sessionId: this.sessionId, tabId: this.options.tabId,
        occurrenceId: this.occurrenceId, navigationRevision, url: adoption.url })
      adoption.acknowledge(receipt.requestId)
      this.journal.advance(this.options.tabId, 'mounted', { navigationRevision })
      this.publishInitialization()
      return
    }
    const navigates = initialUrl !== undefined && initialUrl !== ''
      && (this.applied === undefined || navigationRevision > this.applied.revision)
    // `latest` is keyed only by tab, so a rebuilt occurrence can inherit a
    // stale (often failed) receipt from the previous one. A mount that keeps
    // the start page has no navigation to call `begin`, so establish our own
    // `accepted`/`mounted` receipt here. When a URL will be consumed,
    // `navigateTo` begins the receipt instead: doing both would write two
    // `accepted` records for the same occurrence.
    if (!navigates && this.journal.get(this.options.tabId)?.occurrenceId !== this.occurrenceId) {
      this.journal.begin({
        sessionId: this.sessionId, tabId: this.options.tabId,
        occurrenceId: this.occurrenceId, navigationRevision, url: initialUrl ?? '',
      })
      this.journal.advance(this.options.tabId, 'mounted', { navigationRevision })
    }
    this.publishInitialization()
    // A re-mount must not replay the initial URL over a URL the user typed
    // afterwards: only a brand-new controller, or a NEWER navigation record,
    // consumes the mount target.
    if (navigates) this.applyNavigation(initialUrl!, navigationRevision)
  }

  /** Backwards-compatible mount entry; a caller without a revision gets the last one. */
  start(initialUrl: string | undefined): void {
    this.applyMount(initialUrl, this.navigationRevision)
  }

  /** Load the saved address only after an explicit restore action. */
  restore(): void {
    // 卡片由视图从 `currentBrowserTarget(checkpoint)` 算出，而快照里的 `restoreTarget` 在
    // 「本 occurrence 已经带 url」时是 undefined——两处各算一遍就会「卡片在、点了没反应」。
    // 这里补上同一个来源，让按钮与卡片指向同一个目标。
    const target = this.store.getSnapshot().restoreTarget ?? currentBrowserTarget(this.checkpoint)
    if (target !== undefined) this.loadUrl(target.url)
  }

  /**
   * Validate an address before navigation, publishing invalid input for correction.
   * A repeated URL/revision is not reloaded; a newer revision always is.
   * @param value - address-bar or typed-open input.
   */
  loadUrl(value: string): void {
    if (this.disposed) return
    this.navigateTo(value, this.navigationRevision)
  }

  /**
   * Resolve manual address-bar input into a URL or keyword search before navigating.
   * @param value - text submitted from the address bar.
   */
  submitInput(value: string): void {
    if (this.disposed) return
    const preferences = this.options.omnibox?.() ?? { defaultSearchEngineId: '', searchEngines: [] }
    const resolution = resolveOmniboxInput(value, { ...preferences, applicationOrigin: this.options.applicationOrigin })
    if (resolution.kind === 'refused') {
      this.journal.begin({
        sessionId: this.sessionId, tabId: this.options.tabId,
        occurrenceId: this.occurrenceId, navigationRevision: this.navigationRevision, url: value,
      })
      this.journal.fail(this.options.tabId, 'navigation-rejected')
      this.addressFailed(resolution.reason)
      this.publishInitialization()
      return
    }
    this.navigateTo(resolution.primary.target.url, this.navigationRevision)
  }

  /** Delegate Back to the page's navigation provider. */
  goBack(): void { this.command(() => { this.page.frame.goBack() }) }
  /** Delegate Forward to the page's navigation provider. */
  goForward(): void { this.command(() => { this.page.frame.goForward() }) }
  /** Restore a saved address, or reload the already requested page. */
  reload(): void {
    if (this.store.getSnapshot().restoreTarget !== undefined) this.restore()
    else this.command(() => { this.page.frame.reload() })
  }

  /**
   * Apply the optional embedding-sandbox control; unsupported providers remain unchanged.
   * @param enabled - whether to enforce the provider's embedding sandbox.
   */
  setSandbox(enabled: boolean): void {
    const sandbox = this.page.frame.sandbox
    if (sandbox !== undefined) this.command(() => { sandbox.setEnabled(enabled) })
  }

  /** @returns the current confirmable page address and title, or undefined on a start page or unknown address. */
  pageInfo(): { readonly url: string; readonly title: string } | undefined {
    if (this.disposed) return undefined
    const { frame, restoreTarget } = this.store.getSnapshot()
    if (restoreTarget !== undefined || frame.target === undefined) return undefined
    if (frame.address === 'empty' || frame.address === 'unknown') return undefined
    return { url: frame.target.url, title: frame.target.title }
  }

  /** @param draft - current page address and title offered for confirmation. */
  requestShortcut(draft: ShortcutDraft): void {
    if (this.disposed) return
    this.store.set({ ...this.store.getSnapshot(), shortcutDraft: draft })
  }

  /** Close the prefilled shortcut form without writing. */
  dismissShortcut(): void {
    if (this.disposed) return
    this.store.set({ ...this.store.getSnapshot(), shortcutDraft: undefined })
  }

  /**
   * Redirect future checkpoint writes to a replacement Session binding.
   * @param actions - replacement persistence writer.
   */
  rebind(actions: BoundActions<BrowserStore>): void { this.actions = actions }

  /**
   * Release the page and detach occurrence and state listeners.
   * @returns after page teardown; repeated callers join the same disposal.
   */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposed = true
    this.options.signal.removeEventListener('abort', this.abort)
    this.unsubscribe()
    this.unsubscribeCarrier?.()
    // A controller that never reached `attached` is a real failure, but only
    // for receipts that belong to THIS occurrence: `latest` is shared by tab.
    const receipt = this.ownReceipt()
    if (receipt !== undefined && receipt.stage !== 'attached' && receipt.stage !== 'failed') {
      this.journal.fail(this.options.tabId,
        this.options.signal.aborted ? 'occurrence-aborted' : 'controller-missing')
    }
    this.disposal = this.page.frame.dispose()
    return this.disposal
  }

  /** @returns the last initialization receipt for this occurrence. */
  initialization(): BrowserInitReceipt | undefined {
    return this.journal.get(this.options.tabId)
  }

  currentPage(): BrowserObservedPage | undefined {
    const frame = this.page.frame.getSnapshot()
    const carrier = this.page.frame.lifecycle?.getSnapshot()
    if (this.disposed || frame.address !== 'observed' || (frame.loading && frame.documentReady !== true) || frame.error !== undefined
      || frame.target === undefined || (carrier !== undefined && carrier.stage !== 'ready')) return undefined
    return { url: frame.target.url, ...carrier?.guestId === undefined ? {} : { guestId: carrier.guestId },
      ...carrier?.generation === undefined ? {} : { generation: carrier.generation, frameId: carrier.frameId, loaderId: carrier.loaderId } }
  }

  /** Aim this occurrence at a new navigation record revision (plugin/sidebar action). */
  navigate(url: string, navigationRevision: number, requestId?: string): void {
    if (this.disposed) return
    this.navigationRevision = navigationRevision
    this.navigateTo(url, navigationRevision, requestId)
  }

  private applyNavigation(url: string, revision: number, requestId?: string): void {
    if (this.disposed) return
    if (requestId === undefined && this.applied?.url === url && this.applied.revision === revision) return
    this.applied = { url, revision }
    this.navigateTo(url, revision, requestId)
  }

  private navigateTo(value: string, revision: number, requestId?: string): void {
    this.applied = { url: value, revision }
    const parsed = parseBrowserAddress(value, this.options.applicationOrigin)
    this.journal.begin({
      ...requestId === undefined ? {} : { requestId },
      sessionId: this.sessionId, tabId: this.options.tabId,
      occurrenceId: this.occurrenceId, navigationRevision: revision, url: value,
    })
    if (!parsed.ok) {
      this.journal.fail(this.options.tabId, 'navigation-rejected')
      this.addressFailed(parsed.reason)
      this.publishInitialization()
      return
    }
    this.journal.advance(this.options.tabId, 'navigating',
      { navigationRevision: revision, url: parsed.target.url })
    const navigationId = this.ownReceipt()?.requestId
    this.command(() => { this.page.frame.loadUrl(parsed.target, navigationId) })
    this.publishInitialization()
  }

  /** The latest receipt only when it belongs to this exact tab occurrence. */
  private ownReceipt(): BrowserInitReceipt | undefined {
    const receipt = this.journal.get(this.options.tabId)
    return receipt?.occurrenceId === this.occurrenceId ? receipt : undefined
  }

  /** Carrier state is the strongest proof; the frame's observed address is the fallback. */
  private advanceFromFrame(frame: BrowserFrameState): void {
    const receipt = this.ownReceipt()
    if (receipt === undefined || receipt.stage === 'failed' || receipt.stage === 'attached'
      || frame.navigationId !== receipt.requestId) return
    if (frame.error !== undefined) {
      this.journal.fail(this.options.tabId, 'navigation-failed')
    } else if (frame.address === 'observed' && (!frame.loading || frame.documentReady === true) && frame.target !== undefined) {
      const carrier = this.page.frame.lifecycle?.getSnapshot()
      if (carrier !== undefined && carrier.stage !== 'ready') return
      this.journal.advance(this.options.tabId, 'attached',
        carrier?.guestId === undefined ? {} : { guestId: carrier.guestId,
          ...carrier.generation === undefined ? {} : { generation: carrier.generation, frameId: carrier.frameId, loaderId: carrier.loaderId } })
    }
    this.publishInitialization()
  }

  private publishInitialization(): void {
    if (this.disposed) return
    const receipt = this.ownReceipt()
    const current = this.store.getSnapshot()
    if (current.initialization === receipt) return
    this.store.set({ ...current, initialization: receipt })
  }

  private publishSaved(): void {
    if (this.checkpoint !== undefined) this.actions.replace(this.options.tabId, this.checkpoint)
  }

  private addressFailed(reason: OmniboxRefusal): void {
    this.store.set({ ...this.store.getSnapshot(), addressFailure: reason })
  }

  private command(run: () => void): void {
    if (this.disposed) return
    const current = this.store.getSnapshot()
    this.store.set({ ...current, addressFailure: undefined, commandRevision: current.commandRevision + 1 })
    run()
  }
}

/** Values available once a Sidebar body has committed its content container. */
export interface BrowserMountRequest {
  readonly tabId: TabId
  /** DSH Session; recorded in every initialization receipt. */
  readonly sessionId?: string
  /** The navigation record revision this mount represents. */
  readonly navigationRevision?: number
  readonly signal: AbortSignal
  readonly viewportId: string
  readonly applicationOrigin: string
  readonly initial: BrowserTabState | undefined
  readonly initialUrl: string | undefined
  readonly openTab: (url: string) => void
  readonly omnibox?: () => OmniboxPreferences
}

/** Result of aiming a tab at a URL; `controller-missing` is the recoverable failure. */
export type BrowserNavigationOutcome =
  | { readonly ok: true; readonly requestId: string }
  | { readonly ok: false; readonly reason: BrowserInitFailure }

/** Plain Slot callbacks and a framework-bound state source, not a desktop protocol. */
export interface BrowserInjected extends BrowserStartPageInjected {
  readonly keyedHooks: {
    readonly browserState: (key: string) => HostObservable<BrowserControllerState> | undefined
  }
  /** @param request - committed tab and container. @returns ends physical attachment without closing the tab. */
  mount(request: BrowserMountRequest): () => void
  /** @returns after every page has been disposed. */
  dispose(): Promise<void>
  /** @param actions - writer from a recreated Session binding. */
  rebind(actions: BoundActions<BrowserStore>): void
  /** @param tabId - owning tab. @param value - address input. */
  loadUrl(tabId: TabId, value: string): BrowserNavigationOutcome
  /** @param tabId - owning tab. @param value - manual address-bar input resolved as URL or search. */
  submitInput(tabId: TabId, value: string): BrowserNavigationOutcome
  /**
   * Aim an existing (or recoverable) tab at one navigation record revision.
   * Used by the body's revision effect; it never creates a second tab.
   */
  navigate(tabId: TabId, request: {
    readonly url: string
    readonly navigationRevision: number
    readonly requestId?: string
  }): BrowserNavigationOutcome
  /** @param tabId - owning tab. @returns the latest initialization receipt. */
  initialization(tabId: TabId): BrowserInitReceipt | undefined
  currentPage(tabId: TabId): BrowserObservedPage | undefined
  /** Newest-first receipts for diagnostics; bounded by the shared journal. */
  initializationLog(): readonly BrowserInitReceipt[]
  /** Capability marker: a caller may rely on receipts only when this is true. */
  readonly initializationReceipts: true
  /** @param tabId - tab whose saved address the user requested to restore. */
  restore(tabId: TabId): void
  /** @param tabId - owning tab. */
  goBack(tabId: TabId): void
  /** @param tabId - owning tab. */
  goForward(tabId: TabId): void
  /** Restore a saved address or reload its page. @param tabId - owning tab. */
  reload(tabId: TabId): void
  /** @param tabId - owning tab. @param enabled - provider's optional sandbox control. */
  setSandbox(tabId: TabId, enabled: boolean): void
  /** @param tabId - owning tab. @param focus - focuses the mounted address bar. @returns unregister callback. */
  bindAddressFocus(tabId: TabId, focus: () => void): () => void
  /** @param tabId - owning tab. @returns whether a mounted address bar can take focus. */
  canFocusAddress(tabId: TabId): boolean
  /** @param tabId - owning tab. @returns whether a mounted address bar received focus. */
  focusAddress(tabId: TabId): boolean
  /** @param tabId - owning tab. @returns the current confirmable page address and title. */
  pageInfo(tabId: TabId): { readonly url: string; readonly title: string } | undefined
  /** @param tabId - owning tab. @param draft - current page address and title. @returns whether the form opened. */
  requestShortcut(tabId: TabId, draft: ShortcutDraft): boolean
  /** @param tabId - owning tab. */
  dismissShortcut(tabId: TabId): void
}

/**
 * Own tab-occurrence controllers behind Session-scoped callbacks.
 * @param actions - persisted view-state writer.
 * @param createPage - composition-selected provider.
 * @param isTabOpen - authoritative layout membership, independent of mounted bodies and plugin lifetime.
 * @param startPage - shared start-page state and actions; an unavailable facade when settings are not served.
 * @param options - Session identity and an optional shared initialization journal.
 * @returns tab callbacks.
 */
export function createBrowserControllers(actions: BoundActions<BrowserStore>, createPage: BrowserPageFactory,
  isTabOpen: (tabId: TabId) => boolean, startPage?: BrowserStartPageInjected,
  options: { readonly sessionId?: string; readonly journal?: BrowserInitializationJournal; readonly onInitializationChange?: () => void } = {},
): BrowserInjected {
  const page = startPage ?? new StartPageBinding()
  const sessionId = options.sessionId ?? ''
  const ownsJournal = options.journal === undefined
  const journal = options.journal ?? createBrowserInitializationJournal({ onChange: options.onInitializationChange })
  let disposal: Promise<void> | undefined
  const mountRequests = new Map<TabId, BrowserMountRequest>()
  let occurrenceSerial = 0
  let currentActions = actions
  const addressFocus = new Map<TabId, () => void>()
  const controllers = new Map<TabId, {
    readonly signal: AbortSignal
    readonly controller: BrowserController
    readonly forget: () => void
  }>()
  const controller = (id: TabId): BrowserController | undefined => controllers.get(id)?.controller

  // Diagnostics handle for the real Desktop: the integration test reads the
  // exact request/stage/reason instead of guessing from the DOM.
  const root = globalThis as typeof globalThis & { __DSH_BROWSER_INIT_JOURNALS__?: BrowserInitializationJournal[] }
  root.__DSH_BROWSER_INIT_JOURNALS__ ??= []
  root.__DSH_BROWSER_INIT_JOURNALS__.push(journal)

  const create = (request: BrowserMountRequest): BrowserController => new BrowserController({
    ...request, actions: currentActions, createPage,
    sessionId: sessionId === '' ? (request.sessionId ?? '') : sessionId,
    occurrenceId: `${request.tabId}:${++occurrenceSerial}`,
    journal,
    omnibox: request.omnibox ?? (() => page.omniboxPreferences()),
  })

  const forgetController = (tabId: TabId, controllerToForget: BrowserController): void => {
    const held = controllers.get(tabId)
    if (held?.controller !== controllerToForget) return
    controllers.delete(tabId)
    // Plugin unload also aborts occurrences; only layout removal deletes saved
    // navigation and retires the committed mount, so a reopened tab cannot
    // resurrect a controller from a stale request.
    if (!isTabOpen(tabId)) {
      currentActions.forget(tabId)
      mountRequests.delete(tabId)
    }
  }

  /** Rebuild a missing controller from the last committed mount, if its occurrence is alive. */
  const ensure = (tabId: TabId): { readonly ok: true } | { readonly ok: false; readonly reason: BrowserInitFailure } => {
    if (controllers.has(tabId)) return { ok: true }
    const request = mountRequests.get(tabId)
    if (request === undefined) return { ok: false, reason: 'controller-missing' }
    if (request.signal.aborted) {
      journal.begin({
        sessionId, tabId, occurrenceId: `${tabId}:${occurrenceSerial}`, navigationRevision: request.navigationRevision ?? 0,
        url: request.initialUrl ?? '',
      }, { aborted: true })
      return { ok: false, reason: 'occurrence-aborted' }
    }
    const created = create(request)
    const forget = (): void => {
      created.dispose().catch(() => {})
      forgetController(tabId, created)
    }
    controllers.set(tabId, { signal: request.signal, controller: created, forget })
    request.signal.addEventListener('abort', forget, { once: true })
    created.mount(request.viewportId)
    created.applyMount(undefined, request.navigationRevision ?? 0)
    return { ok: true }
  }

  const navigate = (tabId: TabId, request: {
    readonly url: string
    readonly navigationRevision: number
    readonly requestId?: string
  }): BrowserNavigationOutcome => {
    const ready = ensure(tabId)
    if (!ready.ok) {
      journal.fail(tabId, ready.reason)
      return { ok: false, reason: ready.reason }
    }
    const target = controller(tabId)
    if (target === undefined) {
      journal.fail(tabId, 'controller-missing')
      return { ok: false, reason: 'controller-missing' }
    }
    target.navigate(request.url, request.navigationRevision, request.requestId)
    const receipt = journal.get(tabId)
    // navigateTo rejects an invalid address by failing its receipt without
    // navigating; surface that instead of reporting a successful navigation.
    return receipt?.stage === 'failed'
      ? { ok: false, reason: receipt.reason ?? 'navigation-rejected' }
      : { ok: true, requestId: receipt?.requestId ?? request.requestId ?? '' }
  }

  return {
    hooks: page.hooks,
    shortcuts: page.shortcuts,
    engines: page.engines,
    omniboxPreferences: () => page.omniboxPreferences(),
    selectedEngine: () => page.selectedEngine(),
    keyedHooks: { browserState: key => controller(key as TabId) },
    initializationReceipts: true,
    initialization: tabId => journal.get(tabId),
    currentPage: tabId => controller(tabId)?.currentPage(),
    initializationLog: () => journal.all(),
    mount(request) {
      const { tabId, signal } = request
      mountRequests.set(tabId, request)
      if (signal.aborted) {
        journal.begin({
          sessionId, tabId, occurrenceId: `${tabId}:${occurrenceSerial}`, navigationRevision: request.navigationRevision ?? 0,
          url: request.initialUrl ?? '',
        }, { aborted: true })
        return () => {}
      }
      let held = controllers.get(tabId)
      if (held?.signal !== signal) {
        if (held !== undefined) {
          held.signal.removeEventListener('abort', held.forget)
          void held.controller.dispose()
        }
        const created = create(request)
        const forget = (): void => { forgetController(tabId, created) }
        held = { signal, controller: created, forget }
        controllers.set(tabId, held)
        signal.addEventListener('abort', forget, { once: true })
      }
      const hide = held.controller.mount(request.viewportId)
      held.controller.applyMount(request.initialUrl, request.navigationRevision ?? 0)
      return hide
    },
    dispose: () => {
      disposal ??= (async () => {
        try {
          const pending = [...controllers.values()].map(({ signal, controller: held, forget }) => {
            signal.removeEventListener('abort', forget)
            return held.dispose()
          })
          await Promise.all(pending)
        } finally {
          controllers.clear()
          mountRequests.clear()
          if (ownsJournal) journal.dispose()
          const registered = root.__DSH_BROWSER_INIT_JOURNALS__ ?? []
          const index = registered.indexOf(journal)
          if (index !== -1) registered.splice(index, 1)
        }
      })()
      return disposal
    },
    rebind: (next) => {
      currentActions = next
      for (const { controller: held } of controllers.values()) held.rebind(next)
    },
    loadUrl: (id, value) => navigate(id, {
      url: value, navigationRevision: mountRequests.get(id)?.navigationRevision ?? 0,
    }),
    submitInput: (id, value) => {
      const ready = ensure(id)
      if (!ready.ok) {
        journal.fail(id, ready.reason)
        return { ok: false, reason: ready.reason }
      }
      const target = controller(id)
      if (target === undefined) return { ok: false, reason: 'controller-missing' }
      target.submitInput(value)
      const receipt = journal.get(id)
      return receipt?.stage === 'failed' && receipt.reason !== undefined
        ? { ok: false, reason: receipt.reason }
        : { ok: true, requestId: receipt?.requestId ?? '' }
    },
    navigate,
    bindAddressFocus: (id, focus) => {
      addressFocus.set(id, focus)
      return () => { if (addressFocus.get(id) === focus) addressFocus.delete(id) }
    },
    canFocusAddress: id => addressFocus.has(id),
    focusAddress: (id) => {
      const focus = addressFocus.get(id)
      if (focus === undefined) return false
      focus()
      return true
    },
    pageInfo: id => controller(id)?.pageInfo(),
    requestShortcut: (id, draft) => {
      const target = controller(id)
      if (target === undefined) return false
      target.requestShortcut(draft)
      return true
    },
    dismissShortcut: (id) => { controller(id)?.dismissShortcut() },
    restore: (id) => { controller(id)?.restore() },
    goBack: (id) => { controller(id)?.goBack() },
    goForward: (id) => { controller(id)?.goForward() },
    reload: (id) => { controller(id)?.reload() },
    setSandbox: (id, enabled) => { controller(id)?.setSandbox(enabled) },
  }
}
