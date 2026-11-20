/** Main-owned native presentation; a DOM viewport is an address, never a guest. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { DesktopNativeViews, DesktopNativeLease, DesktopNativeState, SidebarNativeSlot } from '../../types.ts'
import { tabWireId } from '../../browser/handles.ts'
import type { BrowserPageOptions, BrowserPage } from '../browser/BrowserPage.ts'
import { emptyBrowserFrame, type BrowserFrame, type BrowserFrameState, type BrowserCarrierState } from '../browser/BrowserFrame.ts'
import type { BrowserPresentation } from '../view/BrowserPresentation.ts'
import type { BrowserTarget } from '../browser/url.ts'
import { parseBrowserAddress } from '../browser/url.ts'
import { browserAddressCheckpoint } from '../browser/BrowserPersistence.ts'

export type NativeSlotRegistrar = (tab: TabId, scope: string, viewportId: string, signal: AbortSignal) => Promise<SidebarNativeSlot>

function failure(code: string): Error { return Object.assign(new Error(code), { code }) }

/** Native leases share one attachment lifetime and never create a webview or another carrier. */
export class NativeViewPage implements BrowserFrame, BrowserPresentation {
  private readonly state = createSnapshotStore<BrowserFrameState>(emptyBrowserFrame())
  private readonly carrier = createSnapshotStore<BrowserCarrierState>({ stage: 'idle' })
  private attachment: { viewport: string; lifetime: AbortController } | undefined
  private lease: DesktopNativeLease | undefined
  private unsubscribe: (() => void) | undefined
  private pending: BrowserTarget | undefined
  private initialization: Promise<void> | undefined
  private readonly releases = new Set<Promise<void>>()
  private disposed = false
  private revision = 0
  private attached = false
  private disposal: Promise<void> | undefined

  constructor(private readonly options: BrowserPageOptions, private readonly native: DesktopNativeViews,
    private readonly register: NativeSlotRegistrar, private readonly workspace: (signal: AbortSignal) => Promise<string>,
    private readonly owner: string) {}

  readonly lifecycle = { getSnapshot: (): BrowserCarrierState => this.carrier.getSnapshot(),
    subscribe: (listener: () => void): (() => void) => this.carrier.subscribe(listener) }
  getSnapshot = (): BrowserFrameState => this.state.getSnapshot()
  subscribe = (listener: () => void): (() => void) => this.state.subscribe(listener)

  mount(viewport: string): () => void {
    this.detach()
    if (this.disposed) return () => {}
    const attachment = { viewport, lifetime: new AbortController() }
    this.attachment = attachment
    const element = document.getElementById(viewport)
    if (element !== null) element.dataset.sidebarBrowserFrame = 'native'
    this.pending ??= this.state.getSnapshot().target
    this.initialize()
    return () => { if (this.attachment === attachment) this.detach() }
  }

  loadUrl(target: BrowserTarget, navigationId?: string): void {
    if (this.disposed) return
    this.revision++
    this.pending = target
    this.state.set({ ...this.state.getSnapshot(), target, navigationId, address: 'requested', loading: true, documentReady: false, error: undefined })
    this.options.persist(browserAddressCheckpoint(target, this.revision))
    if (this.lease !== undefined && this.attached) this.navigatePending()
    else this.initialize()
  }

  goBack(): void { void this.history(-1) }
  goForward(): void { void this.history(1) }
  reload(): void { void this.command('Page.reload').catch(error => this.fail(error)) }

  dispose(): Promise<void> {
    if (this.disposal !== undefined) return this.disposal
    this.disposed = true
    this.detach()
    this.disposal = (async () => { await this.initialization; await Promise.all(this.releases) })()
    return this.disposal
  }

  private detach(): void {
    this.attachment?.lifetime.abort()
    this.attachment = undefined
    this.attached = false
    this.unsubscribe?.(); this.unsubscribe = undefined
    const lease = this.lease; this.lease = undefined
    if (lease !== undefined) this.release(lease)
    this.carrier.set({ stage: 'idle' })
  }

  private release(lease: DesktopNativeLease): void {
    const pending = this.native.release(lease).finally(() => { this.releases.delete(pending) })
    this.releases.add(pending)
    void pending.catch(error => console.error('Native Sidebar release failed', error))
  }

