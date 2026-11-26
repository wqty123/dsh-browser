/** A lazy, reconnectable sidebar carrier that preserves the provider's view handles. */
import { readTabHandle, resolveSessionHandle, resolveTabHandle, sessionWireId, type BrowserSessionWireId, type BrowserTabWireId } from '../browser/handles.ts'
import type { CarrierLossReason, CarrierPage } from '../browser/types.ts'
import type {
  CommandOptions, ElectronBrowserViewHost, ElectronViewHandle, PresentOptions,
} from './provider.ts'

interface HostLease {
  readonly host: ElectronBrowserViewHost
}

interface BoundView {
  readonly lease: HostLease
  readonly handle: ElectronViewHandle
}

interface SidebarView {
  readonly handle: ElectronViewHandle
  readonly scope: BrowserSessionWireId
  bound?: BoundView
  pending?: Promise<BoundView>
  /**
   * The shell's own page id this view was adopted from.
   *
   * Kept across a bridge reconnect so rebinding adopts the SAME page again. A
   * plain `createView` would open a fresh blank page and the next capture would
   * silently read the wrong document.
   */
  adoptedId?: BrowserTabWireId
}

/**
 * Keep an explicit sidebar selection while its bridge starts or reconnects.
 * Discovery is deferred until a command needs the bridge; it never selects another carrier.
 */
export class SidebarOnlyHost implements ElectronBrowserViewHost {
  readonly referenceOverlayOwner = 'client' as const
  private readonly views = new Map<string, SidebarView>()
  private readonly retiredSessions = new Set<BrowserSessionWireId>()
  private lease: HostLease | undefined
  private loading: Promise<HostLease> | undefined
  private disposed = false
  private readonly discovery = new AbortController()
  private lostListener: ((reason: CarrierLossReason) => void) | undefined
  private readonly loader: (signal: AbortSignal) => Promise<ElectronBrowserViewHost>
  constructor(loader: (signal: AbortSignal) => Promise<ElectronBrowserViewHost>) {
    this.loader = loader
  }

  /** Keep the explicit selection available so discovery failures reach the caller unchanged. */
  available(): boolean { return !this.disposed }

  /** Return a stable handle without opening a sidebar or discovering a bridge. */
  createView(identity: BrowserTabWireId): ElectronViewHandle {
    this.assertOpen()
    const scope = sessionWireId(readTabHandle(identity))
    if (this.retiredSessions.has(scope)) throw new Error('dsh-builtin-browser: sidebar session was released')
    if (this.views.has(identity)) throw new Error('dsh-builtin-browser: sidebar view is already bound')
    const handle: ElectronViewHandle = {
      id: identity,
      sendCommand: (method, params, options) => this.send(view, method, params, options),
      download: async (url, savePath) => {
        const bound = await this.bind(view)
        this.assertView(view)
        this.assertLease(bound.lease)
        if (bound.handle.download === undefined) throw new Error('dsh-builtin-browser: update the desktop bridge for sidebar downloads')
        await bound.handle.download(url, savePath)
      },
    }
    const view: SidebarView = { handle, scope }
    this.views.set(handle.id, view)
    return handle
  }

  destroyView(handle: ElectronViewHandle): void {
    const view = this.views.get(handle.id)
    if (view?.handle !== handle) return
    this.views.delete(handle.id)
    if (view.bound !== undefined) view.bound.lease.host.destroyView(view.bound.handle)
    view.bound = undefined
  }

  /** Presentation must not turn the provider's initial show into a blank-page navigation. */
  showView(handle: ElectronViewHandle, label?: string, options?: PresentOptions): void {
    const view = this.views.get(handle.id)
    const bound = view?.handle === handle ? view.bound : undefined
    if (!this.disposed && bound !== undefined && bound.lease === this.lease) {
      bound.lease.host.showView?.(bound.handle, label, options)
    }
  }

  async presentView(handle: ElectronViewHandle, label?: string, options?: PresentOptions): Promise<void> {
    const view = this.views.get(handle.id)
    if (view?.handle !== handle) throw new Error('dsh-builtin-browser: sidebar view is destroyed')
    const bound = await this.bind(view)
    if (bound.lease.host.presentView === undefined) throw new Error('dsh-builtin-browser: sidebar bridge cannot acknowledge selection')
    await bound.lease.host.presentView(bound.handle, label, options)
    this.assertView(view)
    this.assertLease(bound.lease)
  }

