/** Drive the visible sidebar guest through canonical, bridge-bound handles. */
import { BridgeConnection, type BridgeEndpoint } from './bridge-connection.ts'
import { readFileSync } from 'node:fs'
import { bridgeEndpointPath } from './paths.ts'
import { randomUUID } from 'node:crypto'
import { readTabHandle, resolveSessionHandle, resolveTabHandle, sessionWireId, tabWireId, type BrowserSessionWireId, type BrowserTabWireId } from '../browser/handles.ts'
import type { CommandOptions, ElectronBrowserViewHost, ElectronViewHandle, BrowserUserAction } from './provider.ts'
import type { CarrierPage, CarrierLossReason } from '../browser/types.ts'
import { BridgeVersionError, isBridgeVersionMismatch } from './bridge-compatibility.ts'

export { bridgeEndpointPath }

const PANEL_NOT_DISPLAYED = 'panel-not-displayed'
const PANEL_INITIALIZING = 'panel-initializing'

export class BrowserPanelNotDisplayedError extends Error {
  readonly code: string
  constructor(detail: string, code = PANEL_NOT_DISPLAYED) {
    super(`dsh-builtin-browser: this conversation's sidebar page did not attach (${detail})`)
    this.name = 'BrowserPanelNotDisplayedError'
    this.code = code
  }
}

interface View {
  readonly scope: BrowserSessionWireId
  bound: boolean
  adopted?: boolean
}

export class DesktopBridgeViewHost implements ElectronBrowserViewHost {
  readonly referenceOverlayOwner = 'client' as const
  private readonly connection: BridgeConnection
  private readonly views = new Map<string, View>()
  private readonly orphaned = new Map<BrowserTabWireId, BrowserSessionWireId>()
  private activeScope: BrowserSessionWireId | undefined
  private readonly retiredSessions = new Set<BrowserSessionWireId>()
  private lostListener: ((reason: CarrierLossReason) => void) | undefined
  private static refuseIframe = false
  private static versionError: string | undefined

  private constructor(endpoint: BridgeEndpoint, private readonly isQuiet: () => boolean = () => false) {
    this.connection = new BridgeConnection(endpoint, bridgeEndpointPath(), () => this.lostListener?.('shell-exited'))
  }

  onLost(listener: (reason: CarrierLossReason) => void): void { this.lostListener = listener }
  available(): boolean { return true }
  static refusedIframePanel(): boolean { return this.refuseIframe }
  static compatibilityError(): string | undefined { return this.versionError }

  static async discover(_owner?: string, isQuiet?: () => boolean): Promise<DesktopBridgeViewHost | undefined> {
    this.refuseIframe = false
    this.versionError = undefined
    let endpoint: BridgeEndpoint
    try {
      const raw = JSON.parse(readFileSync(bridgeEndpointPath(), 'utf8')) as Partial<BridgeEndpoint>
      if (typeof raw.port !== 'number' || typeof raw.token !== 'string' || typeof raw.pid !== 'number') return undefined
      endpoint = { port: raw.port, token: raw.token, pid: raw.pid, ...raw.updatedAt === undefined ? {} : { updatedAt: raw.updatedAt } }
    } catch { return undefined }
    const probe = new BridgeConnection(endpoint, bridgeEndpointPath())
    try {
      const answer = await probe.call({ op: 'list' }, 5_000)
      if (isBridgeVersionMismatch(answer)) throw new BridgeVersionError()
      if (answer.ok !== true) return undefined
      if (answer.frame === 'iframe') { this.refuseIframe = true; return undefined }
      if (typeof answer.protocol !== 'number' || !Number.isInteger(answer.protocol)) throw new BridgeVersionError()
      return new DesktopBridgeViewHost(endpoint, isQuiet)
    } catch (error) {
      if (error instanceof BridgeVersionError) {
        this.versionError = error.message
        throw error
      }
      return undefined
    }
    finally { probe.close() }
  }

  async listPages(scope: BrowserSessionWireId, _options: { readonly requireRunning?: boolean } = {}): Promise<readonly CarrierPage[]> {
    resolveSessionHandle(scope)
    const answer = await this.connection.call({ op: 'list', handle: scope }, 5_000)
    if (answer.ok !== true) throw new Error(String(answer.error ?? 'sidebar page listing failed'))
    if (!Array.isArray(answer.sidebar)) throw new Error('invalid sidebar page listing')
    const pages: CarrierPage[] = []
    for (const page of answer.sidebar) {
      if (typeof page?.id !== 'string') throw new Error('invalid sidebar page handle')
      resolveTabHandle(resolveSessionHandle(scope), page.id)
      if (!this.views.has(page.id)) pages.push({ id: page.id, url: String(page.url ?? ''), title: String(page.title ?? '') })
    }
    return pages
  }

