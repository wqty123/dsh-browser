/// <reference path="../css-modules.d.ts" />
/** Iframe DOM and revision-tagged load observations. */
import type { BrowserTarget } from '../browser/url.ts'
import type { BrowserPresentation } from './BrowserPresentation.ts'
import css from './Browser.module.css'

/** Fixed iframe policy; top navigation and downloads are not granted directly. */

/**
 * 侧栏 iframe 实际加载的地址：**经同源代理**。
 *
 * 直连（`return url`）试过一轮，实测不可行：大量站点用 `X-Frame-Options` / CSP `frame-ancestors`
 * 禁止被第三方 iframe 嵌入——sudoku.com、必应都是 `SAMEORIGIN`，GitHub 是 `deny` + `'none'`，
 * 浏览器直接拒绝显示（用户看到的「拒绝连接」）。代理由宿主自己返回 HTML，响应里没有这些头，
 * 因此任何站点都能嵌进侧栏，这也是引用能读到选区的前提（同源）。
 *
 * 代理的已知边界另算：站点用 `fetch` 去拿自己的接口时，请求会被跨域拦或打到宿主根路径。
 * @param url - the page the reader asked for.
 * @returns the proxied address, or the original for non-http(s) targets.
 */
function guestProxyUrl(url: string): string {
  if (!/^https?:\/\//iu.test(url)) return url
  if (url.includes('/dsh-builtin-browser/browser-view/guest')) return url
  return `${location.origin}/dsh-builtin-browser/browser-view/guest?u=${encodeURIComponent(url)}`
}

/**
 * 反向读出「代理地址里真正要打开的页面」。
 *
 * 页内点链接后 iframe 的地址会变成 `…/browser-view/guest?u=<真实地址>`；因为代理是同源的，
 * 这里可以读出来，交回控制器更新地址栏——否则地址栏停在旧地址，还会提示「URL 已变化」。
 * @param frame - 已加载完成的 iframe。
 * @returns 真实 http(s) 地址；读不到（跨源、非代理地址）时返回 undefined。
 */
function observedTargetUrl(frame: HTMLIFrameElement): string | undefined {
  let href: string
  try {
    href = String(frame.contentWindow?.location.href ?? '')
  } catch {
    return undefined
  }
  if (href === '') return undefined
  let parsed: URL
  try {
    parsed = new URL(href)
  } catch {
    return undefined
  }
  const raw = parsed.searchParams.get('u')
  if (raw === null || raw === '') return undefined
  return /^https?:\/\//iu.test(raw) ? raw : undefined
}

export const WEB_BROWSER_SANDBOX = 'allow-scripts allow-forms allow-same-origin'
const RELAXED_BROWSER_SANDBOX = `${WEB_BROWSER_SANDBOX} allow-downloads allow-modals allow-pointer-lock allow-top-navigation allow-orientation-lock allow-presentation allow-storage-access-by-user-activation`

interface IframeDocument {
  readonly target: BrowserTarget
  readonly revision: number
  readonly sandboxed: boolean
}

/** Reports only what an iframe can observe without inspecting cross-origin content. */
export interface IframePresentationEvents {
  /** @param revision - document generation whose iframe emitted `load`. @param observedUrl - same-origin page the frame ended up on, when readable. */
  readonly loaded: (revision: number, observedUrl?: string) => void
  readonly failed: (revision: number) => void
  readonly remounted: () => void
}

/** Owns the iframe element; navigation and history remain in IframeImpl. */
export class IframePresentation implements BrowserPresentation {
  private host: HTMLElement | undefined
  private element: HTMLIFrameElement | undefined
  private document: IframeDocument | undefined
  private rendered = false

  /** @param events - provider-owned load and remount callbacks. */
  constructor(private readonly events: IframePresentationEvents) {}

  /**
   * 用 iframe 自己的会话历史后退/前进。
   *
   * 应用侧只记录「我们自己发起过的地址」，页内链接与表单提交都不在里面，所以侧栏那两个键在
   * 真实网页上一直是禁用的（用户报「两个键不能正常点击」）。代理是同源页面，直接驱它的
   * `history` 才能覆盖页内导航。
   * @param delta - 负数后退，正数前进。
   * @returns 是否真的发起了一次历史移动。
   */
  historyStep(delta: number): boolean {
    const win = this.element?.contentWindow
    if (win === undefined || win === null) return false
    try {
      if (delta < 0) win.history.back()
      else win.history.forward()
      return true
    } catch {
      return false
    }
  }

  /**
   * iframe 内可回退的深度（同源代理才读得到）。
   * @returns 历史条数；读不到时返回 1（表示「没有可回退项」）。
   */
  historyDepth(): number {
    try {
      return this.element?.contentWindow?.history.length ?? 1
    } catch {
      return 1
    }
  }

  /** @param viewportId - mounted placeholder. @returns removes only the iframe presentation. */
  mount(viewportId: string): () => void {
    const host = document.getElementById(viewportId)
    if (host === null) throw new Error('iframe presentation: viewport is not mounted')
    this.element?.remove()
    this.element = undefined
    this.host = host
    if (this.rendered) this.events.remounted()
    else this.render()
    return () => {
      if (this.host !== host) return
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
    this.element?.remove()
    this.element = undefined
    this.host = undefined
    this.document = undefined
  }

  private render(): void {
    const current = this.document
    const host = this.host
    if (current === undefined || host === undefined) return
    this.element?.remove()
    const element = document.createElement('iframe')
    element.className = css.frame as string
    // Web shell only: serve the guest through the plugin's same-origin proxy so the frame is
    // READABLE. A cross-origin frame can be displayed but never quoted from, which is why the Web
    // sidebar showed pages yet produced no references. The proxy rewrites the document and injects
    // the reference bar; a document that is not http(s) (about:blank, a start page) is untouched.
    element.src = guestProxyUrl(current.target.url)
    element.title = current.target.title
    element.referrerPolicy = 'no-referrer'
    element.dataset.sidebarBrowserFrame = 'iframe'
    element.setAttribute('sandbox', current.sandboxed ? WEB_BROWSER_SANDBOX : RELAXED_BROWSER_SANDBOX)
    element.addEventListener('load', () => {
      if (this.element !== element) return
      // 同源（代理形态）时能读出页面自己走到了哪个地址，交给控制器更新地址栏。
      this.events.loaded(current.revision, observedTargetUrl(element))
    })
    element.addEventListener('error', () => {
      if (this.element === element) this.events.failed(current.revision)
    })
    this.element = element
    this.rendered = true
    host.append(element)
  }
}
