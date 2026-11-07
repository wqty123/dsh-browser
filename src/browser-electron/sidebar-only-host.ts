/** A lazy, reconnectable sidebar carrier that preserves the provider's view handles. */
import { randomUUID } from 'node:crypto'
import type { CarrierLossReason, CarrierPage } from '../browser/types.js'
import type {
  CommandOptions, ElectronBrowserViewHost, ElectronViewHandle, PresentOptions,
} from './provider.js'

interface HostLease {
  readonly host: ElectronBrowserViewHost
}

interface BoundView {
  readonly lease: HostLease
  readonly handle: ElectronViewHandle
}

interface SidebarView {
  readonly handle: ElectronViewHandle
  readonly owner: string | undefined
  bound?: BoundView
  pending?: Promise<BoundView>
}

/**
 * Keep an explicit sidebar selection while its bridge starts or reconnects.
 * Discovery is deferred until a command needs the bridge; it never selects another carrier.
 */
export class SidebarOnlyHost implements ElectronBrowserViewHost {
  private readonly views = new Map<string, SidebarView>()
  private lease: HostLease | undefined
  private loading: Promise<HostLease> | undefined
  private disposed = false
  private lostListener: ((reason: CarrierLossReason) => void) | undefined

  constructor(private readonly loader: () => Promise<ElectronBrowserViewHost>) {}

  /** Keep the explicit selection available so discovery failures reach the caller unchanged. */
  available(): boolean { return !this.disposed }

  /** Return a stable handle without opening a sidebar or discovering a bridge. */
  createView(owner?: string): ElectronViewHandle {
    this.assertOpen()
    const handle: ElectronViewHandle = {
      id: randomUUID(),
      sendCommand: (method, params, options) => this.send(view, method, params, options),
      download: async (url, savePath) => {
        const bound = await this.bind(view)
        this.assertView(view)
        this.assertLease(bound.lease)
        if (bound.handle.download === undefined) throw new Error('dsh-builtin-browser: update the desktop bridge for sidebar downloads')
        await bound.handle.download(url, savePath)
      },
    }
    const view: SidebarView = { handle, owner }
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

  async listPages(owner?: string): Promise<readonly CarrierPage[]> {
    const lease = await this.load()
    this.assertLease(lease)
    return lease.host.listPages === undefined ? [] : lease.host.listPages(owner)
  }

  async closePage(id: string, owner?: string): Promise<void> {
    const lease = await this.load()
    this.assertLease(lease)
    if (lease.host.closePage === undefined) throw new Error('dsh-builtin-browser: this sidebar bridge cannot close pages')
    await lease.host.closePage(id, owner)
  }

  /** Retire only this conversation's handles before awaiting an in-flight discovery. */
  async releasePage(owner?: string): Promise<void> {
    for (const view of [...this.views.values()]) {
      if (owner === undefined || view.owner === owner) this.destroyView(view.handle)
    }
    const lease = this.lease ?? await this.loading?.catch(() => undefined)
    if (!this.disposed && lease !== undefined && lease === this.lease) await lease.host.releasePage?.(owner)
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
    const pending = Promise.resolve().then(this.loader).then(host => {
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
    try { lease.host.dispose?.() } catch { /* The next discovery replaces this failed carrier. */ }
    try { this.lostListener?.(reason) } catch { /* Transport recovery must survive a listener failure. */ }
  }

  private bind(view: SidebarView): Promise<BoundView> {
    this.assertView(view)
    if (view.bound !== undefined && view.bound.lease === this.lease) return Promise.resolve(view.bound)
    if (view.pending !== undefined) return view.pending
    const pending = this.load().then(lease => {
      this.assertView(view)
      if (this.lease !== lease) throw new Error('dsh-builtin-browser: sidebar bridge changed before binding the view')
      const handle = lease.host.createView(view.owner)
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
