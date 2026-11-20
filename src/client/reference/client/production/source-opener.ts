import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { BrowserInitializationReader, BrowserInitReceipt } from '../../../browser/initialization.ts'
import { sameReferenceDocument } from '../../../../reference-page.ts'
import { iframeReferenceSource, type ReferenceSourcePage } from '../../../browser/iframe-reference.ts'

export interface SourceSidebar {
  openTabIn(sessionId: string, kind: string, options: { readonly params: { readonly url: string } }): unknown
  tabsIn(sessionId: string): readonly { readonly id: string; readonly kind: string }[]
}

export async function openReferenceSource(sidebar: SourceSidebar, reader: BrowserInitializationReader,
  owner: string, url: string, signal: AbortSignal): Promise<ReferenceSourcePage> {
  if (!owner || typeof sidebar?.openTabIn !== 'function' || typeof sidebar.tabsIn !== 'function'
    || typeof reader?.wait !== 'function') throw new Error('acknowledged sidebar initialization unavailable')
  signal.throwIfAborted()
  const sessionId = owner
  const sourcePage = (pageId: string): ReferenceSourcePage => {
    const iframe = iframeReferenceSource(pageId, owner)
    if (iframe !== undefined) return iframe
    if (pageId.startsWith('iframe:')) throw new Error('source iframe is no longer owned by this conversation')
    return { pageId }
  }
  const previous = new Map(sidebar.tabsIn(sessionId).map(tab => [tab.id,
    reader.read({ sessionId, tabId: tab.id as TabId, url })?.requestId]))
  const existing = sidebar.tabsIn(sessionId).filter(tab => tab.kind === 'browser')
  for (const tab of existing) {
    const page = reader.current({ sessionId, tabId: tab.id as TabId })
    if (page !== undefined && sameReferenceDocument(page.url, url)) {
      if (!page.guestId) throw new Error('source highlighting requires a controllable sidebar guest')
      return sourcePage(page.guestId)
    }
  }
  let tabId: TabId
  let afterRequestId: string | undefined
  if (existing.length === 1) {
    tabId = existing[0]!.id as TabId
    afterRequestId = previous.get(tabId)
    if (reader.navigate?.({ sessionId, tabId, url }) !== true) throw new Error('acknowledged sidebar navigation unavailable')
  } else {
    await sidebar.openTabIn(sessionId, 'browser', { params: { url } })
    const created = sidebar.tabsIn(sessionId).filter(tab => tab.kind === 'browser' && !previous.has(tab.id))
    if (created.length !== 1) throw new Error('sidebar did not identify one source tab')
    tabId = created[0]!.id as TabId
  }
  signal.throwIfAborted()
  const waiting = new AbortController()
  const abort = (): void => { waiting.abort(signal.reason) }
  signal.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(() => { waiting.abort(new Error('GUEST_SOURCE_TIMEOUT: source page did not become ready')) }, 15000)
  let receipt: BrowserInitReceipt
  try { receipt = await reader.wait({ sessionId, tabId, url, afterRequestId }, waiting.signal) }
  finally { clearTimeout(timer); signal.removeEventListener('abort', abort) }
  if (!receipt.guestId) throw new Error('source highlighting requires a controllable sidebar guest')
  return sourcePage(receipt.guestId)
}
