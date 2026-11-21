import { ExtensionBrowserViewHost } from './extension-browser.ts'
import type { NativeBrowserClient } from '../../native-host/client.mjs'
import type { ElectronBrowserViewHost, ElectronViewHandle } from './provider.ts'
import { readTabHandle, sessionWireId, type BrowserTabWireId } from '../browser/handles.ts'
import type { BrowserSessionId } from '../browser/types.ts'

export async function extensionReady(connect: () => Promise<void>, milliseconds = 2500): Promise<boolean> {
  const deadline = Date.now() + milliseconds
  let timer: ReturnType<typeof setTimeout> | undefined
  const attempt = async () => {
    do {
      try { await connect(); return true } catch {}
      await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(0, deadline - Date.now()))))
    } while (Date.now() < deadline)
    return false
  }
  try { return await Promise.race([attempt(), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), milliseconds) })]) }
  finally { clearTimeout(timer) }
}

export class PreferredBrowserViewHost implements ElectronBrowserViewHost {
  private readonly routes = new Map<BrowserSessionId, Promise<ElectronBrowserViewHost>>()
  private readonly decisions = new Map<BrowserSessionId, ElectronBrowserViewHost>()
  private readonly mapped = new Map<string, { handle: ElectronViewHandle; real?: Promise<{ host: ElectronBrowserViewHost; handle: ElectronViewHandle }>; dead: boolean }>()
  private released = false
  private selected?: 'extension' | 'cdp'
  fallbackReason?: string
  private readonly extension: ExtensionBrowserViewHost

  constructor(readonly browser: 'edge' | 'chrome', readonly fallback: ElectronBrowserViewHost & { connectionStatus?: () => { connected: boolean; detail: string } }, client?: NativeBrowserClient, private readonly bound = 2500) {
    this.extension = new ExtensionBrowserViewHost(browser, client)
  }

  activeCarrier(): 'extension' | 'cdp' { return this.selected ?? (this.extension.connectionStatus().connected ? 'extension' : 'cdp') }
  get disposed(): boolean { return this.released }
  connectionStatus() { return this.extension.connectionStatus() }
  async refreshStatus() { await this.extension.refreshStatus() }
  async prepare(scope?: BrowserSessionId) { if (scope) await (await this.route(scope)).prepare?.(scope) }
  referenceOverlayOwnerFor(scope: BrowserSessionId): 'client' | undefined {
    const host = this.decisions.get(scope)
    return host ? host.referenceOverlayOwner : 'client'
  }
  connectedView(id: string) {
    const view = this.mapped.get(id)
    return !!view && !view.dead && (this.decisions.get(sessionWireId(readTabHandle(id))) === this.fallback
      ? this.fallback.connectionStatus?.().connected === true : this.extension.connectedView(id))
  }

  private route(scope: BrowserSessionId): Promise<ElectronBrowserViewHost> {
    if (this.released) return Promise.reject(new Error('browser carrier was released'))
    let route = this.routes.get(scope)
    if (!route) {
      route = (async () => {
        const ready = await extensionReady(() => this.extension.prepare(), this.bound)
        if (this.released) throw new Error('browser carrier was released')
        this.selected = ready ? 'extension' : 'cdp'
        const state = this.extension.connectionStatus().state
        this.fallbackReason = ready ? undefined : state === 'disabled' ? 'disabled' : state === 'extension-missing' ? 'extension-not-installed' : 'not-connected'
        const host = ready ? this.extension : this.fallback
        this.decisions.set(scope, host)
        return host
      })()
      this.routes.set(scope, route)
    }
    return route
  }

  createView(id: BrowserTabWireId): ElectronViewHandle {
    if (this.mapped.has(id)) throw new Error('browser view already exists')
    const view: { handle: ElectronViewHandle; real?: Promise<{ host: ElectronBrowserViewHost; handle: ElectronViewHandle }>; dead: boolean } = {
      dead: false, handle: { id, supportsCdpJpeg: true, sendCommand: async (method, params) => {
        if (view.dead || this.released) throw new Error('browser view was released')
        view.real ??= this.route(sessionWireId(readTabHandle(id))).then(host => {
          if (view.dead || this.released) throw new Error('browser view was released')
          return { host, handle: host.createView(id) }
        })
        const real = await view.real
        return real.handle.sendCommand(method, params)
      } },
    }
    this.mapped.set(id, view)
    return view.handle
  }

  destroyView(handle: ElectronViewHandle) {
    const view = this.mapped.get(handle.id)
    if (!view) return
    view.dead = true; this.mapped.delete(handle.id)
    void view.real?.then(real => real.host.destroyView(real.handle)).catch(() => {})
  }
  async listPages(scope: BrowserSessionId, options: { requireRunning?: boolean } = {}) {
    if (options.requireRunning && !this.routes.has(scope)) return []
    return (await this.route(scope)).listPages?.(scope, options) ?? []
  }
  async adoptPage(id: BrowserTabWireId, scope = sessionWireId(readTabHandle(id))) {
    const host = await this.route(scope)
    if (!host.adoptPage) throw new Error('carrier does not support page adoption')
    const handle = await host.adoptPage(id, scope)
    this.mapped.set(id, { handle, real: Promise.resolve({ host, handle }), dead: false })
    return handle
  }
  async closePage(id: BrowserTabWireId, scope = sessionWireId(readTabHandle(id))) {
    const host = await this.route(scope)
    if (!host.closePage) throw new Error('carrier does not support explicit close')
    await host.closePage(id, scope)
    const view = this.mapped.get(id)
    if (view) this.destroyView(view.handle)
  }
  async retireSession(scope: BrowserSessionId) { this.routes.delete(scope); this.decisions.delete(scope) }
  dispose() {
    if (this.released) return
    this.released = true
    for (const view of [...this.mapped.values()]) this.destroyView(view.handle)
    this.extension.dispose(); this.fallback.dispose?.()
  }
}
