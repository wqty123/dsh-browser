/// <reference path="../css-modules.d.ts" />
/** Iframe DOM and revision-tagged load observations. */
import type { BrowserTarget } from '../browser/url.ts'
import type { BrowserPresentation } from './BrowserPresentation.ts'
import css from './Browser.module.css'

/** Route Web pages through the opaque-origin proxy. */
function guestProxyUrl(url: string): string {
  if (!/^https?:\/\//iu.test(url)) return url
  if (url.includes('/dsh-builtin-browser/browser-view/isolated-guest')) return url
  return `${location.origin}/dsh-builtin-browser/browser-view/isolated-guest?u=${encodeURIComponent(url)}`
}

/** Opaque guest documents cannot access the application's origin or open native windows. */
export const WEB_BROWSER_SANDBOX = 'allow-scripts allow-forms'
const RELAXED_BROWSER_SANDBOX = `${WEB_BROWSER_SANDBOX} allow-downloads allow-modals allow-pointer-lock allow-orientation-lock allow-presentation allow-storage-access-by-user-activation`

interface IframeDocument {
  readonly target: BrowserTarget
  readonly revision: number
  readonly sandboxed: boolean
}

/** Reports only what an iframe can observe without inspecting cross-origin content. */
export interface IframePresentationEvents {
  /** @param revision - document generation whose native load completed. */
  readonly loaded: (revision: number) => void
  /** @param revision - document generation. @param observedUrl - URL reported by the owned opaque guest. */
  readonly observed: (revision: number, observedUrl: string) => void
  readonly failed: (revision: number) => void
  readonly remounted: () => void
}

/** Owns the iframe element; navigation and history remain in IframeImpl. */
export class IframePresentation implements BrowserPresentation {
  private host: HTMLElement | undefined
  private element: HTMLIFrameElement | undefined
  private document: IframeDocument | undefined
  private rendered = false
  private depth = 1
  private loadId: number | undefined
  private nextLoadId = 0
  private readonly receive = (event: MessageEvent): void => {
    if (event.origin !== 'null' || event.source !== this.element?.contentWindow) return
    const data = event.data
    if (!data || data.type !== 'dsh.browser.guest.navigation' || typeof data.url !== 'string'
      || !/^https?:\/\//iu.test(data.url) || this.document === undefined) return
    if (this.loadId === undefined) return
    if (data.loadId !== this.loadId) {
      this.requestNavigation()
      return
    }
    this.depth = Number.isSafeInteger(data.depth) && data.depth > 0 ? data.depth : 1
    this.events.observed(this.document.revision, data.url)
  }

  /** @param events - provider-owned load and remount callbacks. */
  constructor(private readonly events: IframePresentationEvents) {}

  /** Request history movement in the guest without reading its cross-origin window. */
  historyStep(delta: number): boolean {
    const win = this.element?.contentWindow
    if (win === undefined || win === null) return false
    try {
      win.postMessage({ type: 'dsh.browser.guest.history', delta: delta < 0 ? -1 : 1 }, '*')
      return true
    } catch {
      return false
    }
  }

  /** History depth reported by the guest. */
  historyDepth(): number {
    return this.depth
  }

  /** @param viewportId - mounted placeholder. @returns removes only the iframe presentation. */
  mount(viewportId: string): () => void {
    const host = document.getElementById(viewportId)
    if (host === null) throw new Error('iframe presentation: viewport is not mounted')
    this.element?.remove()
    this.element = undefined
    this.host = host
    window.addEventListener('message', this.receive)
    if (this.rendered) this.events.remounted()
    else this.render()
    return () => {
      if (this.host !== host) return
      window.removeEventListener('message', this.receive)
      this.element?.remove()
      this.element = undefined
      this.host = undefined
    }
  }

  /**
   * Retain the prepared document and render it when a container is mounted.
   * @param value - prepared document and event generation.
   */
  show(value: IframeDocument): void {
    this.document = value
    this.render()
  }

  /** Remove the owned DOM and retained presentation data. */
  dispose(): void {
    window.removeEventListener('message', this.receive)
    this.element?.remove()
    this.element = undefined
    this.host = undefined
    this.document = undefined
  }

  private requestNavigation(): void {
    try {
      this.element?.contentWindow?.postMessage({ type: 'dsh.browser.guest.navigation.request', loadId: this.loadId }, '*')
    } catch {
      // Native load completion does not depend on a scriptable guest.
    }
  }

  private render(): void {
    const current = this.document
    const host = this.host
    if (current === undefined || host === undefined) return
    this.element?.remove()
    const element = document.createElement('iframe')
    element.className = css.frame as string
    element.src = guestProxyUrl(current.target.url)
    element.title = current.target.title
    element.referrerPolicy = 'no-referrer'
    element.dataset.sidebarBrowserFrame = 'iframe'
    element.setAttribute('sandbox', current.sandboxed ? WEB_BROWSER_SANDBOX : RELAXED_BROWSER_SANDBOX)
    element.addEventListener('load', () => {
      if (this.element !== element) return
      this.loadId = ++this.nextLoadId
      this.events.loaded(current.revision)
      this.requestNavigation()
    })
    element.addEventListener('error', () => {
      if (this.element === element) this.events.failed(current.revision)
    })
    this.depth = 1
    this.loadId = undefined
    this.element = element
    this.rendered = true
    host.append(element)
  }
}