  private initialize(): void {
    const attachment = this.attachment
    if (attachment === undefined || this.pending === undefined || this.initialization !== undefined || this.lease !== undefined) return
    this.initialization = (async () => {
      await Promise.all(this.releases)
      const signal = attachment.lifetime.signal
      signal.throwIfAborted()
      const tab = this.options.tabId
      if (tab === undefined) throw failure('BROWSER_OWNER_UNKNOWN')
      const scope = tabWireId({ owner: this.owner, session: 'sidebar', tab })
      const slot = await this.register(tab, scope, attachment.viewport, signal)
      const workspace = await this.workspace(signal)
      signal.throwIfAborted()
      const { lease } = await this.native.acquire(scope, workspace)
      if (signal.aborted) { this.release(lease); return }
      this.lease = lease
      this.unsubscribe = this.native.onState(lease, event => { this.observe(lease, event) })
      await this.native.attach(lease, slot)
      signal.throwIfAborted()
      this.attached = true
      this.navigatePending()
    })().catch(error => {
      if (!attachment.lifetime.signal.aborted) this.fail(error)
    }).finally(() => {
      this.initialization = undefined
      if (this.attachment !== attachment && this.pending !== undefined) this.initialize()
    })
  }

  private navigatePending(): void {
    const target = this.pending
    if (target === undefined) return
    this.pending = undefined
    void this.command('Page.navigate', { url: target.url }).catch(error => this.fail(error))
  }

  private observe(lease: DesktopNativeLease, event: DesktopNativeState): void {
    if (this.lease !== lease || this.disposed) return
    if (event.stage === 'failed' || event.stage === 'closed') { this.fail(failure(event.code ?? 'BROWSER_GUEST_CLOSED')); return }
    this.carrier.set({ stage: 'guest', guestId: lease, generation: event.generation })
    this.state.set({ ...this.state.getSnapshot(), loading: true, documentReady: false })
    if (event.stage !== 'document' || !event.frameId || !event.loaderId) return
    const revision = this.revision
    void (async () => {
      const answer = await this.command('Runtime.evaluate', { expression: '({url:location.href,title:document.title})', returnByValue: true }) as { result?: { value?: { url?: string; title?: string } } }
      const history = await this.command('Page.getNavigationHistory') as { currentIndex: number; entries: readonly object[] }
      if (this.lease !== lease || revision !== this.revision || this.carrier.getSnapshot().generation !== event.generation) return
      const observed = parseBrowserAddress(answer.result?.value?.url ?? '', undefined)
      if (!observed.ok) throw failure('BROWSER_DOCUMENT_UNACKNOWLEDGED')
      const target = { ...observed.target, ...typeof answer.result?.value?.title === 'string' ? { title: answer.result.value.title } : {} }
      this.carrier.set({ stage: 'ready', guestId: lease, generation: event.generation, frameId: event.frameId, loaderId: event.loaderId })
      this.state.set({ ...this.state.getSnapshot(), target, address: 'observed', loading: false, documentReady: true,
        canGoBack: history.currentIndex > 0, canGoForward: history.currentIndex < history.entries.length - 1, error: undefined })
      this.options.persist(browserAddressCheckpoint(target, this.revision))
    })().catch(error => {
      if (this.lease === lease && revision === this.revision && this.carrier.getSnapshot().generation === event.generation) this.fail(error)
    })
  }

  private command(method: string, params?: object): Promise<object> {
    if (this.lease === undefined) return Promise.reject(failure('BROWSER_GUEST_CLOSED'))
    return this.native.command(this.lease, method, params)
  }

  private async history(delta: number): Promise<void> {
    try {
      const history = await this.command('Page.getNavigationHistory') as { currentIndex: number; entries: readonly { id: number }[] }
      const entry = history.entries[history.currentIndex + delta]
      if (entry !== undefined) await this.command('Page.navigateToHistoryEntry', { entryId: entry.id })
    } catch (error) { this.fail(error) }
  }

  private fail(error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error)
    this.detach()
    if (this.disposed) return
    this.carrier.set({ stage: 'failed', reason: 'guest-bootstrap-failed', detail })
    const code = error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'BROWSER_NATIVE_SURFACE_UNAVAILABLE'
    this.state.set({ ...this.state.getSnapshot(), loading: false, documentReady: false, error: { code, description: detail } })
  }
}

export function createNativePage(options: BrowserPageOptions, native: DesktopNativeViews, register: NativeSlotRegistrar,
  workspace: (signal: AbortSignal) => Promise<string>, owner: string): BrowserPage {
  const page = new NativeViewPage(options, native, register, workspace, owner)
  return { frame: page, presentation: page }
}
