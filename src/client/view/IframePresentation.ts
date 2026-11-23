/// <reference path="../css-modules.d.ts" />
import { GUEST_ROUTE, RELAXED_BROWSER_SANDBOX, WEB_BROWSER_SANDBOX } from '../../../assets/browser-policy.mjs'
/** Iframe DOM and revision-tagged load observations. */
import type { BrowserTarget } from '../browser/url.ts'
import type { BrowserPresentation } from './BrowserPresentation.ts'
import css from './Browser.module.css'
import { registerIframePage, registerIframeReference, type GuestReferenceCommand } from '../browser/iframe-reference.ts'
import { connectWebReferenceSource } from '../browser/web-reference-source.ts'
import { registerTakeoverSummary } from '../browser/takeover-channel.ts'
import type { TakeoverSummary } from '../../takeover-protocol.ts'
import { sameReferenceDocument } from '../../reference-page.ts'
import { dispatchChildTab } from '../browser/child-tabs.ts'
import { reportReferenceCaptureFailure } from '../reference-intents.ts'
import type { BrowserChildTabRequest } from '../../types.ts'

/** Route Web pages through the opaque-origin proxy. */
function guestProxyUrl(url: string, context: string): string {
  if (!/^https?:\/\//iu.test(url)) return url
  if (url.includes(GUEST_ROUTE)) return url
  return `${location.origin}${GUEST_ROUTE}?u=${encodeURIComponent(url)}&runtime=3&storage-context=${encodeURIComponent(context)}`
}

function capturedSourceUrl(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    const proxy = new URL(value)
    if (proxy.origin === location.origin && proxy.pathname === GUEST_ROUTE) {
      const source = proxy.searchParams.get('u')
      if (source !== null && /^https?:\/\//iu.test(source)) return new URL(source).href
    }
  } catch { /* Invalid source URLs remain subject to capture validation. */ }
  return value
}

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
  readonly reference?: (intent: object) => Promise<void>
  readonly childRequested?: (url: string) => void
  readonly capabilityFailed?: (description: string) => void
  readonly guestReady?: (revision: number, pageId: string) => void
  readonly guestPending?: () => void
  readonly guestFailed?: (revision: number, description: string) => void
  readonly failed: (revision: number) => void
  readonly remounted: () => void
}