  async listPages(scope: BrowserSessionWireId, options?: { readonly requireRunning?: boolean }): Promise<readonly CarrierPage[]> {
    resolveSessionHandle(scope)
    const lease = await this.load()
    this.assertLease(lease)
    if (this.retiredSessions.has(scope)) throw new Error('dsh-builtin-browser: sidebar session was released')
    const pages = await lease.host.listPages?.(scope, options) ?? []
    for (const page of pages) resolveTabHandle(resolveSessionHandle(scope), page.id)
    return pages
  }

  /**
   * Bind a page the SHELL opened to a handle the provider can drive.
   *
   * The delegation is the point: discovery happens at the first command, so a page
   * adopted before the bridge is up must still bind later. The adopted handle is
   * stored as this view's binding, which is exactly what `bind` would have created —
   * the difference is only which guest it points at.
   * @param id - the sidebar page id reported by {@link listPages}.
   * @param owner - the conversation the page belongs to.
   * @returns a handle whose commands target that page.
   */
  async adoptPage(id: BrowserTabWireId, scope = sessionWireId(readTabHandle(id))): Promise<ElectronViewHandle> {
    resolveTabHandle(resolveSessionHandle(scope), id)
    if (this.retiredSessions.has(scope)) throw new Error('dsh-builtin-browser: sidebar session was released')
    const lease = await this.load()
    this.assertLease(lease)
    if (lease.host.adoptPage === undefined) throw new Error('dsh-builtin-browser: this sidebar bridge cannot hand over a page it did not open')
    const adopted = await lease.host.adoptPage(id, scope)
    this.assertLease(lease)
    if (adopted.id !== id) {
      lease.host.destroyView(adopted)
      throw new Error('dsh-builtin-browser: sidebar returned a different tab handle')
    }
    const handle: ElectronViewHandle = {
      id: adopted.id,
      sendCommand: (method, params, options) => this.send(view, method, params, options),
      download: async (url, savePath) => {
        const bound = await this.bind(view)
        this.assertView(view)
        this.assertLease(bound.lease)
        if (bound.handle.download === undefined) throw new Error('dsh-builtin-browser: update the desktop bridge for sidebar downloads')
        await bound.handle.download(url, savePath)
      },
    }
    const view: SidebarView = { handle, scope, bound: { lease, handle: adopted }, adoptedId: id }
    this.views.set(handle.id, view)
    return handle
  }

  async closePage(id: BrowserTabWireId, scope = sessionWireId(readTabHandle(id))): Promise<void> {
    resolveTabHandle(resolveSessionHandle(scope), id)
    const lease = await this.load()
    this.assertLease(lease)
    if (lease.host.closePage === undefined) throw new Error('dsh-builtin-browser: this sidebar bridge cannot close pages')
    await lease.host.closePage(id, scope)
  }

  async retireSession(scope: BrowserSessionWireId): Promise<void> {
    resolveSessionHandle(scope)
    this.retiredSessions.add(scope)
    for (const view of [...this.views.values()]) if (view.scope === scope) this.destroyView(view.handle)
    const lease = this.lease ?? await this.loading
    if (!this.disposed && lease !== undefined && lease === this.lease) await lease.host.retireSession?.(scope)
  }

  /** Retire only this conversation's handles before awaiting an in-flight discovery. */
  async releasePage(scope?: BrowserSessionWireId): Promise<void> {
    if (scope !== undefined) {
      resolveSessionHandle(scope)
      this.retiredSessions.add(scope)
    }
    for (const view of [...this.views.values()]) {
      if (scope === undefined || view.scope === scope) this.destroyView(view.handle)
    }
    const lease = this.lease ?? await this.loading
    if (!this.disposed && lease !== undefined && lease === this.lease) await lease.host.releasePage?.(scope)
  }

  async collapse(): Promise<void> {
    if (!this.disposed) await this.lease?.host.collapse?.()
  }

  onLost(listener: (reason: CarrierLossReason) => void): void {
    this.lostListener = listener
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.discovery.abort()
    this.views.clear()
    const lease = this.lease
    this.lease = undefined
    this.lostListener = undefined
    lease?.host.dispose?.()
  }

