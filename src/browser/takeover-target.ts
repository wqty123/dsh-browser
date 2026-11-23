import type { BrowserSessionId } from './types.ts'
import { Service, symbols } from '@deepseek-ai/cordis'
import { referenceOwnerKey } from '../reference-owner.ts'

export interface CarrierTakeoverTarget {
  readonly session: BrowserSessionId
  readonly owner: string
  readonly tabId: string
  readonly pageId: string
  readonly url: string
  readonly connected: () => boolean
}

const sources = new WeakMap<object, { readonly list: (owner: string) => readonly CarrierTakeoverTarget[]; readonly exclusive: boolean }>()

function browserIdentity(browser: object): object {
  return Service.prototype.isPrototypeOf(browser) ? (browser as Record<symbol, object | undefined>)[symbols.original] ?? browser : browser
}

export function hasCarrierTakeover(browser: object | undefined): boolean {
  return browser !== undefined && sources.get(browserIdentity(browser))?.exclusive === true
}

/** `exclusive: false` lets a carrier with no tab for the owner fall back to the sidebar. */
export function registerCarrierTakeover(browser: object, list: (owner: string) => readonly CarrierTakeoverTarget[], { exclusive = true } = {}): () => void {
  const key = browserIdentity(browser), source = { list, exclusive }
  sources.set(key, source)
  return () => { if (sources.get(key) === source) sources.delete(key) }
}

export function carrierTakeoverTarget(browser: object | undefined, owner: string, pageId?: string): CarrierTakeoverTarget | undefined {
  if (!browser) return undefined
  const candidates = sources.get(browserIdentity(browser))?.list(referenceOwnerKey(owner)).filter(target => referenceOwnerKey(target.owner) === referenceOwnerKey(owner)
    && target.connected() && (pageId === undefined || target.pageId === pageId)) ?? []
  if (candidates.length > 1) throw new Error('Select one browser session in this conversation before requesting takeover.')
  return candidates[0]
}
