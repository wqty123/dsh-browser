import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NativeBrowserClient, type ExtensionConnectionStatus } from '../../native-host/client.mjs'
import { readTabHandle, resolveSessionHandle, resolveTabHandle, sessionWireId, tabWireId, type BrowserTabWireId } from '../browser/handles.ts'
import type { BrowserSessionId, CarrierPage } from '../browser/types.ts'
import type { ElectronBrowserViewHost, ElectronViewHandle } from './provider.ts'
import { dshHome } from './paths.ts'

interface Lease { lease: string; tabId: number }
interface View {
  readonly handle: ElectronViewHandle
  readonly scope: BrowserSessionId
  lease?: Lease
  pending?: Promise<Lease>
  invalid: boolean
}

export function extensionDirectory(browser: 'edge' | 'chrome'): string {
  return join(dshHome(), 'dsh-builtin-browser-host', 'extension', browser)
}

export function extensionInstallHelp(browser: 'edge' | 'chrome') {
  return {
    platform: process.platform,
    extensionDirectory: fileURLToPath(new URL('../../browser-extension/', import.meta.url)),
    installer: fileURLToPath(new URL('../../native-host/install.mjs', import.meta.url)),
    directory: extensionDirectory(browser),
    node: process.execPath,
    extensionsUrl: `${browser}://extensions`,
  }
}

export class ExtensionBrowserViewHost implements ElectronBrowserViewHost {
  readonly referenceOverlayOwner = 'client' as const
  private readonly views = new Map<string, View>()
  private readonly unsubscribe: () => void
  private disposed = false

  constructor(readonly browser: 'edge' | 'chrome', private readonly client = new NativeBrowserClient(extensionDirectory(browser), browser)) {
    this.unsubscribe = client.onEvent(event => {
      if (event.method === 'transport.disconnected') for (const view of this.views.values()) view.invalid = true
      if (event.method === 'target.detached' || event.method === 'target.closed') {
        for (const view of this.views.values()) if (view.lease?.lease === event.lease) view.invalid = true
      }
    })
  }

  connectionStatus(): ExtensionConnectionStatus { return this.client.status() }

  connectedView(id: string): boolean {
    const view = this.views.get(id)
    return !this.disposed && !!view?.lease && !view.invalid && this.client.status().connected
  }

  async refreshStatus(): Promise<void> {
    try { await this.prepare() } catch { /* Status retains the install/pair/disconnect diagnosis. */ }
  }

  async prepare(): Promise<void> {
    if (this.disposed) throw new Error('extension carrier was released')
    await this.client.connect()
  }

  createView(identity: BrowserTabWireId): ElectronViewHandle {
    const scope = sessionWireId(readTabHandle(identity))
    if (this.views.has(identity)) throw new Error('extension view already exists')
    const handle: ElectronViewHandle = { id: identity, supportsCdpJpeg: true, sendCommand: async (method, params) => {
      const lease = await this.ensureLease(view)
      return await this.client.request({ kind: 'cdp', scope, view: identity, lease: lease.lease, method, params }) as Record<string, unknown>
    } }
    const view: View = { handle, scope, invalid: false }
    this.views.set(identity, view)
    return handle
  }

  private async ensureLease(view: View): Promise<Lease> {
    if (this.disposed || view.invalid || this.views.get(view.handle.id) !== view) throw new Error('extension tab lease was released; explicitly reopen or reacquire the tab')
    if (view.lease) return view.lease
    view.pending ??= this.acquire(view, { kind: 'create' })
    return view.pending
  }

  private async acquire(view: View, operation: Record<string, unknown>): Promise<Lease> {
    await this.prepare()
    const value = await this.client.request({ ...operation, scope: view.scope, view: view.handle.id }) as Lease
    if (!value || typeof value.lease !== 'string' || !Number.isSafeInteger(value.tabId)) throw new Error('extension returned an invalid lease')
    if (this.disposed || view.invalid || this.views.get(view.handle.id) !== view) {
      await this.client.request({ kind: 'detach', scope: view.scope, view: view.handle.id, lease: value.lease }).catch(() => {})
      throw new Error('extension view was released while attaching; tab left open')
    }
    view.lease = value
    return value
  }

  destroyView(handle: ElectronViewHandle): void {
    const view = this.views.get(handle.id)
    if (!view) return
    this.views.delete(handle.id)
    view.invalid = true
    if (view.lease && this.client.status().connected) void this.client.request({ kind: 'detach', scope: view.scope, view: handle.id, lease: view.lease.lease }).catch(() => {})
  }

  async listPages(scope: BrowserSessionId, options: { readonly requireRunning?: boolean } = {}): Promise<readonly CarrierPage[]> {
    const identity = resolveSessionHandle(scope)
    if (options.requireRunning && !this.client.status().connected) return []
    await this.prepare()
    const epoch = this.client.status().epoch
    const pages = await this.client.request({ kind: 'list', scope }) as Array<{ tabId: number; title: string; url: string }>
    if (!epoch || !Array.isArray(pages)) throw new Error('extension tab inventory is unavailable')
    return pages.map(page => ({ id: tabWireId({ ...identity, tab: `page:extension:${epoch}:${page.tabId}` }), url: page.url, title: page.title }))
  }

  private pageId(id: BrowserTabWireId, scope: BrowserSessionId): number {
    const { tab } = resolveTabHandle(resolveSessionHandle(scope), id)
    const prefix = `page:extension:${this.client.status().epoch}:`
    if (!this.client.status().connected || !tab.startsWith(prefix) || !/^\d+$/.test(tab.slice(prefix.length))) throw new Error('stale or foreign extension page; list tabs again')
    const tabId = Number(tab.slice(prefix.length))
    if (!Number.isSafeInteger(tabId)) throw new Error('invalid extension tab')
    return tabId
  }

  async adoptPage(id: BrowserTabWireId, scope = sessionWireId(readTabHandle(id))): Promise<ElectronViewHandle> {
    await this.prepare()
    const tabId = this.pageId(id, scope)
    const handle = this.createView(id), view = this.views.get(id)!
    view.pending = this.acquire(view, { kind: 'attach', tabId })
    try { await view.pending; return handle }
    catch (error) { this.destroyView(handle); throw error }
  }

  async closePage(id: BrowserTabWireId, scope = sessionWireId(readTabHandle(id))): Promise<void> {
    resolveTabHandle(resolveSessionHandle(scope), id)
    const view = this.views.get(id)
    if (view && !view.lease && !view.pending) { this.destroyView(view.handle); return }
    const tabId = view ? (await this.ensureLease(view)).tabId : this.pageId(id, scope)
    await this.client.request({ kind: 'close', scope, tabId })
    if (view) this.destroyView(view.handle)
  }

  showView(): void {}
  async presentView(): Promise<void> {}
  focus(): void {}

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    const views = [...this.views.values()]
    this.views.clear()
    for (const view of views) view.invalid = true
    this.unsubscribe()
    void Promise.allSettled(views.map(async view => {
      await view.pending?.catch(() => {})
      if (view.lease && this.client.status().connected) await this.client.request({ kind: 'detach', scope: view.scope, view: view.handle.id, lease: view.lease.lease })
    })).finally(() => { this.client.dispose() })
  }
}
