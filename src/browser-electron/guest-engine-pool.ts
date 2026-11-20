/**
 * Lazy-started headless real-browser pool for the Web sidebar guest proxy.
 *
 * When a site blocks server-side `fetch()` via TLS/HTTP2 fingerprinting or JS-minted
 * cookies (e.g. Baidu Search/Tieba/Baike, Cloudflare challenges), this pool drives the
 * user's installed Edge/Chrome in headless mode with a dedicated plugin-owned profile
 * (`<dshHome>/dsh-builtin-browser-host/guest-proxy-profile`), syncs real cookies back
 * into `GuestCookieJar`, and returns the rendered DOM HTML so the sidebar iframe still
 * displays crisp, native, selectable vector text rather than a blurry screencast.
 * @module dsh-builtin-browser/browser-electron/guest-engine-pool
 */

import { join } from 'node:path'
import { dshHome } from './paths.ts'
import { detectBrowser, SystemBrowserViewHost } from './system-browser.ts'
import type { ElectronViewHandle } from './provider.ts'
import type { GuestCookieJar, StoredCookie } from './guest-cookie-jar.ts'

/** Close the background headless browser after 5 minutes of inactivity. */
const IDLE_DISPOSE_MS = 5 * 60 * 1000
/** Maximum time to wait for a page's main content to settle after navigation. */
const RENDER_SETTLE_TIMEOUT_MS = 5_000
/** Poll interval while waiting for `document.readyState` & content. */
const RENDER_POLL_MS = 200

const CHALLENGE_PATTERN = /安全验证|wappass|cf-browser-verification|Just a moment/iu

export interface EngineFetchResult {
  readonly html: string
  readonly finalUrl: URL
  readonly status: number
}

interface CdpCookie {
  readonly name: string
  readonly value: string
  readonly domain: string
  readonly path: string
  readonly expires?: number
  readonly httpOnly?: boolean
  readonly secure?: boolean
}

function toStoredCookie(c: CdpCookie, fallbackHost: string): StoredCookie {
  const normalizedDomain = c.domain.replace(/^\.+/u, '').toLowerCase()
  return {
    host: normalizedDomain !== '' ? normalizedDomain : fallbackHost.toLowerCase(),
    name: c.name,
    value: c.value,
    path: c.path.startsWith('/') ? c.path : '/',
    secure: c.secure === true,
    httpOnly: c.httpOnly === true,
    ...typeof c.expires === 'number' && c.expires > 0 ? { expiresAt: Math.round(c.expires * 1000) } : {},
  }
}

/**
 * Manages one on-demand headless system browser for anti-bot guest fetches.
 */
export class GuestEnginePool {
  private host: SystemBrowserViewHost | undefined
  private view: ElectronViewHandle | undefined
  private idleTimer: NodeJS.Timeout | undefined
  /** Serialize navigations on the shared tab so two concurrent requests never clobber each other. */
  private queue: Promise<unknown> = Promise.resolve()

  private profileDir(): string {
    return join(dshHome(), 'dsh-builtin-browser-host', 'guest-proxy-profile')
  }