  async adoptPage(id: BrowserTabWireId, scope = sessionWireId(readTabHandle(id))): Promise<ElectronViewHandle> {
    const identity = tabWireId(resolveTabHandle(resolveSessionHandle(scope), id))
    const answer = await this.connection.call({ op: 'adoptPage', handle: identity })
    if (answer.ok !== true || answer.id !== id) throw new Error(String(answer.error ?? 'sidebar page adoption failed'))
    const handle = this.createView(identity)
    const entry = this.views.get(handle.id)!
    entry.bound = true
    entry.adopted = true
    return handle
  }

  async closePage(id: BrowserTabWireId, scope = sessionWireId(readTabHandle(id))): Promise<void> {
    const identity = tabWireId(resolveTabHandle(resolveSessionHandle(scope), id))
    const blank = this.views.get(id)?.bound === false
    const answer = await this.connection.call({ op: blank ? 'releaseTab' : 'closePage', handle: identity }, 10_000)
    if (answer.ok !== true || (!blank && answer.closed !== 1)) throw new Error(`dsh-builtin-browser: could not close sidebar page: ${String(answer.error ?? 'close not acknowledged')}`)
    this.views.delete(id)
    this.orphaned.delete(id)
  }

  private async guestFor(id: BrowserTabWireId, url?: string, options?: CommandOptions, checkNavigation?: () => void): Promise<Record<string, unknown> | undefined> {
    const entry = this.views.get(id)
    if (entry === undefined) throw new Error('dsh-builtin-browser: sidebar view was released')
    const check = (): void => {
      options?.signal?.throwIfAborted()
      checkNavigation?.()
      if (this.views.get(id) !== entry) throw new Error('dsh-builtin-browser: sidebar view was released')
    }
    check()
    if (entry.bound) return undefined
    if (options?.initialize === false || options?.present === false) {
      throw new BrowserPanelNotDisplayedError('this view has no attached guest yet', PANEL_INITIALIZING)
    }
    if (entry.adopted) throw new Error('dsh-builtin-browser: the sidebar page this view was adopted from is gone')
    const deadline = options?.deadline ?? Date.now() + 30_000
    const transactionId = randomUUID()
    const cancel = (): void => { void this.connection.call({ op: 'cancelSidebar', handle: id, transactionId }, 2_000).catch(() => {}) }
    options?.signal?.addEventListener('abort', cancel, { once: true })
    let answer: Record<string, unknown>
    try {
      answer = await this.connection.call({ op: 'ensureSidebar', handle: id, deadline, transactionId,
        ...url ? { url, attachOnly: true } : {} }, Math.max(1, deadline - Date.now()))
    } finally { options?.signal?.removeEventListener('abort', cancel) }
    check()
    if (answer.ok !== true) {
      const code = String(answer.code ?? 'panel-initialization-failed')
      const detail = String(answer.error ?? 'sidebar unavailable')
      if (code === PANEL_NOT_DISPLAYED || code === PANEL_INITIALIZING) throw new BrowserPanelNotDisplayedError(detail, code)
      if (code === 'panel-unusable') this.lostListener?.('panel-unusable')
      throw Object.assign(new Error(`dsh-builtin-browser: sidebar unavailable (${detail})`), { code, initialization: answer.initialization })
    }
    if (answer.id !== id) throw new Error('dsh-builtin-browser: sidebar returned a different tab handle')
    entry.bound = true
    return answer.navigation && typeof answer.navigation === 'object' ? answer.navigation as Record<string, unknown> : undefined
  }

