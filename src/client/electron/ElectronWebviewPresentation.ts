/** Electron tag DOM inside a Sidebar-owned, stable content container. */
import type { DesktopBrowserReservation } from '../../types.ts'
import type { BrowserPresentation } from '../view/BrowserPresentation.ts'
import css from '../view/Browser.module.css'

/** The Electron tag API used by its navigation provider. */
export interface WebviewElement extends HTMLElement {
  loadURL(url: string): Promise<void>
  executeJavaScript(source: string): Promise<unknown>
  getURL(): string
  getTitle(): string
  canGoBack(): boolean
  canGoForward(): boolean
  clearHistory(): void
  goBack(): void
  goForward(): void
  reload(): void
  isLoading(): boolean
  getWebContentsId?(): number
  getZoomFactor(): number
  setZoomFactor(factor: number): void
}

/** Physical attachment notifications; hiding a retained Sidebar body emits neither. */
export interface ElectronPresentationEvents {
  readonly mounted: () => void
  readonly unmounted: () => void
}

/** Owns tag creation and attachment, without measuring or following another element. */
export class ElectronWebviewPresentation implements BrowserPresentation {
  private element: WebviewElement | undefined
  private host: HTMLElement | undefined
  private zoomRevision = 0
  private scaleQuery: MediaQueryList | undefined
  private readonly ready = (): void => { void this.syncZoom() }
  private readonly scaleChanged = (): void => {
    this.watchScale()
    void this.syncZoom()
  }

  constructor(private readonly events: ElectronPresentationEvents) {}

  /** @param viewportId - committed content container. @returns ends attachment and releases its guest. */
  mount(viewportId: string): () => void {
    const host = document.getElementById(viewportId)
    if (host === null) throw new Error('Electron presentation: content container is not mounted')
    if (this.host !== undefined) this.events.unmounted()
    this.host = host
    this.watchScale()
    this.events.mounted()
    return () => {
      if (this.host !== host) return
      this.events.unmounted()
      this.unwatchScale()
      this.host = undefined
    }
  }

  /**
   * Configure a detached webview for an approved guest reservation.
   * @param reservation - main-approved partition and bootstrap lease.
   * @returns a detached, configured webview.
   */
  createElement(reservation: DesktopBrowserReservation): WebviewElement {
    const element = document.createElement('webview') as WebviewElement
    element.className = css.webview as string
    element.dataset.sidebarBrowserFrame = 'webview'
    element.setAttribute('name', reservation.lease)
    element.setAttribute('partition', reservation.partition)
    element.setAttribute('allowpopups', '')
    element.setAttribute('src', 'about:blank#' + reservation.lease)
    return element
  }

  /**
   * Attach a prepared guest, removing any previous guest DOM from the container.
   * @param element - configured guest with its navigation listeners already installed.
   * @throws when no content container is mounted.
   */
  present(element: WebviewElement): void {
    if (this.host === undefined) throw new Error('Electron presentation: cannot attach without a content container')
    this.clear()
    this.element = element
    element.addEventListener('dom-ready', this.ready)
    this.host.append(element)
  }

  /**
   * Set the guest element's accessible label.
   * @param title - observed document title.
   */
  show(title: string): void {
    this.element?.setAttribute('aria-label', title)
  }

  /** Destroy only the guest DOM; a replacement may use the same mounted container. */
  clear(): void {
    this.zoomRevision++
    this.element?.removeEventListener('dom-ready', this.ready)
    this.element?.remove()
    this.element = undefined
  }

  /** Destroy the guest DOM and release its content container. */
  dispose(): void {
    this.clear()
    this.unwatchScale()
    this.host = undefined
  }

  private watchScale(): void {
    this.unwatchScale()
    this.scaleQuery = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
    this.scaleQuery.addEventListener('change', this.scaleChanged)
  }

  private unwatchScale(): void {
    this.scaleQuery?.removeEventListener('change', this.scaleChanged)
    this.scaleQuery = undefined
  }

  private async syncZoom(): Promise<void> {
    const element = this.element
    if (element === undefined) return
    const revision = ++this.zoomRevision
    try {
      const guestRatio = await element.executeJavaScript('window.devicePixelRatio')
      if (this.element !== element || revision !== this.zoomRevision) return
      if (typeof guestRatio !== 'number' || !Number.isFinite(guestRatio) || guestRatio <= 0) return
      const zoom = element.getZoomFactor()
      const factor = zoom * window.devicePixelRatio / guestRatio
      if (Math.abs(zoom - factor) > 0.0001) element.setZoomFactor(factor)
    } catch (error) {
      if (this.element === element && revision === this.zoomRevision) console.error('Electron presentation: cannot align guest zoom', error)
    }
  }
}
