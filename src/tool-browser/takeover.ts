import { randomUUID } from 'node:crypto'
import { carrierTakeoverTarget, hasCarrierTakeover } from '../browser/takeover-target.ts'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { pairedRoute, type BrowserHttpHandler, type BrowserPairingConnection } from '../browser-electron/authenticated-route.ts'
import { readJsonBody } from '../browser-electron/http-body.ts'
import { replyJson } from '../browser-electron/json-reply.ts'
import { sameOrigin } from '../browser-electron/settings-route.ts'
import { referenceOwnerKey } from '../reference-owner.ts'
import { TAKEOVER_ROUTE, TAKEOVER_TOOL, type TakeoverDecision, type TakeoverNotice, type TakeoverSummary } from '../takeover-protocol.ts'

interface Page {
  readonly connected?: () => boolean
  readonly owner: string
  readonly tabId: string
  readonly pageId: string
  readonly lease: string
  url: string
  active: boolean
  seen: number
  navigationUrl?: string
}

interface Pending {
  readonly id: string
  readonly page: Page
  readonly reason: string
  readonly instructions?: string
  readonly controller: AbortController
  readonly signal?: AbortSignal
  readonly button: Promise<TakeoverDecision>
  readonly answer: (decision: TakeoverDecision) => void
  readonly summary: Promise<TakeoverSummary>
  readonly report: (summary: TakeoverSummary) => void
  phase: 'waiting' | 'summary'
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error('invalid takeover field')
  return value
}

function summary(value: unknown): TakeoverSummary {
  const data = value as Partial<TakeoverSummary> | undefined
  if (!data || typeof data.title !== 'string' || data.title.length > 1000 || typeof data.snapshotHint !== 'string'
    || data.snapshotHint.length > 2000 || typeof data.fresh !== 'boolean') throw new Error('invalid takeover summary')
  const url = new URL(text(data.url, 8192))
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid takeover URL')
  return { url: url.href, title: data.title, snapshotHint: data.snapshotHint, fresh: data.fresh }
}

export class BrowserTakeovers {
  private browser?: object
  attachBrowser(browser: object | undefined): void { this.browser = browser }
  private readonly pages = new Map<string, Page>()
  private readonly pending = new Map<string, Pending>()
  private readonly results = new Map<string, Promise<unknown>>()
  private readonly changed = new Set<() => void>()
  private disposed = false

  private key(page: Pick<Page, 'owner' | 'tabId'>): string { return JSON.stringify([page.owner, page.tabId]) }

  target(owner: string): Page {
    const candidates = [...this.pages.values()].filter(page => page.owner === referenceOwnerKey(owner) && page.active && Date.now() - page.seen < 3000)
    if (candidates.length !== 1) throw new Error('Browser takeover requires one active, connected sidebar tab. Select the browser tab and retry.')
    return candidates[0]!
  }

  async adopt(owner: string, signal: AbortSignal, navigationUrl?: string, timeoutMs = 15000): Promise<Page> {
    signal.throwIfAborted()
    const carrier = carrierTakeoverTarget(this.browser, owner)
    if (carrier) return { ...carrier, owner: referenceOwnerKey(owner), lease: randomUUID(), active: true, seen: Date.now() }
    if (hasCarrierTakeover(this.browser)) throw new Error('The selected personal browser has no connected tab in this conversation. Reconnect the extension or open a tab; no sidebar fallback.')
    return new Promise<Page>((resolve, reject) => {
      const finish = (page?: Page, error?: unknown): void => {
        clearTimeout(timer)
        signal.removeEventListener('abort', abort)
        this.changed.delete(check)
        if (error !== undefined) reject(error); else resolve(page!)
      }
      const abort = (): void => { finish(undefined, signal.reason) }
      const check = (): void => {
        if (this.disposed) { finish(undefined, new Error('Browser takeover service was disposed.')); return }
        const candidates = [...this.pages.values()].filter(page => page.owner === referenceOwnerKey(owner) && page.active && Date.now() - page.seen < 3000)
        if (candidates.length > 1) finish(undefined, new Error('Browser takeover requires one selected, visible sidebar tab. Close or hide the other browser panes and retry.'))
        else if (candidates[0] && (navigationUrl === undefined || candidates[0].url === navigationUrl || candidates[0].navigationUrl === navigationUrl)) finish(candidates[0])
      }
      const timer = setTimeout(() => finish(undefined, new Error('Browser takeover requires one active, connected sidebar tab in this conversation. Select the browser tab, wait for it to load, and retry.')), timeoutMs)
      this.changed.add(check)
      signal.addEventListener('abort', abort, { once: true })
      check()
    })
  }

  blocks(owner: string, tabId?: string): boolean {
    return [...this.pending.values()].some(pending => pending.page.owner === referenceOwnerKey(owner)
      && !pending.signal?.aborted && (tabId === undefined || pending.page.pageId === tabId.replace(/^page:/u, '') || pending.page.tabId === tabId))
  }

