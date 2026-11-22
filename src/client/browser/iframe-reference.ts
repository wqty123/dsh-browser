import { findTextQuote } from '../../browser-reference/text-quote.ts'
import { referenceOwnerKey } from '../../reference-owner.ts'
import type { FrozenSnapshot } from '../reference/client/production/protocol.ts'
import type { RevealStatus } from '../reference/client/types.ts'

export interface ReferenceSourcePage {
  readonly pageId: string
  readonly reveal?: (snapshot: FrozenSnapshot, partId: string | undefined, signal: AbortSignal) => Promise<RevealStatus>
}

export type GuestReferenceCommand = (operation: 'text' | 'highlight' | 'element' | 'summary', spec: object, signal: AbortSignal) => Promise<Record<string, unknown>>

const sources = new Map<string, { readonly owner: string; readonly reveal: NonNullable<ReferenceSourcePage['reveal']> }>()
const pages = new Map<string, { readonly pageId: string; readonly url: string; readonly navigationUrl?: string }>()
const pageListeners = new Set<() => void>()

export function subscribeIframePages(listener: () => void): () => void {
  pageListeners.add(listener)
  return () => { pageListeners.delete(listener) }
}

export function iframePage(owner: string, viewportId: string): { readonly pageId: string; readonly url: string; readonly navigationUrl?: string } | undefined {
  return pages.get(JSON.stringify([referenceOwnerKey(owner), viewportId]))
}

export function registerIframePage(owner: string, viewportId: string, pageId: string, url: string, navigationUrl?: string): () => void {
  const key = JSON.stringify([referenceOwnerKey(owner), viewportId]), page = { pageId, url, ...navigationUrl === undefined ? {} : { navigationUrl } }
  pages.set(key, page)
  for (const listener of pageListeners) listener()
  return () => {
    if (pages.get(key) !== page) return
    pages.delete(key)
    for (const listener of pageListeners) listener()
  }
}

export function registerIframeReference(pageId: string, owner: string, commands: (url: string) => GuestReferenceCommand): () => void {
  const key = referenceOwnerKey(owner)
  sources.set(pageId, { owner: key, reveal: async (snapshot, partId, signal) => {
    signal.throwIfAborted()
    if (referenceOwnerKey(snapshot.owner.sessionId ?? '') !== key) return 'session-mismatch'
    if (snapshot.source.frameRoute === 'frame') return 'unavailable'
    const command = commands(snapshot.source.pageUrl)
    const part = partId === undefined ? snapshot.parts[0] : snapshot.parts.find(part => part.partId === partId)
    if (part === undefined) return 'not-found'
    if (part.type === 'text') {
      const spec = { legacy: part.content === undefined, maxChars: 2_000_000 }
      const text = await command('text', spec, signal)
      if (text.ok !== true || typeof text.text !== 'string') return 'missing'
      const found = findTextQuote(text.text, part.anchor)
      if (found.range === undefined) return found.status === 'ambiguous' ? 'ambiguous' : 'missing'
      const result = await command('highlight', { ...spec, ...found.range }, signal)
      return result.ok === true ? 'revealed' : 'missing'
    }
    const result = await command('element', { kind: part.type, anchor: part.anchor,
      ...part.type === 'table' ? { cells: part.table.cells.filter(cell => cell.includedAs === 'selection').map(cell => ({ row: cell.row, column: cell.column })) } : {},
    }, signal)
    return result.ok === true && result.status === 'found' ? 'revealed' : result.status === 'ambiguous' ? 'ambiguous' : 'missing'
  } })
  return () => { sources.delete(pageId) }
}

export function iframeReferenceSource(pageId: string, owner: string): ReferenceSourcePage | undefined {
  const source = sources.get(pageId)
  if (source === undefined || source.owner !== referenceOwnerKey(owner)) return undefined
  return { pageId, reveal: source.reveal }
}
