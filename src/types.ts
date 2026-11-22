/** Type-only Electron bridge declarations shared by the desktop shell and browser provider. */
import type { Branded } from '@deepseek-ai/dsh-brand'

export type DesktopNativeLease = Branded<'DesktopNativeLease'>
export type SidebarNativeSlot = Branded<'SidebarNativeSlot'>

export interface DesktopNativeState {
  readonly stage: 'attached' | 'document' | 'closed' | 'failed'
  readonly generation: string
  readonly frameId?: string
  readonly loaderId?: string
  readonly code?: string
}

export interface DesktopNativeViews {
  readonly protocolVersion: 1
  readonly persistentSession?: true
  acquire(scope: string, workspace: string, persistent?: boolean): Promise<{ readonly lease: DesktopNativeLease }>
  attach(lease: DesktopNativeLease, slot: SidebarNativeSlot): Promise<void>
  command(lease: DesktopNativeLease, method: string, params?: object): Promise<object>
  onState(lease: DesktopNativeLease, listener: (state: DesktopNativeState) => void): () => void
  release(lease: DesktopNativeLease): Promise<void>
}

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
  | { readonly status: 'unsupported'; readonly code: 'BROWSER_NATIVE_CHILD_UNAVAILABLE' | 'invalid-child-url' | 'guest-disposed' | 'sidebar-tab-dispatch-failed' }

export interface DesktopBrowserChildTabs {
  readonly protocolVersion: 1
  /** Native opener requests must wait for the decision; denial must never create a window. */
  onRequested(lease: DesktopBrowserLeaseId, listener: (request: BrowserChildTabRequest) => BrowserChildTabResult): () => void
}

export interface DesktopNativeChild {
  readonly request: string
  readonly opener: string
  readonly child: string
  readonly lease: DesktopNativeLease
  readonly target: string
  readonly url: string
  readonly disposition: string
}

export interface DesktopNativeChildTabs {
  readonly protocolVersion: 2
  registerOwner(parent: string, slot: SidebarNativeSlot): Promise<() => void>
  onCreated(parent: string, listener: (child: DesktopNativeChild) => void): () => void
  onClosed(parent: string, listener: (child: DesktopNativeChild) => void): () => void
  adopt(request: string, slot: SidebarNativeSlot): Promise<{ child: string; lease: DesktopNativeLease }>
}

/** Origin-scoped operations; no Electron objects or arbitrary IPC cross this interface. */
export interface DesktopBrowserBridge {
  readonly persistentSession?: true
  readonly nativeViews?: DesktopNativeViews
  /** Version 1 supports URL-only requests; version 2 adopts native WindowProxy children. */
  readonly childTabs?: DesktopBrowserChildTabs | DesktopNativeChildTabs
  /** @param workspace - resolved storage account. @returns one approved guest reservation. */
  acquire(workspace: string, persistent?: boolean): Promise<DesktopBrowserReservation>
  /** @param lease - the caller's reservation. @returns after its guest has been destroyed. */
  release(lease: DesktopBrowserLeaseId): Promise<void>
  /** Legacy URL-only notifications. These do not promise a child WindowProxy or opener. */
  onOpenRequested(lease: DesktopBrowserLeaseId, listener: (url: string) => void): () => void
}
