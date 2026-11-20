import { findTextQuote } from '../../browser-reference/text-quote.ts'
import { referenceOwnerKey } from '../../reference-owner.ts'
import type { FrozenSnapshot } from '../reference/client/production/protocol.ts'
import type { RevealStatus } from '../reference/client/types.ts'

export interface ReferenceSourcePage {
  readonly pageId: string
  readonly reveal?: (snapshot: FrozenSnapshot, partId: string | undefined, signal: AbortSignal) => Promise<RevealStatus>
}

export type GuestReferenceCommand = (operation: 'text' | 'highlight' | 'element', spec: object, signal: AbortSignal) => Promise<Record<string, unknown>>

const sources = new Map<string, { readonly owner: string; readonly reveal: NonNullable<ReferenceSourcePage['reveal']> }>()

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