  private assertOpen(): void {
    if (this.disposed) throw new Error('dsh-builtin-browser: sidebar host is disposed')
  }

  private assertView(view: SidebarView): void {
    this.assertOpen()
    if (this.views.get(view.handle.id) !== view) throw new Error('dsh-builtin-browser: sidebar view is destroyed')
  }

  private assertLease(lease: HostLease): void {
    this.assertOpen()
    if (this.lease !== lease) throw new Error('dsh-builtin-browser: sidebar bridge changed before the operation')
  }

  private load(): Promise<HostLease> {
    this.assertOpen()
    if (this.lease !== undefined) return Promise.resolve(this.lease)
    if (this.loading !== undefined) return this.loading
    const pending = Promise.resolve().then(() => this.loader(this.discovery.signal)).then(host => {
      if (this.disposed) {
        host.dispose?.()
        this.assertOpen()
      }
      const lease: HostLease = { host }
      this.lease = lease
      try {
        host.onLost?.(reason => this.lost(lease, reason))
      } catch (error) {
        if (this.lease === lease) this.lease = undefined
        host.dispose?.()
        throw error
      }
      if (this.lease !== lease) throw new Error('dsh-builtin-browser: sidebar bridge was lost during discovery')
      return lease
    })
    this.loading = pending
    const clear = (): void => { if (this.loading === pending) this.loading = undefined }
    void pending.then(clear, clear)
    return pending
  }

  private lost(lease: HostLease, reason: CarrierLossReason): void {
    if (this.disposed || this.lease !== lease) return
    this.lease = undefined
    this.loading = undefined
    for (const view of this.views.values()) {
      view.bound = undefined
      view.pending = undefined
    }
    // A command already in flight keeps its original outcome; the next call rediscovers.
    setImmediate(() => {
      try { lease.host.dispose?.() } catch { /* The next discovery replaces this failed carrier. */ }
    })
    try { this.lostListener?.(reason) } catch { /* Transport recovery must survive a listener failure. */ }
  }

  private bind(view: SidebarView): Promise<BoundView> {
    this.assertView(view)
    if (view.bound !== undefined && view.bound.lease === this.lease) return Promise.resolve(view.bound)
    if (view.pending !== undefined) return view.pending
    const pending = this.load().then(lease => {
      this.assertView(view)
      if (this.lease !== lease) throw new Error('dsh-builtin-browser: sidebar bridge changed before binding the view')
      // An adopted view rebinds to its ORIGINAL page: a bridge reconnect must not
      // turn the human's page into a fresh blank one the next capture would read.
      const adoptedId = view.adoptedId
      if (adoptedId !== undefined) {
        if (lease.host.adoptPage === undefined) throw new Error('dsh-builtin-browser: this sidebar bridge cannot hand over a page it did not open')
        return lease.host.adoptPage(adoptedId, view.scope).then(handle => {
          this.assertView(view)
          if (this.lease !== lease || handle.id !== view.handle.id) {
            lease.host.destroyView(handle)
            throw new Error('dsh-builtin-browser: sidebar bridge changed while binding the view')
          }
          const bound = { lease, handle }
          view.bound = bound
          return bound
        })
      }
      const handle = lease.host.createView(view.handle.id as BrowserTabWireId)
      if (this.disposed || this.views.get(view.handle.id) !== view || this.lease !== lease) {
        lease.host.destroyView(handle)
        this.assertView(view)
        throw new Error('dsh-builtin-browser: sidebar bridge changed while binding the view')
      }
      const bound = { lease, handle }
      view.bound = bound
      return bound
    })
    view.pending = pending
    const clear = (): void => { if (view.pending === pending) view.pending = undefined }
    void pending.then(clear, clear)
    return pending
  }

  private async send(view: SidebarView, method: string, params?: Record<string, unknown>, options?: CommandOptions): Promise<Record<string, unknown>> {
    const bound = await this.bind(view)
    this.assertView(view)
    if (this.lease !== bound.lease) throw new Error('dsh-builtin-browser: sidebar bridge changed before the command')
    return bound.handle.sendCommand(method, params, options)
  }
}
