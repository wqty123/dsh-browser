/** Session-owned native child addresses; no URL replay or replacement guest. */
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { DesktopNativeChild, DesktopNativeChildTabs } from '../../types.ts'
import { readTabHandle } from '../../browser/handles.ts'

export class NativeChildPresentation {
  private readonly children = new Map<string, DesktopNativeChild>()

  constructor(readonly api: DesktopNativeChildTabs, private readonly owner: string,
    private readonly open: (tab: TabId) => boolean, private readonly close: (tab: TabId) => void) {}

  child(tab: TabId): DesktopNativeChild | undefined { return this.children.get(tab) }

  listen(parent: string): () => void {
    const owned = new Set<string>()
    let active = true
    let unsubscribeClosed: (() => void) | undefined
    const created = this.api.onCreated(parent, child => {
      if (!active || child.opener !== parent) return
      const address = readTabHandle(child.child), opener = readTabHandle(parent)
      if (address.owner !== this.owner || address.owner !== opener.owner || address.session !== opener.session
        || this.children.has(address.tab)) return
      this.children.set(address.tab, child)
      owned.add(child.child)
      if (!this.open(address.tab as TabId)) {
        this.children.delete(address.tab)
        owned.delete(child.child)
      }
    })
    unsubscribeClosed = this.api.onClosed(parent, child => {
      if (child.opener !== parent || !owned.has(child.child)) return
      const address = readTabHandle(child.child)
      if (this.children.get(address.tab)?.request !== child.request) return
      owned.delete(child.child)
      this.children.delete(address.tab)
      this.close(address.tab as TabId)
      if (!active && owned.size === 0) unsubscribeClosed?.()
    })
    return () => {
      active = false
      created()
      if (owned.size === 0) unsubscribeClosed?.()
    }
  }
}
