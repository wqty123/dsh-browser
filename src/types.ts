/** Type-only Electron bridge declarations shared by the desktop shell and browser provider. */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** Main-issued identity of one guest reservation. */
export type DesktopBrowserLeaseId = Branded<'DesktopBrowserLeaseId'>

/** A guest's approved, process-local storage partition. */
export interface DesktopBrowserReservation {
  readonly lease: DesktopBrowserLeaseId
  readonly partition: string
}

/** Main-approved request to open an HTTP(S) page from an existing guest. */
export interface DesktopBrowserOpenRequest {
  readonly lease: DesktopBrowserLeaseId
  readonly url: string
}

export interface BrowserChildTabRequest {
  readonly mode: 'url-only' | 'native-opener'
  readonly url: string
}

export type BrowserChildTabResult =
  | { readonly status: 'url-only-dispatched' }
  | { readonly status: 'unsupported'; readonly code: 'native-child-opener-unavailable' | 'invalid-child-url' | 'guest-disposed' | 'sidebar-tab-dispatch-failed' }

export interface DesktopBrowserChildTabs {
  readonly protocolVersion: 1
  /** Native opener requests must wait for the decision; denial must never create a window. */
  onRequested(lease: DesktopBrowserLeaseId, listener: (request: BrowserChildTabRequest) => BrowserChildTabResult): () => void
}

/** Origin-scoped operations; no Electron objects or arbitrary IPC cross this interface. */
export interface DesktopBrowserBridge {
  /** Version 1 supports URL-only sidebar tabs, not native children or WindowProxy adoption. */
  readonly childTabs?: DesktopBrowserChildTabs
  /** @param workspace - resolved storage account. @returns one approved guest reservation. */
  acquire(workspace: string): Promise<DesktopBrowserReservation>
  /** @param lease - the caller's reservation. @returns after its guest has been destroyed. */
  release(lease: DesktopBrowserLeaseId): Promise<void>
  /** Legacy URL-only notifications. These do not promise a child WindowProxy or opener. */
  onOpenRequested(lease: DesktopBrowserLeaseId, listener: (url: string) => void): () => void
}
