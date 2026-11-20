/** Carrier-neutral page navigation and observable state. */
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { BrowserTarget } from './url.ts'

/** A loading failure, optionally carrying the underlying browser's diagnostic. */
export interface BrowserLoadError {
  readonly code: number | undefined
  readonly description: string | undefined
}

/** State consumed by common browser chrome, without DOM or carrier identifiers. */
export interface BrowserFrameState {
  readonly target: BrowserTarget | undefined
  readonly address: 'empty' | 'requested' | 'observed' | 'unknown'
  readonly loading: boolean
  readonly canGoBack: boolean
  readonly canGoForward: boolean
  readonly error: BrowserLoadError | undefined
  /** Undefined when this provider does not expose a sandbox control. */
  readonly sandboxEnabled: boolean | undefined
}

/** Optional iframe policy control, not an Electron process-sandbox switch. */
export interface BrowserSandboxControl {
  /** @param enabled - whether the provider's embedding sandbox is enforced. */
  setEnabled(enabled: boolean): void
}

/** Carrier-level initialization stage, below the navigation record. */
export type BrowserCarrierStage = 'idle' | 'guest' | 'ready' | 'failed'

/** What the carrier can prove about the page it owns. */
export interface BrowserCarrierState {
  readonly stage: BrowserCarrierStage
  /** Native guest id once the shell reports one. */
  readonly guestId?: string
  /** Why the carrier could not reach `ready`; machine code, localized by the UI. */
  readonly reason?: 'workspace-unavailable' | 'acquire-failed' | 'guest-bootstrap-failed'
  /** Original carrier failure text, bounded and kept with its owning attempt. */
  readonly detail?: string
}

/** Navigation owns page lifetime; mounting and hiding belong to BrowserPresentation. */
export interface BrowserFrame extends HostObservable<BrowserFrameState> {
  readonly sandbox?: BrowserSandboxControl
  /**
   * Optional carrier proof (`guest created`, `document ready`, bootstrap failure).
   * A frame without it still navigates; its initialization receipt simply stops
   * at `navigating`, which is exactly what an older carrier can promise.
   */
  readonly lifecycle?: HostObservable<BrowserCarrierState>
  /** @param target - validated HTTP(S) address; loading failures are published in state. */
  loadUrl(target: BrowserTarget): void
  /** Move backward when the provider reports an available entry. */
  goBack(): void
  /** Move forward when the provider reports an available entry. */
  goForward(): void
  /** Reload the current address without creating a new history entry. */
  reload(): void
  /** @returns after the page, listeners and pending initialization have been released; repeated calls join disposal. */
  dispose(): Promise<void>
}

/**
 * Create idle navigation state without a page target.
 * @returns state before any page has been requested.
 */
export function emptyBrowserFrame(): BrowserFrameState {
  return { target: undefined, address: 'empty', loading: false, canGoBack: false, canGoForward: false,
    error: undefined, sandboxEnabled: undefined }
}