  private bumpIdleTimer(): void {
    if (this.idleTimer !== undefined) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => { this.dispose() }, IDLE_DISPOSE_MS)
    this.idleTimer.unref?.()
  }

  private ensureView(): ElectronViewHandle | undefined {
    if (process.env.DSH_GUEST_DISABLE_ENGINE === '1') return undefined
    if (this.view !== undefined && this.host?.available() === true) {
      this.bumpIdleTimer()
      return this.view
    }
    const detected = detectBrowser('auto')
    if (detected === undefined) return undefined
    this.host?.dispose()
    this.host = new SystemBrowserViewHost(
      detected,
      this.profileDir(),
      ['--disable-blink-features=AutomationControlled'],
      undefined,
      undefined,
      'headless',
      () => true,
    )
    this.view = this.host.createView()
    this.bumpIdleTimer()
    return this.view
  }

  /**
   * Navigate to `targetUrl` in the background real browser, sync real cookies into
   * `cookieJar`, and return the rendered DOM HTML.
   */
  async fetchRenderedDocument(targetUrl: URL, cookieJar: GuestCookieJar): Promise<EngineFetchResult | undefined> {
    const run = async (): Promise<EngineFetchResult | undefined> => {
      const view = this.ensureView()
      if (view === undefined) return undefined

      try {
        await view.sendCommand('Page.enable')
        await view.sendCommand('Network.enable')

        const existing = cookieJar.exportCookies(targetUrl)
        if (existing.length > 0) {
          const cdpCookies = existing.map(cookie => ({
            name: cookie.name,
            value: cookie.value,
            domain: cookie.host.split(':')[0] ?? cookie.host,
            path: cookie.path,
            secure: cookie.secure,
            httpOnly: cookie.httpOnly === true,
            ...cookie.expiresAt !== undefined ? { expires: Math.floor(cookie.expiresAt / 1000) } : {},
          }))
          await view.sendCommand('Network.setCookies', { cookies: cdpCookies }).catch(() => undefined)
        }

        await view.sendCommand('Page.navigate', { url: targetUrl.href })

        const deadline = Date.now() + RENDER_SETTLE_TIMEOUT_MS
        let snapshot: { readonly href: string; readonly html: string; readonly readyState: string; readonly textLen: number } | undefined
        while (Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, RENDER_POLL_MS))
          const evalRes = await view.sendCommand('Runtime.evaluate', {
            expression: `(() => {
              const title = document.title || '';
              const text = (document.body && document.body.innerText) ? document.body.innerText : '';
              return JSON.stringify({
                href: location.href,
                readyState: document.readyState,
                title,
                textLen: text.trim().length,
                html: document.documentElement ? document.documentElement.outerHTML : ''
              });
            })()`,
            returnByValue: true,
          }) as { result?: { value?: unknown } }
          if (typeof evalRes?.result?.value === 'string') {
            try {
              const parsed = JSON.parse(evalRes.result.value) as {
                href?: string; readyState?: string; title?: string; textLen?: number; html?: string
              }
              if (typeof parsed.html === 'string' && parsed.html.length > 0) {
                snapshot = {
                  href: typeof parsed.href === 'string' && parsed.href !== '' ? parsed.href : targetUrl.href,
                  html: parsed.html,
                  readyState: parsed.readyState ?? 'loading',
                  textLen: parsed.textLen ?? 0,
                }
                const isChallenge = CHALLENGE_PATTERN.test(parsed.title ?? '') && snapshot.textLen < 400
                if (snapshot.readyState === 'complete' && snapshot.textLen > 100 && !isChallenge) {
                  break
                }
              }
            } catch { /* retry poll */ }
          }
        }

        const cookieRes = await view.sendCommand('Network.getCookies', {
          urls: [targetUrl.origin, snapshot?.href ?? targetUrl.href],
        }) as { cookies?: CdpCookie[] }
        if (Array.isArray(cookieRes?.cookies) && cookieRes.cookies.length > 0) {
          cookieJar.importCookies(cookieRes.cookies.map(c => toStoredCookie(c, targetUrl.host)))
        }

        if (snapshot === undefined || snapshot.html === '') return undefined
        let finalUrl = targetUrl
        try {
          const parsed = new URL(snapshot.href)
          if (parsed.protocol === 'http:' || parsed.protocol === 'https:') finalUrl = parsed
        } catch { /* keep targetUrl */ }

        return {
          html: `<!DOCTYPE html>\n${snapshot.html}`,
          finalUrl,
          status: 200,
        }
      } catch {
        if (this.view !== undefined) {
          this.host?.destroyView(this.view)
          this.view = undefined
        }
        return undefined
      } finally {
        this.bumpIdleTimer()
      }
    }

    const next = this.queue.then(run, run)
    this.queue = next.then(() => undefined, () => undefined)
    return await next
  }

  dispose(): void {
    if (this.idleTimer !== undefined) {
      clearTimeout(this.idleTimer)
      this.idleTimer = undefined
    }
    if (this.view !== undefined) {
      try { this.host?.destroyView(this.view) } catch { /* already closed */ }
      this.view = undefined
    }
    try { this.host?.dispose() } catch { /* already closed */ }
    this.host = undefined
  }
}

/** Shared pool instance used by `guest-route.ts`. */
export const guestEnginePool = new GuestEnginePool()

/**
 * Known anti-bot routes where server-side Node `fetch()` consistently receives an empty
 * verification shell and should jump straight to the real-browser channel.
 */
const ENGINE_FIRST_PATTERNS: readonly RegExp[] = [
  /^https?:\/\/(?:www\.)?baidu\.com\/s(?:[/?#]|$)/iu,
  /^https?:\/\/tieba\.baidu\.com(?:\/|$)/iu,
  /^https?:\/\/baike\.baidu\.com(?:\/|$)/iu,
]

export function shouldUseEngineFirst(targetUrl: URL): boolean {
  return ENGINE_FIRST_PATTERNS.some(pattern => pattern.test(targetUrl.href))
}