/** Owns the iframe element; navigation and history remain in IframeImpl. */
export class IframePresentation implements BrowserPresentation {
  private readonly pageId = `iframe:${crypto.randomUUID()}`
  private readonly unregisterReference: (() => void) | undefined
  private readonly sourceLifetime = new AbortController()
  private sourceConnection: Promise<void> | undefined
  private observedUrl: string | undefined
  private unregisterPage: (() => void) | undefined
  private nextRequestId = 0
  private readonly pending = new Map<number, { readonly loadId: number; readonly url: string; readonly resolve: (value: Record<string, unknown>) => void; readonly reject: (error: Error) => void }>()
  private host: HTMLElement | undefined
  private element: HTMLIFrameElement | undefined
  private document: IframeDocument | undefined
  private rendered = false
  private depth = 1
  private loadId: number | undefined
  private documentId: string | undefined
  private loadedId: number | undefined
  private nativeLoadId: number | undefined
  private nextLoadId = 0
  private childRequestId = 0
  private identityTimer: ReturnType<typeof setTimeout> | undefined
  private identityRetried = false
  private readonly receive = (event: MessageEvent): void => {
    if (event.origin !== 'null' || event.source !== this.element?.contentWindow) return
    const data = event.data
    if (data?.type === 'dsh.browser.guest.child.request') {
      if (this.loadId === undefined || data.loadId !== this.loadId || !Number.isSafeInteger(data.requestId)
        || data.requestId <= this.childRequestId || typeof data.url !== 'string'
        || !['url-only', 'native-opener'].includes(data.mode)) return
      this.childRequestId = data.requestId
      const result = dispatchChildTab(data as BrowserChildTabRequest, location.origin, url => { this.events.childRequested?.(url) })
      if (result.status === 'unsupported') this.events.capabilityFailed?.(result.code)
      return
    }
    if (data?.type === 'dsh.browser.guest.reference.ack') {
      const request = this.pending.get(data.requestId)
      if (request === undefined) return
      if (data.loadId !== request.loadId || data.loadId !== this.loadId || data.documentId !== this.documentId
        || typeof data.url !== 'string' || !sameReferenceDocument(data.url, request.url)) {
        request.reject(new Error('GUEST_REFERENCE_IDENTITY_MISMATCH: source iframe acknowledgement belongs to another document'))
        return
      }
      if (data.ok === false) request.reject(new Error(typeof data.reason === 'string' ? data.reason : 'guest reference failed'))
      else if (data.ok === true && data.value !== null && typeof data.value === 'object' && !Array.isArray(data.value)) request.resolve(data.value)
      return
    }
    if (data?.type === 'dsh-browser-ref:intent') {
      void this.capture(data).catch(reportReferenceCaptureFailure)
      return
    }
    if (!data || data.type !== 'dsh.browser.guest.navigation' || typeof data.url !== 'string'
      || !/^https?:\/\//iu.test(data.url) || this.document === undefined) return
    if (this.loadId === undefined) return
    if (typeof data.documentId !== 'string' || !data.documentId || data.documentId.length > 100) {
      this.observedUrl = undefined
      for (const request of [...this.pending.values()]) request.reject(new Error('GUEST_DOCUMENT_IDENTITY_UNAVAILABLE: source iframe identity is missing'))
      this.events.guestPending?.()
      this.awaitIdentity()
      if (!this.identityRetried) { this.identityRetried = true; this.requestNavigation() }
      return
    }
    if (data.loadId !== undefined && data.loadId !== this.loadId) {
      this.awaitIdentity()
      this.requestNavigation()
      return
    }
    if (data.documentId !== this.documentId) {
      const nativeLoaded = this.documentId === undefined && this.nativeLoadId === this.loadId
      this.invalidateGuest()
      this.loadId = ++this.nextLoadId
      this.documentId = data.documentId
      if (nativeLoaded) this.nativeLoadId = this.loadId
      this.awaitIdentity()
      this.requestNavigation()
      return
    }
    if (data.loadId !== this.loadId) {
      this.awaitIdentity()
      this.requestNavigation()
      return
    }
    clearTimeout(this.identityTimer)
    this.identityTimer = undefined
    this.identityRetried = false
    this.depth = Number.isSafeInteger(data.depth) && data.depth > 0 ? data.depth : 1
    if (data.ready === true) this.markLoaded()
    this.observedUrl = data.url
    this.events.observed(this.document.revision, data.url)
    if (data.ready === true && this.owner !== undefined && this.host !== undefined) {
      this.unregisterPage?.()
      this.unregisterPage = registerIframePage(this.owner, this.host.id, this.pageId, data.url, this.document.target.url)
    }
    if (data.ready === true) this.events.guestReady?.(this.document.revision, this.pageId)
  }

  /** @param events - provider-owned load and remount callbacks. */
  constructor(private readonly events: IframePresentationEvents, private readonly owner?: string) {
    if (owner !== undefined) this.sourceLifetime.signal.addEventListener('abort', registerTakeoverSummary(this.pageId, owner, async signal => {
      const result = await this.command('summary', { maxChars: 1500, legacy: false }, signal, this.observedUrl ?? '', this.loadId)
      return result as unknown as TakeoverSummary
    }), { once: true })
    if (owner !== undefined) this.unregisterReference = registerIframeReference(this.pageId, owner, url => {
      const loadId = this.loadId
      return (operation, spec, signal) => this.command(operation, spec, signal, url, loadId)
    })
  }

  private command(operation: Parameters<GuestReferenceCommand>[0], spec: object, signal: AbortSignal,
    url: string, loadId: number | undefined): Promise<Record<string, unknown>> {
    signal.throwIfAborted()
    if (loadId === undefined || loadId !== this.loadId || this.documentId === undefined || this.observedUrl === undefined
      || !sameReferenceDocument(url, this.observedUrl) || this.element?.contentWindow == null) {
      return Promise.reject(new Error('source iframe document is not ready'))
    }
    const win = this.element.contentWindow
    const requestId = ++this.nextRequestId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { finish(undefined, new Error('GUEST_REFERENCE_TIMEOUT: source iframe did not acknowledge the reveal')) }, 5000)
      const finish = (value?: Record<string, unknown>, error?: Error): void => {
        clearTimeout(timer)
        this.pending.delete(requestId)
        signal.removeEventListener('abort', abort)
        if (error !== undefined) reject(error)
        else resolve(value!)
      }
      const abort = (): void => { finish(undefined, new Error('source reveal cancelled')) }
      this.pending.set(requestId, { loadId, url, resolve: value => { finish(value) }, reject: error => { finish(undefined, error) } })
      signal.addEventListener('abort', abort, { once: true })
      try { win.postMessage({ type: 'dsh.browser.guest.reference.request', operation, spec, url, loadId, documentId: this.documentId, requestId }, '*') }
      catch (error) { finish(undefined, error instanceof Error ? error : new Error(String(error))) }
    })
  }

  private invalidateGuest(): void {
    this.unregisterPage?.()
    this.unregisterPage = undefined
    clearTimeout(this.identityTimer)
    this.identityTimer = undefined
    this.identityRetried = false
    this.childRequestId = 0
    this.loadId = undefined
    this.documentId = undefined
    this.loadedId = undefined
    this.nativeLoadId = undefined
    this.observedUrl = undefined
    for (const request of this.pending.values()) request.reject(new Error('source iframe document changed'))
    this.events.guestPending?.()
  }

  private async capture(data: object): Promise<void> {
    if (this.owner !== undefined) {
      this.sourceConnection ??= connectWebReferenceSource(this.owner, this.pageId, () => this.observedUrl ?? this.document?.target.url ?? '', this.sourceLifetime.signal)
      try { await this.sourceConnection }
      catch (error) { this.sourceConnection = undefined; throw error }
      if (this.sourceLifetime.signal.aborted) throw new Error('source iframe was disposed')
    }
    const frozen = (data as { readonly capture?: Record<string, unknown> }).capture
    const intent = frozen !== null && typeof frozen === 'object' && !Array.isArray(frozen)
      ? { ...data, capture: { ...frozen, url: capturedSourceUrl(frozen.url),
        ...typeof frozen.frameUrl === 'string' ? { frameUrl: capturedSourceUrl(frozen.frameUrl) } : {} } }
      : data
    await this.events.reference?.({ ...intent, ...this.owner === undefined ? {} : { sourcePageId: this.pageId } })
  }

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
    this.invalidateGuest()
    this.element = undefined
    this.host = host
    window.addEventListener('message', this.receive)
    if (this.rendered) this.events.remounted()
    else this.render()
    return () => {
      if (this.host !== host) return
      window.removeEventListener('message', this.receive)
      this.invalidateGuest()
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
    this.sourceLifetime.abort()
    window.removeEventListener('message', this.receive)
    this.invalidateGuest()
    this.unregisterReference?.()
    this.element?.remove()
    this.element = undefined
    this.host = undefined
    this.document = undefined
  }

  private requestNavigation(): void {
    try {
      this.element?.contentWindow?.postMessage({ type: 'dsh.browser.guest.navigation.request', loadId: this.loadId, documentId: this.documentId }, '*')
    } catch {
      // Native load completion does not depend on a scriptable guest.
    }
  }

  private awaitIdentity(): void {
    if (this.identityTimer !== undefined) return
    const revision = this.document?.revision
    this.identityTimer = setTimeout(() => {
      this.identityTimer = undefined
      if (revision === undefined || this.document?.revision !== revision) return
      this.events.guestFailed?.(revision, 'GUEST_DOCUMENT_IDENTITY_UNAVAILABLE: source iframe did not provide a matching document identity')
    }, 5000)
  }

  private markLoaded(): void {
    if (this.document === undefined || this.loadedId === this.loadId) return
    this.loadedId = this.loadId
    this.events.loaded(this.document.revision)
  }

  private render(): void {
    const current = this.document
    const host = this.host
    if (current === undefined || host === undefined) return
    this.invalidateGuest()
    this.element?.remove()
    const element = document.createElement('iframe')
    element.className = css.frame as string
    element.src = guestProxyUrl(current.target.url, this.pageId)
    element.title = current.target.title
    element.referrerPolicy = 'no-referrer'
    element.dataset.sidebarBrowserFrame = 'iframe'
    element.setAttribute('sandbox', current.sandboxed ? WEB_BROWSER_SANDBOX : RELAXED_BROWSER_SANDBOX)
    element.addEventListener('load', () => {
      if (this.element !== element) return
      if (this.nativeLoadId === this.loadId) {
        this.invalidateGuest()
        this.loadId = ++this.nextLoadId
      }
      this.observedUrl = undefined
      this.events.guestPending?.()
      this.markLoaded()
      this.nativeLoadId = this.loadId
      this.awaitIdentity()
      this.requestNavigation()
    })
    element.addEventListener('error', () => {
      if (this.element === element) { this.invalidateGuest(); this.events.failed(current.revision) }
    })
    this.depth = 1
    this.loadId = ++this.nextLoadId
    this.element = element
    this.rendered = true
    host.append(element)
  }
}