  createView(identity: BrowserTabWireId): ElectronViewHandle {
    const scope = sessionWireId(readTabHandle(identity))
    if (this.retiredSessions.has(scope)) throw new Error('dsh-builtin-browser: sidebar session was released')
    const id = identity
    this.activeScope = scope
    if (this.views.has(id)) throw new Error('dsh-builtin-browser: sidebar view is already bound')
    this.views.set(id, { scope, bound: false })
    let latestNavigation = 0
    return {
      id,
      download: async (url, savePath) => {
        await this.guestFor(id)
        const answer = await this.connection.call({ op: 'download', handle: id, url, savePath }, 60_000)
        if (answer.ok !== true) throw new Error(`dsh-builtin-browser: sidebar download failed: ${String(answer.error)}`)
      },
      sendCommand: async (method, params, options) => {
        const url = method === 'Page.navigate' ? String(params?.url ?? '') : undefined
        const sequence = url === undefined ? latestNavigation : ++latestNavigation
        const check = (): void => {
          if (sequence !== latestNavigation) throw Object.assign(new Error('a newer navigation was requested for this sidebar view'), { code: 'panel-navigation-superseded' })
        }
        const navigation = await this.guestFor(id, url, options, check)
        check()
        if (navigation !== undefined) return navigation
        const answer = await this.connection.call({ op: 'cdp', handle: id, method, params })
        if (answer.ok !== true) throw Object.assign(new Error(`dsh-builtin-browser: sidebar command failed: ${String(answer.error)}`), { code: answer.code })
        return (answer.result ?? {}) as Record<string, unknown>
      },
    }
  }

  destroyView(handle: ElectronViewHandle): void {
    const entry = this.views.get(handle.id)
    if (entry?.bound && !entry.adopted) this.orphaned.set(tabWireId(readTabHandle(handle.id)), entry.scope)
    this.views.delete(handle.id)
  }

  showView(handle: ElectronViewHandle, _label?: string, options?: { readonly quiet?: boolean; readonly select?: boolean }): void {
    if ((options?.quiet ?? this.isQuiet()) && options?.select !== true) return
    if (!this.views.get(handle.id)?.bound) return
    void this.connection.call({ op: 'showTab', handle: tabWireId(readTabHandle(handle.id)) }, 5_000).catch(() => {})
  }

  onUserAction(_handler: (action: BrowserUserAction) => void): void {}

  async presentView(handle: ElectronViewHandle, _label?: string, options?: { readonly quiet?: boolean; readonly select?: boolean }): Promise<void> {
    if ((options?.quiet ?? this.isQuiet()) && options?.select !== true) return
    const id = tabWireId(readTabHandle(handle.id))
    await this.guestFor(id)
    const answer = await this.connection.call({ op: 'showTab', handle: id })
    if (answer.ok !== true) throw Object.assign(new Error(String(answer.error ?? 'sidebar selection failed')), { code: answer.code })
  }

  async retireSession(scope: BrowserSessionWireId): Promise<void> {
    resolveSessionHandle(scope)
    if (this.retiredSessions.has(scope)) return
    this.retiredSessions.add(scope)
    const answer = await this.connection.call({ op: 'releaseSession', handle: scope })
    if (answer.ok !== true) throw new Error(String(answer.error ?? 'sidebar release failed'))
    for (const [id, held] of this.orphaned) if (held === scope) this.orphaned.delete(id)
  }

  async releasePage(scope?: BrowserSessionWireId): Promise<void> {
    if (scope !== undefined) resolveSessionHandle(scope)
    const mine = new Set<BrowserTabWireId>()
    const scopes = new Set<BrowserSessionWireId>()
    for (const [id, entry] of this.views) {
      if (scope !== undefined && entry.scope !== scope) continue
      scopes.add(entry.scope)
      if (entry.bound && !entry.adopted) mine.add(tabWireId(readTabHandle(id)))
      this.views.delete(id)
    }
    for (const [id, held] of this.orphaned) {
      if (scope !== undefined && held !== scope) continue
      scopes.add(sessionWireId(readTabHandle(id)))
      mine.add(tabWireId(readTabHandle(id)))
      this.orphaned.delete(id)
    }
    if (scope !== undefined) scopes.add(scope)
    try {
      const results = await Promise.allSettled([...mine].map(async id => {
        const answer = await this.connection.call({ op: 'closePage', handle: id }, 10_000)
        if (answer.ok !== true || answer.closed !== 1) throw new Error(String(answer.error ?? 'sidebar close not acknowledged'))
      }))
      const failure = results.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
    } finally {
      await Promise.all([...scopes].map(handle => this.retireSession(handle)))
    }
  }

  async collapse(): Promise<void> {
    if (this.activeScope === undefined) return
    await this.connection.call({ op: 'collapseSidebar', handle: this.activeScope }, 10_000).catch(() => {})
  }

  dispose(): void {
    this.connection.close()
    this.views.clear()
    this.orphaned.clear()
    this.activeScope = undefined
  }
}
