/** Electron navigation and guest lifetime, independent from DOM placement. */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { DesktopBrowserBridge, DesktopBrowserLeaseId } from '../../types.ts'
import type { ElectronWebviewPresentation, WebviewElement } from './ElectronWebviewPresentation.ts'
import { emptyBrowserFrame, type BrowserFrame, type BrowserFrameState, type BrowserLoadError } from '../browser/BrowserFrame.ts'
import type { BrowserCarrierState } from '../browser/BrowserFrame.ts'
import type { BrowserPageOptions } from '../browser/BrowserPage.ts'
import { browserAddressCheckpoint, currentBrowserTarget } from '../browser/BrowserPersistence.ts'
import { parseBrowserAddress, type BrowserTarget } from '../browser/url.ts'
import { captureReferenceIntent } from '../reference-intents.ts'
import { installReferenceOverlay } from './reference-overlay.ts'

interface NavigationEvent extends Event { readonly isMainFrame: boolean; readonly isInPlace?: boolean }
interface LoadFailureEvent extends NavigationEvent {
  readonly errorCode: number
  readonly errorDescription: string
}

/** Owns native history and translates Electron observations into common frame state. */
export class ElectronWebViewImpl implements BrowserFrame {
  private readonly store: SnapshotStore<BrowserFrameState>
  /** Carrier proof, separate from navigation state: guest created, document ready, bootstrap failed. */
  private readonly carrier: SnapshotStore<BrowserCarrierState>
  private readonly lifetime = new AbortController()
  private guestLifetime: AbortController | undefined
  private documentLifetime: AbortController | undefined
  private element: WebviewElement | undefined
  private lease: DesktopBrowserLeaseId | undefined
  private workspaceKey: string | undefined
  private initializing: Promise<void> | undefined
  private ready = false
  private pending: BrowserTarget | undefined
  private revision = 0
  private firstDocument = true
  private checkpoint: BrowserTarget | undefined
  private disposal: Promise<void> | undefined
  private attachment: AbortController | undefined
  private readonly releases = new Set<Promise<void>>()

  /**
   * @param options - saved address, persistence and source-tab opening callback.
   * @param bridge - main-process guest operations.
   * @param workspace - resolves the storage account once for this frame lifetime.
   * @param presentation - tag and Sidebar placement adapter.
   */
  constructor(private readonly options: BrowserPageOptions, private readonly bridge: DesktopBrowserBridge,
    private readonly workspace: (signal: AbortSignal) => Promise<string>,
    private readonly presentation: ElectronWebviewPresentation, private readonly sessionId: string,
    private readonly capture: (intent: object, owner?: string) => Promise<void> = (intent, owner) => captureReferenceIntent(intent, owner ?? '')) {
    this.checkpoint = currentBrowserTarget(options.initial)
    this.store = createSnapshotStore(emptyBrowserFrame())
    this.carrier = createSnapshotStore<BrowserCarrierState>({ stage: 'idle' })
  }

  /** @returns immutable carrier-level initialization proof. */
  readonly lifecycle = {
    getSnapshot: (): BrowserCarrierState => this.carrier.getSnapshot(),
    subscribe: (listener: () => void): (() => void) => this.carrier.subscribe(listener),
  }

  /** @returns immutable carrier-neutral navigation state. */
  getSnapshot = (): BrowserFrameState => this.store.getSnapshot()
  /** @param listener - state invalidation. @returns unsubscribe callback. */
  subscribe = (listener: () => void): (() => void) => this.store.subscribe(listener)

  /** A physical mount may recreate a lost guest; ordinary Sidebar hiding never calls this. */
  attach(): void {
    if (this.lifetime.signal.aborted) return
    this.attachment = new AbortController()
    this.carrier.set({ stage: 'idle' })
    this.pending ??= this.store.getSnapshot().target
    if (this.pending !== undefined) {
      this.store.set({ ...this.store.getSnapshot(), address: 'requested', loading: true,
        canGoBack: false, canGoForward: false, error: undefined })
      this.initialize()
    }
  }

  /** Invalidate pending attachment before the containing DOM is removed. */
  detach(): void {
    this.attachment?.abort()
    this.attachment = undefined
    this.pending = this.store.getSnapshot().target
    this.carrier.set({ stage: 'idle' })
    void this.dropGuest()
  }

  /** @param target - validated address, loaded without replacing the guest. */
  loadUrl(target: BrowserTarget, navigationId?: string): void {
    if (this.lifetime.signal.aborted) return
    const current = this.store.getSnapshot()
    if (this.ready && current.address === 'observed' && current.target?.url === target.url) {
      this.store.set({ ...current, navigationId, loading: true })
      this.reload()
      return
    }
    this.revision++
    this.pending = target
    this.store.set({ ...current, navigationId, target, address: 'requested', loading: true, error: undefined })
    this.persist(target)
    if (this.ready) this.loadPending()
    else this.initialize()
  }

  /** Move backward through Chromium history. */
  goBack(): void {
    if (this.store.getSnapshot().canGoBack) this.navigate('goBack')
  }

