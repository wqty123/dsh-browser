import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { BrowserInitializationReader } from '../../../browser/initialization.ts'
import { sameReferenceDocument } from '../../../../reference-page.ts'

export interface SourceSidebar {
  openTabIn(sessionId: string, kind: string, options: { readonly params: { readonly url: string } }): unknown
  tabsIn(sessionId: string): readonly { readonly id: string; readonly kind: string }[]
  navigateTabIn?(sessionId: string, tabId: string, options: { readonly params: { readonly url: string } }): boolean
}

export async function openReferenceSource(sidebar: SourceSidebar, reader: BrowserInitializationReader,
  owner: string, url: string, signal: AbortSignal): Promise<{ readonly pageId: string }> {
  if (!owner || typeof sidebar?.openTabIn !== 'function' || typeof sidebar.tabsIn !== 'function'
    || typeof reader?.wait !== 'function') throw new Error('acknowledged sidebar initialization unavailable')
  signal.throwIfAborted()
  const sessionId = owner.startsWith('session-') ? owner : `session-${owner}`
  const previous = new Map(sidebar.tabsIn(sessionId).map(tab => [tab.id,
    reader.read({ sessionId, tabId: tab.id as TabId, url })?.requestId]))
  const existing = sidebar.tabsIn(sessionId).filter(tab => tab.kind === 'browser')
  for (const tab of existing) {
    const page = reader.current({ sessionId, tabId: tab.id as TabId })
    if (page !== undefined && sameReferenceDocument(page.url, url)) {
      if (!page.guestId) throw new Error('source highlighting requires a controllable sidebar guest')
      return { pageId: page.guestId }
    }
  }
  let tabId: TabId
  let afterRequestId: string | undefined
  if (existing.length === 1) {
    tabId = existing[0]!.id as TabId
    afterRequestId = previous.get(tabId)
    if (sidebar.navigateTabIn?.(sessionId, tabId, { params: { url } }) !== true) throw new Error('acknowledged sidebar navigation unavailable')
  } else {
    await sidebar.openTabIn(sessionId, 'browser', { params: { url } })
    const created = sidebar.tabsIn(sessionId).filter(tab => tab.kind === 'browser' && !previous.has(tab.id))
    if (created.length !== 1) throw new Error('sidebar did not identify one source tab')
    tabId = created[0]!.id as TabId
  }
  signal.throwIfAborted()
  const receipt = await reader.wait({ sessionId, tabId, url, afterRequestId }, signal)
  if (!receipt.guestId) throw new Error('source highlighting requires a controllable sidebar guest')
  return { pageId: receipt.guestId }
}