  run<T>(page: Page, reason: string, instructions: string | undefined, signal: AbortSignal | undefined,
    operation: (pending: Pending) => Promise<T>): Promise<T> {
    const key = this.key(page)
    const existing = this.results.get(key)
    if (existing) return existing as Promise<T>
    const controller = new AbortController()
    const abort = (): void => { controller.abort(signal?.reason) }
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) abort()
    let answer!: Pending['answer'], report!: Pending['report']
    const pending: Pending = { id: randomUUID(), page, reason, ...instructions === undefined ? {} : { instructions }, controller, ...signal === undefined ? {} : { signal },
      button: new Promise(resolve => { answer = resolve }), answer: decision => { answer(decision) },
      summary: new Promise(resolve => { report = resolve }), report: value => { report(value) }, phase: 'waiting' }
    this.pending.set(key, pending)
    const expiry = setInterval(() => { if (page.connected ? !page.connected() : Date.now() - page.seen > 15000) controller.abort() }, 1000)
    expiry.unref()
    const result = Promise.resolve().then(() => operation(pending)).finally(() => {
      clearInterval(expiry)
      controller.abort()
      signal?.removeEventListener('abort', abort)
      this.pending.delete(key)
      this.results.delete(key)
    })
    this.results.set(key, result)
    return result
  }

  async listen(request: { readonly toolName: string; readonly signal?: AbortSignal }, next: () => Promise<TakeoverDecision>): Promise<TakeoverDecision> {
    const pending = request.toolName === TAKEOVER_TOOL && [...this.pending.values()].find(item => item.controller.signal === request.signal)
    return pending ? Promise.race([pending.button, next()]) : next()
  }

  dispose(): void {
    this.disposed = true
    for (const pending of this.pending.values()) pending.controller.abort()
    this.pages.clear()
    for (const changed of this.changed) changed()
  }

  exchange(data: Record<string, unknown>): object {
    for (const [lease, page] of this.pages) if (Date.now() - page.seen > 15000) {
      this.pages.delete(lease)
      this.pending.get(this.key(page))?.controller.abort()
    }
    if (data.operation === 'register') {
      if (this.pages.size >= 1024) throw new Error('browser takeover page capacity exceeded')
      const owner = referenceOwnerKey(text(data.owner, 300)), tabId = text(data.tabId, 300), pageId = text(data.pageId, 300)
      const url = new URL(text(data.url, 8192))
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid takeover URL')
      const lease = randomUUID()
      for (const [old, page] of this.pages) if (page.owner === owner && page.pageId === pageId) this.pages.delete(old)
      const navigationUrl = data.navigationUrl === undefined ? undefined : new URL(text(data.navigationUrl, 8192)).href
      if (navigationUrl !== undefined && !/^https?:\/\//u.test(navigationUrl)) throw new Error('invalid takeover navigation URL')
      this.pages.set(lease, { lease, owner, tabId, pageId, url: url.href, active: data.active === true, seen: Date.now(), ...navigationUrl === undefined ? {} : { navigationUrl } })
      for (const changed of this.changed) changed()
      return { lease }
    }
    const page = this.pages.get(text(data.lease, 100))
    if (!page) throw new Error('browser takeover page lease expired')
    if (data.operation === 'remove') { this.pages.delete(page.lease); this.pending.get(this.key(page))?.controller.abort(); return {} }
    const pending = this.pending.get(this.key(page))
    if (data.operation === 'poll') {
      const url = new URL(text(data.url, 8192))
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('invalid takeover URL')
      page.url = url.href; page.active = data.active === true; page.seen = Date.now()
      const navigationUrl = data.navigationUrl === undefined ? undefined : new URL(text(data.navigationUrl, 8192)).href
      if (navigationUrl !== undefined && !/^https?:\/\//u.test(navigationUrl)) throw new Error('invalid takeover navigation URL')
      page.navigationUrl = navigationUrl
      for (const changed of this.changed) changed()
      const notice: TakeoverNotice | undefined = pending && !pending.signal?.aborted && (pending.phase === 'summary' || !pending.controller.signal.aborted)
        ? { id: pending.id, reason: pending.reason, ...pending.instructions === undefined ? {} : { instructions: pending.instructions }, phase: pending.phase } : undefined
      return { notice }
    }
    if (!pending || pending.id !== data.id || pending.signal?.aborted || (pending.phase === 'waiting' && pending.controller.signal.aborted)) throw new Error('browser takeover request is no longer pending')
    if (data.operation === 'answer' && pending.phase === 'waiting' && (data.outcome === 'done' || data.outcome === 'skipped')) {
      pending.answer(data.outcome === 'done' ? 'allowed-once' : 'rejected')
    } else if (data.operation === 'summary' && pending.phase === 'summary') pending.report(summary(data.summary))
    else throw new Error('invalid browser takeover operation')
    return {}
  }

  handler = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    if (request.method !== 'POST') { replyJson(response, 405, { error: 'method-not-allowed' }); return }
    if (!sameOrigin(request, true)) { replyJson(response, 403, { error: 'not-same-origin' }); return }
    try { replyJson(response, 200, this.exchange(await readJsonBody<Record<string, unknown>>(request, 16384))) }
    catch (error) { replyJson(response, 400, { error: String(error) }) }
  }
}

export function installTakeovers(ctx: Context, takeovers: BrowserTakeovers): void {
  takeovers.attachBrowser(ctx.get('browser'))
  ctx.on?.('approval/request' as never, ((request: { toolName: string; signal?: AbortSignal }, next: () => Promise<TakeoverDecision>) => takeovers.listen(request, next)) as never, { prepend: true })
  ctx.effect(() => () => { takeovers.dispose() })
  ctx.inject?.(['webServer'] as never, (host: Context) => {
    const server = host.get('webServer' as never) as unknown as { register(spec: { kind: 'exact'; path: string; handler: BrowserHttpHandler }): () => void }
    host.effect(() => server.register({ kind: 'exact', path: TAKEOVER_ROUTE, handler: pairedRoute(
      () => ctx.get('connection' as never) as unknown as BrowserPairingConnection | undefined, takeovers.handler) }))
  })
}