  /** Move forward through Chromium history. */
  goForward(): void {
    if (this.store.getSnapshot().canGoForward) this.navigate('goForward')
  }

  /** Reload the actual current page, or retry failed guest creation. */
  reload(): void {
    const current = this.store.getSnapshot()
    if (this.lifetime.signal.aborted || current.target === undefined) return
    if (!this.ready || current.error !== undefined) {
      this.revision++
      this.pending = current.target
      this.store.set({ ...current, loading: true, error: undefined })
      if (this.ready) this.loadPending()
      else this.initialize()
    } else this.navigate('reload')
  }

  /** @returns after pending initialization and the owned guest have been released. */
  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.lifetime.abort()
    this.pending = undefined
    this.disposal = (async () => {
      await this.dropGuest()
      // A cancelled createGuest can restart initialize() for a replacement
      // attachment inside its .finally. Await every generation so no guest
      // creation or lease release outlives disposal.
      for (let init = this.initializing; init !== undefined; init = this.initializing) {
        await init
      }
      await Promise.all(this.releases)
    })()
    this.presentation.dispose()
    return this.disposal
  }

  private navigate(command: 'goBack' | 'goForward' | 'reload'): void {
    if (this.lifetime.signal.aborted || !this.ready || this.element === undefined) return
    this.revision++
    this.pending = undefined
    this.store.set({ ...this.store.getSnapshot(), loading: true, error: undefined })
    try { this.element[command]() }
    catch (error) { this.commandFailed(error) }
  }

  private initialize(): void {
    const attachment = this.attachment
    if (attachment === undefined || this.initializing !== undefined || this.element !== undefined || this.lifetime.signal.aborted) return
    const signal = AbortSignal.any([this.lifetime.signal, attachment.signal])
    this.initializing = this.createGuest(signal, attachment).catch(async (error: unknown) => {
      await this.dropGuest()
      if (!signal.aborted) this.commandFailed(error)
    }).finally(() => {
      this.initializing = undefined
      if (this.attachment !== attachment && this.pending !== undefined) this.initialize()
    })
  }

  /** True when a guest's attachment was invalidated by detach/remount or disposal. */
  private superseded(attachment: AbortController, signal: AbortSignal): boolean {
    return signal.aborted || this.attachment !== attachment
  }

  private async createGuest(attachmentSignal: AbortSignal, attachment: AbortController): Promise<void> {
    try {
      this.workspaceKey ??= await this.workspace(attachmentSignal)
    } catch (error) {
      // A cancelled/superseded attachment is not a bootstrap failure. Publishing
      // `failed` here would let the OLD mount fail the CURRENT occurrence's
      // initialization receipt; initialize()'s .finally starts the new guest.
      if (!this.superseded(attachment, attachmentSignal)) {
        this.carrier.set({ stage: 'failed', reason: 'workspace-unavailable',
          detail: (error instanceof Error ? error.message : String(error)).slice(0, 2000) })
      }
      throw error
    }
    if (attachmentSignal.aborted) return
    let reservation: Awaited<ReturnType<DesktopBrowserBridge['acquire']>>
    try {
      reservation = await this.bridge.acquire(this.workspaceKey)
    } catch (error) {
      if (!this.superseded(attachment, attachmentSignal)) {
        this.carrier.set({ stage: 'failed', reason: 'acquire-failed',
          detail: (error instanceof Error ? error.message : String(error)).slice(0, 2000) })
      }
      throw error
    }
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- The signal can abort while acquire is pending.
    if (attachmentSignal.aborted) { await this.release(reservation.lease); return }
    this.lease = reservation.lease
    this.guestLifetime = new AbortController()
    const signal = AbortSignal.any([attachmentSignal, this.guestLifetime.signal])
    let element: WebviewElement
    try {
      element = this.presentation.createElement(reservation)
    } catch (error) {
      if (!this.superseded(attachment, attachmentSignal)) {
        this.carrier.set({ stage: 'failed', reason: 'guest-bootstrap-failed',
          detail: (error instanceof Error ? error.message : String(error)).slice(0, 2000) })
      }
      throw error
    }
    this.element = element
    this.carrier.set({ stage: 'guest' })
    const unsubscribeOpen = this.bridge.onOpenRequested(reservation.lease, (url) => {
      if (this.element === element && !signal.aborted) this.options.openRequested(url)
    })
    signal.addEventListener('abort', unsubscribeOpen, { once: true })
    element.addEventListener('dom-ready', () => {
      this.documentLifetime?.abort()
      this.documentLifetime = new AbortController()
      installReferenceOverlay(source => element.executeJavaScript(source),
        intent => this.capture(intent, this.sessionId),
        AbortSignal.any([signal, this.documentLifetime.signal]))
      this.ready = true
      const guestId = element.getWebContentsId?.()
      this.carrier.set({ stage: 'ready', ...guestId === undefined ? {} : { guestId: String(guestId) } })
      this.observe(this.store.getSnapshot().address !== 'requested')
      this.loadPending()
    }, { signal })
    element.addEventListener('did-navigate', () => { this.observe(true) }, { signal })
    element.addEventListener('did-navigate-in-page', (event) => {
      if ((event as NavigationEvent).isMainFrame) this.observe(true)
    }, { signal })
    element.addEventListener('did-start-navigation', (event) => {
      if ((event as NavigationEvent).isMainFrame) {
        if (!(event as NavigationEvent).isInPlace) {
          this.documentLifetime?.abort()
          const guestId = element.getWebContentsId?.()
          this.carrier.set({ stage: 'guest', ...guestId === undefined ? {} : { guestId: String(guestId) } })
        }
        this.store.set({ ...this.store.getSnapshot(), loading: true, error: undefined })
      }
    }, { signal })
    for (const name of ['did-start-loading', 'did-stop-loading', 'page-title-updated']) {
      element.addEventListener(name, () => {
        this.observe(name === 'page-title-updated' && this.store.getSnapshot().address === 'observed')
      }, { signal })
    }
    element.addEventListener('did-fail-load', (event) => {
      const failure = event as LoadFailureEvent
      if (failure.isMainFrame && failure.errorCode !== -3) {
        this.failed({ code: failure.errorCode, description: failure.errorDescription })
      }
    }, { signal })
    for (const name of ['render-process-gone', 'destroyed']) {
      element.addEventListener(name, () => { void this.dropGuest(); this.failed() }, { signal })
    }
    try {
      this.presentation.present(element)
    } catch (error) {
      if (!this.superseded(attachment, attachmentSignal)) {
        this.carrier.set({ stage: 'failed', reason: 'guest-bootstrap-failed',
          detail: (error instanceof Error ? error.message : String(error)).slice(0, 2000) })
      }
      throw error
    }
  }

  private loadPending(): void {
    const target = this.pending
    const element = this.element
    if (!this.ready || target === undefined || element === undefined) return
    const revision = this.revision
    this.pending = undefined
    void element.loadURL(target.url).catch((error: unknown) => {
      if (this.element !== element || this.lifetime.signal.aborted || this.revision !== revision) return
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ERR_ABORTED') return
      if (this.store.getSnapshot().error === undefined) this.commandFailed(error)
    })
  }

  private observe(committed: boolean): void {
    if (!this.ready || this.element === undefined || this.lifetime.signal.aborted) return
    try { this.observeReady(this.element, committed) }
    catch (error) { this.commandFailed(error) }
  }

  private observeReady(element: WebviewElement, committed: boolean): void {
    const current = this.store.getSnapshot()
    const parsed = committed ? parseBrowserAddress(element.getURL()) : undefined
    if (parsed?.ok && this.firstDocument) {
      // The lease-bearing bootstrap document is not a user history entry.
      element.clearHistory()
      this.firstDocument = false
    }
    let target = current.target
    let address = current.address
    if (parsed?.ok) {
      target = { ...parsed.target, title: element.getTitle() || parsed.target.title }
      address = 'observed'
      this.presentation.show(target.title)
    }
    const loading = current.error === undefined && element.isLoading()
    const canGoBack = element.canGoBack()
    const canGoForward = element.canGoForward()
    if (target?.url !== current.target?.url || target?.title !== current.target?.title || address !== current.address
      || loading !== current.loading || canGoBack !== current.canGoBack || canGoForward !== current.canGoForward) {
      this.store.set({ ...current, target, address, loading, canGoBack, canGoForward })
    }
    if (parsed?.ok && target !== undefined) this.persist(target)
  }

  private persist(target: BrowserTarget): void {
    if (target.url === this.checkpoint?.url && target.title === this.checkpoint.title) return
    this.checkpoint = target
    this.options.persist(browserAddressCheckpoint(target, this.revision))
  }

  private failed(error: BrowserLoadError = { code: undefined, description: undefined }): void {
    if (this.lifetime.signal.aborted) return
    const current = this.store.getSnapshot()
    this.store.set({ ...current, loading: false, error,
      canGoBack: this.ready && current.canGoBack, canGoForward: this.ready && current.canGoForward })
  }

  private commandFailed(error: unknown): void {
    console.error('Desktop browser operation failed', error)
    this.failed()
  }

  private dropGuest(): Promise<void> {
    this.documentLifetime?.abort()
    this.documentLifetime = undefined
    this.guestLifetime?.abort()
    this.guestLifetime = undefined
    this.presentation.clear()
    this.element = undefined
    this.ready = false
    this.firstDocument = true
    const lease = this.lease
    this.lease = undefined
    return lease === undefined ? Promise.resolve() : this.release(lease)
  }

  private release(lease: DesktopBrowserLeaseId): Promise<void> {
    const released = this.bridge.release(lease)
      .catch((error: unknown) => { console.error('Desktop browser guest release failed', error) })
      .finally(() => { this.releases.delete(released) })
    this.releases.add(released)
    return released
  }
}
