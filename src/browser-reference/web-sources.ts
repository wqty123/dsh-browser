import { randomUUID } from 'node:crypto'
import { symbols } from '@deepseek-ai/cordis'
import { referenceOwnerKey } from '../reference-owner.ts'
import { sameReferenceDocument } from '../reference-page.ts'
import type { BrowserReference } from './types.ts'
import type { WebRevealStatus } from '../reference-source.ts'

export class WebSourceLeaseExpired extends Error {}

function validateUrl(url: string): void {
  const parsed = new URL(url)
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('invalid web source URL')
}

interface Command { readonly id: string; readonly reference: BrowserReference; readonly partId?: string }
interface Pending { readonly command: Command; readonly finish: (status: WebRevealStatus) => void }
interface Source {
  readonly owner: string
  readonly pageId: string
  seen: number
  url: string
  readonly pending: Map<string, Pending>
}

/** App-owned iframe leases; no guest can register or acknowledge a command. */
export class WebReferenceSources {
  private readonly leases = new Map<string, Source>()
  private readonly timeoutMs: number
  constructor(timeoutMs = 8_000) {
    this.timeoutMs = timeoutMs
  }

  private prune(): void {
    for (const [lease, source] of this.leases) {
      if (Date.now() - source.seen > 15_000) this.remove(lease)
    }
  }

  register(owner: string, pageId: string, url: string): string {
    this.prune()
    owner = referenceOwnerKey(owner)
    if (!owner || !/^iframe:[\w-]{1,100}$/u.test(pageId)) throw new Error('invalid web source')
    validateUrl(url)
    if (this.leases.size >= 1024 || [...this.leases.values()].some(source => source.pageId === pageId)) throw new Error('web source already registered or capacity exceeded')
    const lease = randomUUID()
    this.leases.set(lease, { owner, pageId, url, seen: Date.now(), pending: new Map() })
    return lease
  }

  owns(owner: string, pageId: string, url?: string): boolean {
    this.prune()
    return [...this.leases.values()].some(source => source.owner === referenceOwnerKey(owner) && source.pageId === pageId && (url === undefined || sameReferenceDocument(source.url, url)))
  }

  poll(lease: string, url: string, acknowledgements: readonly { id: string; status: WebRevealStatus }[]): readonly Command[] {
    this.prune()
    const source = this.leases.get(lease)
    if (source === undefined) throw new WebSourceLeaseExpired('web source lease expired')
    validateUrl(url)
    source.seen = Date.now()
    source.url = url
    for (const ack of acknowledgements) {
      const pending = source.pending.get(ack.id)
      pending?.finish(sameReferenceDocument(url, pending.command.reference.source.pageUrl) ? ack.status : 'page-mismatch')
    }
    return [...source.pending.values()].map(pending => pending.command)
  }

  remove(lease: string): void {
    const source = this.leases.get(lease)
    this.leases.delete(lease)
    for (const pending of source?.pending.values() ?? []) pending.finish('unavailable')
  }

  async reveal(reference: BrowserReference, pageId: string, partId?: string, signal?: AbortSignal): Promise<WebRevealStatus> {
    this.prune()
    signal?.throwIfAborted()
    const source = [...this.leases.values()].find(source => source.owner === referenceOwnerKey(reference.owner.sessionId ?? '') && source.pageId === pageId)
    if (source === undefined || source.pending.size >= 64) return 'unavailable'
    if (!sameReferenceDocument(source.url, reference.source.pageUrl)) return 'page-mismatch'
    return new Promise(resolve => {
      const id = randomUUID()
      const finish = (status: WebRevealStatus): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', abort)
        source.pending.delete(id)
        resolve(status)
      }
      const abort = (): void => { finish('unavailable') }
      const timer = setTimeout(abort, this.timeoutMs)
      timer.unref?.()
      source.pending.set(id, { command: { id, reference, ...partId === undefined ? {} : { partId } }, finish })
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
  }
}

const sources = new WeakMap<object, WebReferenceSources>()
export function webReferenceSources(browser: object): WebReferenceSources {
  const original: unknown = Reflect.get(browser, symbols.original)
  const identity = typeof original === 'object' && original !== null ? original : browser
  let channel = sources.get(identity)
  if (channel === undefined) { channel = new WebReferenceSources(); sources.set(identity, channel) }
  return channel
}
