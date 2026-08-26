/**
 * Electron-backed browser provider: `WebContentsView` sessions driven over
 * `webContents.debugger` (CDP). The provider itself does not import Electron — it operates through the {@link ElectronBrowserViewHost} seam, which the
 * desktop shell implements with real Electron objects. That keeps this
 * package testable under plain Node and leaves the Electron dependency to the
 * shell that owns the `BrowserWindow`.
 * @module dsh-browser/browser-electron
 */

import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import type {
  BrowserA11yRequest,
  BrowserA11yResult,
  BrowserChallenge,
  BrowserCheckRequest,
  BrowserClearRequest,
  BrowserClickRequest,
  BrowserContentRequest,
  BrowserContentResult,
  BrowserElementTarget,
  BrowserExecuteRequest,
  BrowserExecuteResult,
  BrowserFillRequest,
  BrowserFillResult,
  BrowserGetValueRequest,
  BrowserGetValueResult,
  BrowserHistoryEntry,
  BrowserOpenRequest,
  BrowserProvider,
  BrowserScrapeRequest,
  BrowserScrapeResult,
  BrowserScreenshotRequest,
  BrowserSelectRequest,
  BrowserSelectResult,
  BrowserSessionId,
  BrowserSetValueRequest,
  BrowserSetValueResult,
  BrowserSnapshotResult,
  BrowserTab,
  BrowserTypeRequest,
  BrowserWaitRequest,
  BrowserWaitResult,
  BrowserScrollRequest,
  BrowserKeyRequest,
  ExportedCookie,
} from '../browser/types.js'
import { BrowserError } from '../browser/types.js'

/**
 * Page-context human-verification (CAPTCHA / bot-detection) detection. Runs
 * inside the page; returns `{ blocked, kind?, reason? }`. Marker-based and
 * best-effort: checks for Cloudflare's interstitial, hCaptcha, reCAPTCHA,
 * Turnstile, and generic challenge wording.
 */
const CHALLENGE_DETECT_EXPRESSION = `(() => {
  const title = (document.title || '').trim()
  const bodyText = (document.body && document.body.innerText || '').slice(0, 4000)
  // Challenge widgets often live in same-origin iframes or shadow roots;
  // scan those too (cross-origin frames stay opaque).
  let extraText = ''
  try {
    const seen = new Set()
    const scan = (doc) => {
      if (seen.has(doc)) return
      seen.add(doc)
      for (const el of doc.querySelectorAll('*')) {
        if (el.shadowRoot) {
          extraText += (el.shadowRoot.textContent || '').slice(0, 2000)
          scan(el.shadowRoot)
        }
        if (el.tagName === 'IFRAME') {
          try {
            const d = el.contentDocument
            if (d) {
              extraText += ((d.body && d.body.innerText) || '').slice(0, 2000)
              scan(d)
            }
          } catch { /* cross-origin */ }
        }
      }
    }
    scan(document)
  } catch { /* never fail the challenge check */ }
  const lower = (title + '\\n' + bodyText + '\\n' + extraText).toLowerCase()
  const frameSrcs = [...document.querySelectorAll('iframe')].map(f => f.src || '').join(' ')
  const framesLower = frameSrcs.toLowerCase()
  const hasCfInterstitial = /just a moment|checking your browser|attention required|cf_chl/i.test(lower)
    || !!document.querySelector('#challenge-running, #challenge-stage, #cf-chl-container')
  const hasHCaptcha = !!window.hcaptcha || !!document.querySelector('.h-captcha') || /hcaptcha\\.com/i.test(framesLower)
  const hasRecaptcha = !!window.grecaptcha || !!document.querySelector('.g-recaptcha') || /recaptcha\\/api|google\\.com\\/recaptcha/i.test(framesLower)
  const hasTurnstile = !!window.turnstile || /challenges\\.cloudflare\\.com/i.test(framesLower) || /turnstile|challenge-platform/i.test(lower)
  const verifyWording = /verify you are human|verify you are not a robot|\\u4eba\\u673a\\u9a8c\\u8bc1|\\u5b89\\u5168\\u9a8c\\u8bc1|enable javascript and cookies|\\u8bf7.*\\u9a8c\\u8bc1/i.test(lower)
  if (hasCfInterstitial) return { blocked: true, kind: 'cloudflare', reason: 'Cloudflare "Just a moment" interstitial' }
  if (hasHCaptcha) return { blocked: true, kind: 'hcaptcha', reason: 'hCaptcha verification' }
  if (hasRecaptcha) return { blocked: true, kind: 'recaptcha', reason: 'Google reCAPTCHA verification' }
  if (hasTurnstile) return { blocked: true, kind: 'turnstile', reason: 'Cloudflare Turnstile verification' }
  if (verifyWording && /challenge|captcha|verification|security check|access denied|blocked|\\u9a8c\\u8bc1/i.test(lower)) {
    return { blocked: true, kind: 'generic', reason: 'Human-verification challenge' }
  }
  return { blocked: false }
})()`

/** Stable provider id registered with `ctx.browser`. */
export const ELECTRON_BROWSER_PROVIDER_ID = 'electron'

/**
 * The minimal Electron surface this provider needs. Implemented by the
 * desktop shell with a real `WebContentsView`; a fake implements it in tests.
 */
export interface ElectronBrowserViewHost {
  /**
   * Create a new browser view and return a handle to its webContents-like
   * surface. The host owns windowing (adding the view to the window, sizing,
   * removal); the provider owns CDP-driven behavior.
   */
  createView(): ElectronViewHandle
  /**
   * Destroy a view created by this host. Called on session close; idempotent
   * for an already-destroyed view.
   * @param handle - the handle returned by {@link createView}.
   */
  destroyView(handle: ElectronViewHandle): void
  /**
   * Show one view as the session's visible surface. The host keeps exactly
   * one visible; switching tabs reorders visibility without losing state.
   * Optional: a host without visible-tab switching treats every view as
   * always present (acceptable for headless/probe hosts).
   * @param handle - the handle to make visible.
   * @param label - human-readable session/task label, when the provider knows
   * one; the host may surface it (e.g. in the window title) so a human can
   * tell which task's page is currently visible.
   */
  showView?(handle: ElectronViewHandle, label?: string): void
  /**
   * Optional cheap usability probe (no network): whether the host can back
   * views at all right now. The self-hosted host checks for a usable Electron
   * binary; a host without the probe is assumed usable. Lets the seam's
   * provider selection (BROWSER_PROVIDER_UNAVAILABLE etc.) be real instead
   * of failing only at first use.
   */
  available?(): boolean
  /**
   * Optional: associate a view with a window group. Views grouped under the
   * same `windowId` share one window (one window per browser session); a host
   * without this keeps a single shared window. Called right after
   * `createView`, so the host may route the view to its own window even
   * before the first command materializes it.
   * @param handle - the view to group.
   * @param windowId - the group (session) key.
   * @param label - human-readable label for the window title.
   */
  groupView?(handle: ElectronViewHandle, windowId: string, label?: string): void
  /**
   * Optional: receive user-initiated browser actions from the host's own UI
   * (e.g. a toolbar address bar, back/forward buttons, tab strip). The
   * provider routes them into the session model so the agent and the human
   * always see the same tabs and navigation state.
   * @param handler - called for every user action; must not throw.
   */
  onUserAction?(handler: (action: BrowserUserAction) => void): void
}

/**
 * A user-initiated browser action from the host's own UI (toolbar). The
 * `windowId` is the session id the view was grouped under, so the provider
 * can route the action to the right session.
 */
export type BrowserUserAction =
  | { readonly type: 'navigate'; readonly windowId: string; readonly url: string }
  | { readonly type: 'newTab'; readonly windowId: string; readonly url?: string }
  | { readonly type: 'activateTab'; readonly windowId: string; readonly viewId: string }
  | { readonly type: 'closeTab'; readonly windowId: string; readonly viewId: string }
  | { readonly type: 'back'; readonly windowId: string }
  | { readonly type: 'forward'; readonly windowId: string }
  | { readonly type: 'reload'; readonly windowId: string }

/**
 * A CDP-capable view handle. This is the subset of Electron's
 * `WebContents`/`WebContentsView` the provider drives; the shell's real
 * implementation adapts `webContents.debugger` to it.
 */
export interface ElectronViewHandle {
  /** Unique id of the backing view, used for diagnostics. */
  readonly id: string
  /**
   * Send one CDP command and resolve with its result. Rejects when the
   * debugger is not attached or the command fails.
   * @param method - CDP method, e.g. `Page.navigate`.
   * @param params - CDP command parameters.
   * @returns the CDP `result` object.
   */
  sendCommand(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>
}

/** One tab inside a session: its view plus a stable id. */
interface Tab {
  readonly id: string
  readonly handle: ElectronViewHandle
}

/** One live browser session: an ordered list of tabs, one active. */
interface Session {
  readonly id: BrowserSessionId
  /** Human-readable label (usually the DSH task/session id) for the window title. */
  readonly label?: string
  readonly tabs: Tab[]
  activeIndex: number
  /** Chronological operation log (navigate/execute/click/type/fill/download/auth). */
  readonly history: BrowserHistoryEntry[]
  /** Monotonic sequence counter for history entries (survives truncation). */
  nextSeq: number
}

/** Provider config: navigation admission defaults and snapshot caps. */
export interface ElectronBrowserProviderConfig {
  /** Allow navigation only to HTTP(S) URLs; reject anything else. Default true. */
  readonly httpOnly?: boolean
  /** Maximum snapshot elements before truncation. Default 60. */
  readonly snapshotMaxElements?: number
  /** Maximum content characters before truncation when no maxChars is given. Default 100_000. */
  readonly contentMaxChars?: number
  /**
   * Directory `browser_download` save paths must resolve inside (prevents a
   * prompt-injected agent from writing arbitrary machine paths). Default:
   * `~/Downloads`. NOTE: this default is a convenience, not a security
   * boundary — on Windows it may resolve to OneDrive/redirected paths;
   * a production deployment should set an explicit, verified path.
   */
  readonly downloadDir?: string
}

/**
 * CDP method/params for `Page.navigate`, as sent to {@link ElectronViewHandle.sendCommand}.
 */
export interface CdpNavigateParams {
  readonly url: string
}

/**
 * CDP method/params for `Input.dispatchMouseEvent` (a click press+release pair).
 */
export interface CdpMouseParams {
  readonly type: 'mousePressed' | 'mouseReleased'
  readonly x: number
  readonly y: number
  readonly button: 'left'
  readonly clickCount: number
}

/** CDP method/params for `Input.insertText`. */
export interface CdpInsertTextParams {
  readonly text: string
}

/** CDP method/params for `Runtime.evaluate`. */
export interface CdpEvaluateParams {
  readonly expression: string
  readonly returnByValue: boolean
  readonly awaitPromise?: boolean
}

/** CDP method for a full-page screenshot capture. */
export const CDP_PAGE_CAPTURE_SCREENSHOT = 'Page.captureScreenshot'

/** Native capture options the self-hosted view handle understands. */
export interface ScreenshotOptions {
  readonly format?: 'png' | 'jpeg'
  readonly quality?: number
  readonly maxWidth?: number
  readonly maxHeight?: number
}
/** CDP method for runtime evaluation (the execute path). */
export const CDP_RUNTIME_EVALUATE = 'Runtime.evaluate'
/** CDP method for navigation. */
export const CDP_PAGE_NAVIGATE = 'Page.navigate'

/** Cap on content returned by a snapshot fetch to keep the wire bounded. */
const SNAPSHOT_LABEL_MAX = 120

/** Named-key table for `key()`: CDP key/code names + Windows virtual key codes. */
const KEY_SPECS: Readonly<Record<string, { readonly key: string; readonly code: string; readonly vk: number; readonly text?: string }>> = {
  Enter: { key: 'Enter', code: 'Enter', vk: 13 },
  Tab: { key: 'Tab', code: 'Tab', vk: 9 },
  Escape: { key: 'Escape', code: 'Escape', vk: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  Delete: { key: 'Delete', code: 'Delete', vk: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  Home: { key: 'Home', code: 'Home', vk: 36 },
  End: { key: 'End', code: 'End', vk: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', vk: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', vk: 34 },
  // Space is the one printable key: CDP needs `text` on the keyDown for the
  // character to land in a focused input; without it the key only scrolls.
  Space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
}

/** Supported key names, exported for the tool's enum and error messages. */
export const BROWSER_KEY_NAMES: readonly string[] = Object.keys(KEY_SPECS)

/**
 * Browser provider over Electron views. Sessions hold an ordered list of
 * tabs; each tab is one view created by the host. The active tab receives
 * every operation; switching tabs calls the host's optional `showView` and
 * never loses state. Navigation is admitted only for HTTP(S) targets unless
 * {@link ElectronBrowserProviderConfig.httpOnly} is disabled.
 */
export class ElectronBrowserProvider implements BrowserProvider {
  readonly id = ELECTRON_BROWSER_PROVIDER_ID

  private readonly sessions = new Map<BrowserSessionId, Session>()
  private readonly httpOnly: boolean
  private readonly snapshotMaxElements: number
  private readonly contentMaxChars: number
  private readonly downloadDir: string | undefined

  constructor(
    private readonly host: ElectronBrowserViewHost,
    config: ElectronBrowserProviderConfig = {},
  ) {
    this.httpOnly = config.httpOnly ?? true
    this.snapshotMaxElements = config.snapshotMaxElements ?? 60
    this.contentMaxChars = config.contentMaxChars ?? 100_000
    // Confine downloads to a dedicated directory by default: the OS Downloads
    // folder is the human-visible, browser-natural place for downloaded files.
    this.downloadDir = config.downloadDir ?? join(homedir(), 'Downloads')
    // Route toolbar (host UI) actions into the session model: the human and
    // the agent then always drive the same tabs, history, and navigation.
    this.host.onUserAction?.(action => { void this.handleUserAction(action) })
  }

  /**
   * Usable when the host says it can back views (the self-hosted host probes
   * for a usable Electron binary; the desktop shell is assumed usable).
   */
  available(): boolean {
    return this.host.available?.() ?? true
  }

  /**
   * Open a NEW browser session with its own view. Every call mints a fresh
   * session id and backing view; per-task reuse is owned by the caller (the
   * tool layer caches one session per DSH task). Sessions are isolated from
   * each other: each keeps its own tabs, active tab, and history, and only
   * the active tab of a session is made visible.
   * @param label - optional human-readable label (e.g. the DSH task id) shown
   * in the window title so a human can tell which task's page is visible.
   */
  open(label?: string): Promise<BrowserSessionId> {
    const handle = this.host.createView()
    const id = `browser:${randomUUID()}`
    // Group the session's views under its own window (one window per
    // session), carrying the label for the window title. Hosts without
    // groupView keep the shared-window behavior.
    this.host.groupView?.(handle, id, label)
    this.sessions.set(id, { id, label, tabs: [{ id: `tab:${randomUUID()}`, handle }], activeIndex: 0, history: [], nextSeq: 1 })
    return Promise.resolve(id)
  }

  /** Open a URL in the active tab (default) or a new tab. */
  async openUrl(session: BrowserSessionId, request: BrowserOpenRequest, signal?: AbortSignal): Promise<void> {
    const s = this.session(session)
    if (request.newTab === true) {
      this.newTab(s)
    }
    await this.navigate(session, { url: request.url }, signal)
  }

  /** List the session's tabs with their titles. */
  async listTabs(session: BrowserSessionId): Promise<readonly BrowserTab[]> {
    const s = this.session(session)
    const result: BrowserTab[] = []
    for (let i = 0; i < s.tabs.length; i++) {
      const tab = s.tabs[i]
      if (tab === undefined) continue // defensive: array can shift under concurrency
      result.push({
        id: tab.id,
        url: await this.currentUrl(tab.handle).catch(() => ''),
        active: i === s.activeIndex,
      })
    }
    return result
  }

  /** Switch to a tab by id, making its view visible. */
  switchTab(session: BrowserSessionId, tabId: string): Promise<void> {
    const found = this.locateTab(session, tabId)
    found.s.activeIndex = found.index
    this.showActive(found.s)
    return Promise.resolve()
  }

  /** Close one tab; closing the active tab activates the next. */
  closeTab(session: BrowserSessionId, tabId: string): Promise<void> {
    const found = this.locateTab(session, tabId)
    const s = found.s
    const index = found.index
    const removed = s.tabs[index]
    if (removed !== undefined) {
      s.tabs.splice(index, 1)
      this.host.destroyView(removed.handle)
    }
    if (s.tabs.length === 0) {
      // Session keeps one blank tab so it stays usable.
      this.newTab(s)
    } else if (index < s.activeIndex) {
      // Closing a tab before the active one shifts the array left; keep the
      // same tab active by decrementing the index.
      s.activeIndex -= 1
    } else if (index === s.activeIndex) {
      // The active tab itself was closed; activate the next tab (the one that
      // shifted into its place), or the last one when the closed tab was the
      // last.
      s.activeIndex = Math.min(index, s.tabs.length - 1)
    }
    this.showActive(s)
    return Promise.resolve()
  }

  /**
   * Find a tab by id, preferring the calling session. Tab ids are globally
   * unique UUIDs, so when the calling session does not hold the tab (the tool
   * layer's session resolution can drift from the session that opened it),
   * fall back to locating it in any other session instead of failing — the
   * caller explicitly named a tab, so acting on it is what they want. Throws
   * BROWSER_TAB_UNKNOWN with the session's actual tabs when the id exists
   * nowhere.
   */
  private locateTab(session: BrowserSessionId, tabId: string): { s: Session; index: number } {
    const s = this.session(session)
    const own = s.tabs.findIndex(tab => tab.id === tabId)
    if (own >= 0) return { s, index: own }
    for (const other of this.sessions.values()) {
      const index = other.tabs.findIndex(tab => tab.id === tabId)
      if (index >= 0) return { s: other, index }
    }
    const ownIds = s.tabs.map(t => t.id).join(', ') || '(none)'
    throw new BrowserError(
      `browser: tab "${tabId}" is not open in this session (session tabs: ${ownIds})`,
      'BROWSER_TAB_UNKNOWN',
    )
  }

  /** Close every tab and reset to one blank tab. */
  reset(session: BrowserSessionId): Promise<void> {
    const s = this.session(session)
    for (const tab of s.tabs) this.host.destroyView(tab.handle)
    s.tabs.length = 0
    this.newTab(s)
    s.activeIndex = 0
    this.showActive(s)
    return Promise.resolve()
  }

  /** Navigate the active tab's view to a URL, honoring HTTP(S)-only admission. */
  async navigate(session: BrowserSessionId, request: { readonly url: string }, signal?: AbortSignal): Promise<void> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    const url = request.url
    try {
      if (this.httpOnly) {
        let parsed: URL
        try {
          parsed = new URL(url)
        } catch {
          throw new BrowserError(`browser: refusing navigation to unparseable URL "${url}"`, 'BROWSER_NAVIGATION_BLOCKED')
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          throw new BrowserError(`browser: refusing navigation to non-HTTP(S) URL "${url}"`, 'BROWSER_NAVIGATION_BLOCKED')
        }
      }
      signal?.throwIfAborted()
      // Page.navigate can hang on an unreachable/slow host; bound it like the
      // evaluate paths so a wedged navigation surfaces as an error instead of
      // blocking the tool call forever.
      const timeoutMs = 30_000
      const result = await withTimeout(
        handle.sendCommand(CDP_PAGE_NAVIGATE, { url } satisfies CdpNavigateParams),
        timeoutMs,
        signal,
        `browser: navigation timed out after ${timeoutMs}ms`,
        // Best-effort: cancel the in-flight navigation so a wedged load does
        // not leave the debugger queue busy.
        () => { void handle.sendCommand('Page.stopLoading').catch(() => {}) },
      )
      // Page.navigate resolves even when the navigation fails; surface the
      // failure instead of leaving a silent white screen.
      const errorText = (result as { errorText?: string }).errorText
      if (typeof errorText === 'string' && errorText !== '') {
        throw new BrowserError(`browser: navigation to "${url}" failed: ${errorText}`, 'BROWSER_NAVIGATION_FAILED')
      }
      this.record(s, 'navigate', { url }, true)
      this.showActive(s)
    } catch (error) {
      if (!(error instanceof BrowserError && (error as { code?: string }).code === 'BROWSER_NAVIGATION_BLOCKED')) {
        this.record(s, 'navigate', { url }, false, { error: String(error) })
      }
      throw error
    }
  }

  /** Execute JS in the active tab's page context. */
  async execute(session: BrowserSessionId, request: BrowserExecuteRequest, signal?: AbortSignal): Promise<BrowserExecuteResult> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    signal?.throwIfAborted()
    try {
      // Wrap the script in a Function so `return` statements are legal and
      // request.args arrive as `arguments[0..n]`. A bare script handed to CDP
      // Runtime.evaluate is an expression context — a leading `return` would
      // be a syntax error, and an object-literal script (`{...}`) would parse
      // as a block. So: if the script already starts with `return`, use it as
      // the body verbatim; otherwise wrap it as `return (expr)` so both
      // expression and object-literal forms evaluate to their value. Args are
      // embedded as a JSON array literal; unserializable members become null.
      const body = /^\s*return\b/.test(request.script)
        ? request.script
        : `return (${request.script})`
      const hasArgs = request.args !== undefined && request.args.length > 0
      const expression = hasArgs
        ? `(function(){ const __dshArgs = ${JSON.stringify(request.args)}; return Function(${JSON.stringify(body)}).apply(null, __dshArgs) })()`
        : `(function(){ return Function(${JSON.stringify(body)})() })()`
      // CDP Runtime.evaluate can hang indefinitely on a not-yet-loaded page
      // (navigate returned but the renderer has not committed). Bound it so a
      // stuck call surfaces as BROWSER_EXECUTE_TIMEOUT instead of wedging the
      // whole tool call. The caller's signal wins when it fires first.
      const timeoutMs = request.timeoutMs ?? 30_000
      const result = await withTimeout(
        handle.sendCommand(CDP_RUNTIME_EVALUATE, {
          expression,
          returnByValue: true,
          awaitPromise: true,
        } satisfies CdpEvaluateParams),
        timeoutMs,
        signal,
        `browser: execute timed out after ${timeoutMs}ms`,
        // Best-effort: kill the wedged page script so the renderer (and the
        // debugger queue) is not stuck behind a busy loop forever.
        () => terminatePage(handle),
      )
      if (result.exceptionDetails !== undefined) {
        const detail = result.exceptionDetails as { text?: string; exception?: { description?: string } }
        const exception = detail.exception?.description ?? detail.text ?? 'unknown exception'
        this.record(s, 'execute', { script: request.script }, false, { error: exception })
        return { ok: false, exception }
      }
      const value = (result.result as { value?: unknown } | undefined)?.value ?? null
      this.record(s, 'execute', {
        script: request.script,
        ...request.args !== undefined && request.args.length > 0 ? { args: request.args } : {},
      }, true, { result: typeof value === 'string' ? value.slice(0, 500) : JSON.stringify(value).slice(0, 500) })
      return { ok: true, value }
    } catch (error) {
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new BrowserError(`browser: execute timed out after ${request.timeoutMs ?? 30_000}ms`, 'BROWSER_EXECUTE_TIMEOUT', { cause: error })
      }
      throw new BrowserError(`browser: execute failed: ${String(error)}`, 'BROWSER_EXECUTE_FAILED', { cause: error })
    }
  }

  /**
   * Poll until the active tab's page is ready (and optional URL/selector
   * match), or the budget runs out. Returns a verdict instead of throwing on
   * timeout — the caller (model) decides what a miss means. Polling evaluates
   * in the CURRENT document, so after a navigation the old document may
   * briefly answer; pass the expected `url` to disambiguate.
   */
  async waitFor(session: BrowserSessionId, request: BrowserWaitRequest, signal?: AbortSignal): Promise<BrowserWaitResult> {
    const tab = this.activeTab(this.session(session))
    signal?.throwIfAborted()
    const timeoutMs = request.timeoutMs ?? 30_000
    const deadline = Date.now() + timeoutMs
    const url = request.url ?? ''
    const selector = request.selector ?? ''
    const checkLoaded = request.loaded !== false
    const expression = `(() => {
      const wantUrl = ${JSON.stringify(url)}
      const wantSelector = ${JSON.stringify(selector)}
      const inDoc = (doc, sel) => {
        if (doc.querySelector(sel)) return true
        for (const el of doc.querySelectorAll('iframe')) {
          try { const d = el.contentDocument; if (d && inDoc(d, sel)) return true } catch { /* cross-origin */ }
        }
        return false
      }
      const href = location.href
      // Exact match wins; otherwise prefix-match within the SAME origin only,
      // so wantUrl "https://a.com" never matches a cross-origin page whose
      // host merely starts with the same characters ("https://a.com.evil.com").
      let urlOk = wantUrl === '' || href === wantUrl
      if (!urlOk && wantUrl !== '') {
        try {
          const want = new URL(wantUrl)
          const got = new URL(href)
          urlOk = want.origin === got.origin && href.startsWith(wantUrl)
        } catch { urlOk = false }
      }
      const loadedOk = document.readyState === 'complete' || document.readyState === 'interactive'
      const foundOk = wantSelector === '' || inDoc(document, wantSelector)
      return { urlOk, loadedOk, foundOk }
    })()`
    for (;;) {
      const result = await withTimeout(
        handleSendEvaluate(tab.handle, expression),
        Math.min(5_000, Math.max(250, deadline - Date.now())),
        signal,
        'browser: wait poll timed out',
        () => terminatePage(tab.handle),
      )
      if (!result.ok) {
        throw new BrowserError(`browser: wait failed: ${result.exception}`, 'BROWSER_WAIT_FAILED')
      }
      const state = result.value as { urlOk: boolean; loadedOk: boolean; foundOk: boolean }
      const urlOk = url === '' || state.urlOk === true
      const loadedOk = !checkLoaded || state.loadedOk === true
      const foundOk = selector === '' || state.foundOk === true
      if (urlOk && loadedOk && foundOk) {
        return { ready: true, reason: 'condition met' }
      }
      if (Date.now() >= deadline) {
        const misses: string[] = []
        if (!urlOk) misses.push(`url not yet "${url}"`)
        if (!loadedOk) misses.push('page not loaded')
        if (!foundOk) misses.push(`selector "${selector}" not found`)
        return { ready: false, reason: misses.join('; ') }
      }
      // Sleep between polls, abortable by the caller.
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 200)
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason ?? new Error('aborted')) }, { once: true })
      })
    }
  }

  /** Produce an AI-friendly snapshot of the active tab. */
  async snapshot(session: BrowserSessionId, signal?: AbortSignal): Promise<BrowserSnapshotResult> {
    const s = this.session(session)
    const tab = this.activeTab(s)
    signal?.throwIfAborted()
    const script = `(() => {
      const cap = ${String(this.snapshotMaxElements)}
      const url = location.href
      const title = document.title || undefined
      // Collect interactive elements from the top document AND from shadow
      // roots and same-origin iframes (cross-origin iframes stay opaque — the
      // browser forbids reading them, and so does this snapshot). Elements
      // inside iframes carry a frame flag so the model knows DOM selectors
      // are frame-scoped; coordinates below are always top-document.
      const SELECTOR = 'input, textarea, select, button, a[href], [role="button"], [role="searchbox"], [contenteditable="true"]'
      const els = []
      const seen = new Set()
      const collect = (doc, inFrame) => {
        if (seen.has(doc)) return
        seen.add(doc)
        const hosts = []
        for (const el of doc.querySelectorAll('*')) {
          if (el.matches(SELECTOR)) els.push({ el, inFrame })
          if (el.shadowRoot) hosts.push({ doc: el.shadowRoot, inFrame })
          if (el.tagName === 'IFRAME') {
            try { const d = el.contentDocument; if (d) hosts.push({ doc: d, inFrame: true }) } catch { /* cross-origin */ }
          }
        }
        for (const h of hosts) collect(h.doc, h.inFrame)
      }
      collect(document, false)
      // Absolute viewport coordinates in the TOP document: iframe content is
      // offset by each ancestor iframe's rect, so coordinate clicks land on
      // the right element no matter which frame it lives in.
      const absRect = (el, doc) => {
        const r = el.getBoundingClientRect()
        let x = r.x, y = r.y
        let d = doc
        while (d && d.defaultView && d.defaultView.frameElement) {
          const fr = d.defaultView.frameElement.getBoundingClientRect()
          x += fr.x; y += fr.y
          d = d.defaultView.frameElement.ownerDocument
        }
        return { x, y, w: r.width, h: r.height }
      }
      const out = []
      for (const { el, inFrame } of els) {
        if (out.length >= cap) break
        const r = el.getBoundingClientRect()
        // Cheap layout check first; only force style recalc when it passes.
        if (r.width < 4 || r.height < 4) continue
        const cs = getComputedStyle(el)
        if (cs.visibility === 'hidden' || cs.display === 'none') continue
        const kind = el.tagName === 'INPUT' ? (el.type === 'checkbox' ? 'checkbox' : (el.type === 'submit' || el.type === 'button' ? 'button' : 'input'))
          : el.tagName === 'TEXTAREA' ? 'textarea'
          : el.tagName === 'SELECT' ? 'select'
          : el.tagName === 'BUTTON' ? 'button'
          : el.tagName === 'A' ? 'link' : 'other'
        const label = (el.getAttribute('aria-label') || el.placeholder || el.textContent || el.value || el.name || el.id || '').toString().replace(/\\s+/g, ' ').trim().slice(0, ${String(SNAPSHOT_LABEL_MAX)})
        if (!label && kind !== 'link') continue
        const a = absRect(el, el.ownerDocument)
        out.push({
          ref: out.length + 1,
          kind,
          label,
          selector: el.id ? '#' + CSS.escape(el.id) : (el.name ? '[name=' + JSON.stringify(el.name) + ']' : ''),
          x: Math.round(a.x + a.w / 2),
          y: Math.round(a.y + a.h / 2),
          ...inFrame ? { frame: true } : {},
        })
      }
      const challenge = ${CHALLENGE_DETECT_EXPRESSION}
      return { url, title, elements: out, truncated: out.length >= cap, challenge }
    })()`
    // Same hang guard as execute: a renderer that has not committed after
    // navigate would otherwise block snapshot forever.
    const timeoutMs = 30_000
    const result = await withTimeout(
      handleSendEvaluate(tab.handle, script),
      timeoutMs,
      signal,
      `browser: snapshot timed out after ${timeoutMs}ms`,
      () => terminatePage(tab.handle),
    )
    if (!result.ok) throw new BrowserError(`browser: snapshot evaluation failed: ${result.exception}`, 'BROWSER_SNAPSHOT_FAILED')
    const value = result.value as BrowserSnapshotResult
    return value
  }

  /**
   * Read the active tab's accessibility tree: semantic roles/names/states for
   * every interactive node (Chrome's `computedRole`/`computedName` when
   * available, tag/attribute inference otherwise). Pierces same-origin
   * iframes and shadow roots like the snapshot; cross-origin frames stay
   * opaque. Coordinates are top-document viewport-relative, so a node can
   * also be driven by click/type.
   */
  async a11y(session: BrowserSessionId, request: BrowserA11yRequest, signal?: AbortSignal): Promise<BrowserA11yResult> {
    const s = this.session(session)
    const tab = this.activeTab(s)
    signal?.throwIfAborted()
    const includeHidden = request.includeHidden === true
    const maxNodes = Math.max(10, Math.min(5000, Math.floor(request.maxNodes ?? 500)))
    const script = `(() => {
      const includeHidden = ${String(includeHidden)}
      const maxNodes = ${String(maxNodes)}
      const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE'])
      const ACTIONABLE = new Set(['button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'slider', 'spinbutton', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'switch', 'option', 'summary', 'treeitem', 'scrollbar'])
      const CONTENT_NAMED = new Set(['button', 'link', 'heading', 'summary', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'treeitem', 'option', 'listitem', 'switch', 'checkbox', 'radio', 'searchbox', 'textbox'])
      const out = []
      const seen = new Set()
      const ownText = (el) => Array.from(el.childNodes).filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent || '').join('').trim()
      const visible = (el) => {
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        return r.width >= 4 && r.height >= 4 && cs.visibility !== 'hidden' && cs.display !== 'none'
      }
      const roleOf = (el) => {
        const computed = el.computedRole
        if (typeof computed === 'string' && computed && computed !== 'none' && computed !== 'generic') return computed
        const tag = el.tagName.toLowerCase()
        if (el instanceof HTMLAnchorElement) return el.hasAttribute('href') ? 'link' : 'generic'
        if (tag === 'button') return 'button'
        if (tag === 'textarea') return 'textbox'
        if (tag === 'select') return el.hasAttribute('multiple') ? 'listbox' : 'combobox'
        if (tag === 'img') return el.getAttribute('alt') === '' ? 'presentation' : 'img'
        if (/^h[1-6]$/.test(tag)) return 'heading'
        if (tag === 'ul' || tag === 'ol') return 'list'
        if (tag === 'li') return 'listitem'
        if (tag === 'nav') return 'navigation'
        if (tag === 'main') return 'main'
        if (tag === 'form') return 'form'
        if (tag === 'table') return 'table'
        if (tag === 'tr') return 'row'
        if (tag === 'td') return 'cell'
        if (tag === 'th') return 'columnheader'
        if (tag === 'dialog') return 'dialog'
        if (tag === 'summary') return 'button'
        if (tag === 'input') {
          const t = el.type
          if (t === 'checkbox') return 'checkbox'
          if (t === 'radio') return 'radio'
          if (t === 'range') return 'slider'
          if (t === 'number') return 'spinbutton'
          if (t === 'button' || t === 'submit' || t === 'reset' || t === 'image') return 'button'
          if (t === 'hidden') return 'none'
          if (t === 'search') return 'searchbox'
          return 'textbox'
        }
        return 'generic'
      }
      const nameOf = (el, role) => {
        const computed = el.computedName
        if (typeof computed === 'string' && computed && computed.trim() !== '') return computed.trim()
        const aria = el.getAttribute('aria-label')
        if (aria) return aria
        const labelledby = el.getAttribute('aria-labelledby')
        if (labelledby) {
          const ref = document.getElementById(labelledby.split(/\\s+/)[0])
          if (ref) {
            const t = (ref.textContent || '').trim()
            if (t) return t
          }
        }
        if (el.hasAttribute('alt')) return el.getAttribute('alt')
        if (el.hasAttribute('title')) return el.getAttribute('title')
        if (el.placeholder) return el.placeholder
        if (CONTENT_NAMED.has(role)) {
          const t = ownText(el)
          if (t) return t
        }
        if (el.id) {
          const lbl = document.querySelector('label[for=' + JSON.stringify(el.id) + ']')
          if (lbl) {
            const t = (lbl.textContent || '').trim()
            if (t) return t
          }
        }
        return ''
      }
      const valueOf = (el) => {
        if (el instanceof HTMLInputElement) return el.type === 'checkbox' || el.type === 'radio' ? null : el.value
        if (el instanceof HTMLTextAreaElement) return el.value
        if (el instanceof HTMLSelectElement) {
          const o = el.options[el.selectedIndex]
          return o ? (o.textContent || '').trim() : null
        }
        if (el.isContentEditable) return (el.textContent || '').trim()
        return null
      }
      const statesOf = (el) => {
        const st = []
        if (!el.disabled) st.push('enabled'); else st.push('disabled')
        if (el.checked) st.push('checked'); else if (el.getAttribute('aria-checked') === 'false') st.push('unchecked')
        const expanded = el.getAttribute('aria-expanded')
        if (expanded === 'true') st.push('expanded')
        if (expanded === 'false') st.push('collapsed')
        if (el.required) st.push('required')
        if (el.readOnly) st.push('readonly')
        if (el.selected) st.push('selected')
        const pressed = el.getAttribute('aria-pressed')
        if (pressed === 'true') st.push('pressed')
        return st
      }
      const depthOf = (el) => {
        let d = 0
        let p = el.parentElement
        while (p) { d++; p = p.parentElement }
        return d
      }
      const absRect = (el, doc) => {
        const r = el.getBoundingClientRect()
        let x = r.x, y = r.y
        let d = doc
        while (d && d.defaultView && d.defaultView.frameElement) {
          const fr = d.defaultView.frameElement.getBoundingClientRect()
          x += fr.x; y += fr.y
          d = d.defaultView.frameElement.ownerDocument
        }
        return { x, y, w: r.width, h: r.height }
      }
      const walk = (doc, inFrame, baseDepth) => {
        if (seen.has(doc)) return
        seen.add(doc)
        for (const el of doc.querySelectorAll('*')) {
          if (out.length >= maxNodes) return
          if (SKIP.has(el.tagName)) continue
          if (el.shadowRoot) walk(el.shadowRoot, inFrame, baseDepth + 1)
          if (el.tagName === 'IFRAME') {
            try { const d = el.contentDocument; if (d) walk(d, true, baseDepth + 1) } catch { /* cross-origin */ }
          }
          const role = roleOf(el)
          if (role === 'none' || role === 'presentation' || role === 'generic') continue
          if (!includeHidden && !visible(el)) continue
          const name = nameOf(el, role)
          if (!name && !ACTIONABLE.has(role)) continue
          const a = absRect(el, el.ownerDocument)
          out.push({
            ref: out.length + 1,
            role,
            name: name.slice(0, 120),
            value: valueOf(el),
            states: statesOf(el),
            depth: baseDepth + depthOf(el),
            tag: el.tagName.toLowerCase(),
            x: Math.round(a.x + a.w / 2),
            y: Math.round(a.y + a.h / 2),
            ...inFrame ? { frame: true } : {},
          })
        }
      }
      walk(document, false, 0)
      return { url: location.href, title: document.title || undefined, count: out.length, nodes: out, truncated: out.length >= maxNodes }
    })()`
    const timeoutMs = 30_000
    const result = await withTimeout(
      handleSendEvaluate(tab.handle, script),
      timeoutMs,
      signal,
      `browser: a11y timed out after ${timeoutMs}ms`,
      () => terminatePage(tab.handle),
    )
    if (!result.ok) throw new BrowserError(`browser: a11y evaluation failed: ${result.exception}`, 'BROWSER_A11Y_FAILED')
    const value = result.value as BrowserA11yResult
    this.record(s, 'a11y', { includeHidden, maxNodes }, true, { result: `${value.count} nodes` })
    return value
  }

  /** Check whether a human-verification challenge is blocking the active tab. */
  async detectChallenge(session: BrowserSessionId, signal?: AbortSignal): Promise<BrowserChallenge> {
    const s = this.session(session)
    const tab = this.activeTab(s)
    signal?.throwIfAborted()
    const timeoutMs = 15_000
    const result = await withTimeout(
      handleSendEvaluate(tab.handle, CHALLENGE_DETECT_EXPRESSION),
      timeoutMs,
      signal,
      `browser: challenge detection timed out after ${timeoutMs}ms`,
      () => terminatePage(tab.handle),
    )
    if (!result.ok) {
      throw new BrowserError(`browser: challenge detection failed: ${result.exception}`, 'BROWSER_CHALLENGE_DETECT_FAILED')
    }
    const value = result.value as BrowserChallenge
    return { blocked: value.blocked === true, kind: value.kind, reason: value.reason }
  }

  /** Fetch page content in a requested format. */
  async content(session: BrowserSessionId, request: BrowserContentRequest, signal?: AbortSignal): Promise<BrowserContentResult> {
    const tab = this.activeTab(this.session(session))
    signal?.throwIfAborted()
    const maxChars = request.maxChars ?? this.contentMaxChars
    const selector = request.selector ?? ''
    const format = request.format
    const script = `(() => {
      const root = ${selector === '' ? 'document.body' : `document.querySelector(${JSON.stringify(selector)})`}
      if (!root) return { ok: false, reason: 'selector not found' }
      const fmt = ${JSON.stringify(format)}
      // Both walkers pierce shadow roots and same-origin iframes (cross-origin
      // iframes stay opaque — the browser forbids reading them).
      let content = ''
      if (fmt === 'txt') {
        const parts = []
        const textWalk = (node) => {
          if (node.nodeType === Node.TEXT_NODE) { const t = (node.textContent || '').trim(); if (t) parts.push(t); return }
          if (node.nodeType !== Node.ELEMENT_NODE) return
          const tag = node.tagName.toLowerCase()
          if (tag === 'script' || tag === 'style' || tag === 'noscript') return
          if (tag === 'iframe') {
            try { const d = node.contentDocument; if (d && d.body) for (const c of d.body.childNodes) textWalk(c) } catch { /* cross-origin */ }
            return
          }
          if (node.shadowRoot) for (const c of node.shadowRoot.childNodes) textWalk(c)
          for (const child of node.childNodes) textWalk(child)
        }
        textWalk(root)
        content = parts.join(' ')
      }
      else if (fmt === 'html') content = root.outerHTML || ''
      else if (fmt === 'json') content = JSON.stringify(root)
      else {
        // markdown: headings, paragraphs, links, lists (best-effort)
        const parts = []
        const walk = (node) => {
          if (node.nodeType === Node.TEXT_NODE) { const t = (node.textContent || '').trim(); if (t) parts.push(t); return }
          if (node.nodeType !== Node.ELEMENT_NODE) return
          const tag = node.tagName.toLowerCase()
          if (tag === 'script' || tag === 'style' || tag === 'noscript') return
          if (tag === 'iframe') {
            try { const d = node.contentDocument; if (d && d.body) for (const c of d.body.childNodes) walk(c) } catch { /* cross-origin */ }
            return
          }
          if (node.shadowRoot) for (const c of node.shadowRoot.childNodes) walk(c)
          if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4') parts.push('\\n' + '#'.repeat(Number(tag[1])) + ' ' + (node.textContent || '').trim() + '\\n')
          else if (tag === 'a') { const t = (node.textContent || '').trim(); if (t) parts.push('[' + t + '](' + (node.href || '') + ')') }
          else if (tag === 'li') parts.push('  - ' + (node.textContent || '').trim())
          else if (tag === 'p' || tag === 'div' || tag === 'section' || tag === 'article') { const t = (node.textContent || '').trim(); if (t) parts.push(t + '\\n') }
          else { for (const child of node.childNodes) walk(child) }
        }
        walk(root)
        // Join without a separator: each part already carries its own trailing
        // newline, so a space join would smear headings/links into run-on text.
        content = parts.join('')
      }
      const truncated = content.length > ${String(maxChars)}
      return { ok: true, content: content.slice(0, ${String(maxChars)}), truncated }
    })()`
    // Honor a per-call timeout: content evaluation can hang on a heavy page,
    // so a caller-supplied budget bounds it. Unlike a bare signal entry check,
    // withTimeout also interrupts a call already in flight.
    const timeoutMs = request.timeoutMs ?? 30_000
    const result = await withTimeout(
      handleSendEvaluate(tab.handle, script),
      timeoutMs,
      signal,
      `browser: content timed out after ${timeoutMs}ms`,
      () => terminatePage(tab.handle),
    )
    if (!result.ok) throw new BrowserError(`browser: content evaluation failed: ${result.exception}`, 'BROWSER_CONTENT_FAILED')
    const value = result.value as { ok: boolean; reason?: string; content?: string; truncated?: boolean }
    if (!value.ok) throw new BrowserError(`browser: content fetch failed: ${value.reason ?? 'unknown'}`, 'BROWSER_CONTENT_FAILED')
    return { content: value.content ?? '', truncated: value.truncated ?? false }
  }

  /**
   * Click at viewport coordinates, or at a located element's center when a
   * `target` (css/text/xpath) is given. CDP mousePressed + mouseReleased.
   */
  async click(
    session: BrowserSessionId,
    request: BrowserClickRequest | { readonly target: BrowserElementTarget },
    signal?: AbortSignal,
  ): Promise<void> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    signal?.throwIfAborted()
    let x = 0
    let y = 0
    if ('target' in request) {
      // Semantic targeting (②): locate the element in-page, scroll it into
      // view, and click its center — no coordinate guessing needed.
      const locateMs = 10_000
      const body = `
        el.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' })
        const r = el.getBoundingClientRect()
        return { ok: true, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
      `
      const script = this.buildTargetScript(request.target, locateMs, body)
      const out = await this.runTargetScript(this.activeTab(s), script, locateMs, signal, 'BROWSER_CLICK_FAILED', 'browser: click')
      x = Number(out.x)
      y = Number(out.y)
    } else {
      x = request.x
      y = request.y
    }
    const press = (type: 'mousePressed' | 'mouseReleased'): Promise<Record<string, unknown>> =>
      handle.sendCommand('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 } satisfies CdpMouseParams)
    const timeoutMs = 30_000
    try {
      await withTimeout(press('mousePressed'), timeoutMs, signal, `browser: click press timed out after ${timeoutMs}ms`)
    } catch (error) {
      // The press may still land late; release best-effort so the button is
      // never left in a stuck pressed state.
      void press('mouseReleased').catch(() => {})
      throw new BrowserError(`browser: click failed: ${String(error)}`, 'BROWSER_CLICK_FAILED', { cause: error })
    }
    try {
      await withTimeout(press('mouseReleased'), timeoutMs, signal, `browser: click release timed out after ${timeoutMs}ms`)
    } catch (error) {
      // The press already landed; retry the release so the button is not
      // left pressed before surfacing the failure.
      void press('mouseReleased').catch(() => {})
      throw new BrowserError(`browser: click failed: ${String(error)}`, 'BROWSER_CLICK_FAILED', { cause: error })
    }
    this.record(s, 'click', 'target' in request ? { target: request.target } : { x, y }, true)
  }

  /**
   * Type into the focused element, or focus a located element (css/text/xpath)
   * first and then insert the text.
   */
  async type(
    session: BrowserSessionId,
    request: BrowserTypeRequest | { readonly target: BrowserElementTarget },
    signal?: AbortSignal,
  ): Promise<void> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    signal?.throwIfAborted()
    const hasTarget = 'target' in request
    if (hasTarget) {
      const locateMs = 10_000
      const script = this.buildTargetScript(request.target, locateMs, `
        el.focus()
        return { ok: true }
      `)
      await this.runTargetScript(this.activeTab(s), script, locateMs, signal, 'BROWSER_TYPE_FAILED', 'browser: type')
    }
    const text = 'text' in request ? request.text : ''
    const timeoutMs = 30_000
    try {
      await withTimeout(
        handle.sendCommand('Input.insertText', { text } satisfies CdpInsertTextParams),
        timeoutMs,
        signal,
        `browser: type timed out after ${timeoutMs}ms`,
      )
    } catch (error) {
      throw new BrowserError(`browser: type failed: ${String(error)}`, 'BROWSER_TYPE_FAILED', { cause: error })
    }
    // Store the full text so replay re-issues the same input; the history
    // tool truncates long values when rendering.
    this.record(s, 'type', { text, ...hasTarget ? { target: request.target } : {} }, true)
  }

  /** Scroll the page: by deltas, to a selector, or to top/bottom. */
  async scroll(session: BrowserSessionId, request: BrowserScrollRequest, signal?: AbortSignal): Promise<void> {
    const s = this.session(session)
    const tab = this.activeTab(s)
    signal?.throwIfAborted()
    const selector = request.selector ?? ''
    const script = `(() => {
      const sel = ${JSON.stringify(selector)}
      if (sel !== '') {
        const el = document.querySelector(sel)
        if (!el) return { ok: false, reason: 'selector not found' }
        el.scrollIntoView({ behavior: 'instant', block: 'center' })
        return { ok: true }
      }
      if (${request.toTop === true}) { window.scrollTo(0, 0); return { ok: true } }
      if (${request.toBottom === true}) { window.scrollTo(0, document.body.scrollHeight); return { ok: true } }
      window.scrollBy({ top: ${request.deltaY ?? 0}, left: ${request.deltaX ?? 0} })
      return { ok: true }
    })()`
    const timeoutMs = 15_000
    const result = await withTimeout(
      handleSendEvaluate(tab.handle, script),
      timeoutMs,
      signal,
      `browser: scroll timed out after ${timeoutMs}ms`,
      () => terminatePage(tab.handle),
    )
    if (!result.ok) throw new BrowserError(`browser: scroll failed: ${result.exception}`, 'BROWSER_SCROLL_FAILED')
    const value = result.value as { ok?: boolean; reason?: string }
    if (value.ok !== true) throw new BrowserError(`browser: scroll failed: ${value.reason ?? 'unknown'}`, 'BROWSER_SCROLL_FAILED')
    this.record(s, 'scroll', { ...request }, true)
  }

  /** Go back (-1) or forward (+1) in the active tab's navigation history. */
  private async historyStep(session: BrowserSessionId, direction: -1 | 1, signal?: AbortSignal): Promise<void> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    signal?.throwIfAborted()
    const timeoutMs = 30_000
    const hist = await withTimeout(
      handle.sendCommand('Page.getNavigationHistory'),
      timeoutMs,
      signal,
      `browser: history read timed out after ${timeoutMs}ms`,
    ) as { entries?: Array<{ id?: number }>; currentIndex?: number }
    const entries = hist.entries ?? []
    const currentIndex = hist.currentIndex ?? -1
    const target = currentIndex + direction
    if (target < 0 || target >= entries.length) {
      // Nothing to step to; treat it as a successful no-op so the agent can
      // proceed without an error dance.
      this.record(s, direction === -1 ? 'back' : 'forward', {}, true)
      return
    }
    const entry = entries[target]
    if (entry?.id === undefined) throw new BrowserError('browser: history entry missing id', 'BROWSER_HISTORY_INVALID')
    await withTimeout(
      handle.sendCommand('Page.navigateToHistoryEntry', { entryId: entry.id }),
      timeoutMs,
      signal,
      `browser: history navigation timed out after ${timeoutMs}ms`,
      () => { void handle.sendCommand('Page.stopLoading').catch(() => {}) },
    )
    this.record(s, direction === -1 ? 'back' : 'forward', {}, true)
    this.showActive(s)
  }

  /** Go back in the active tab's history. */
  async back(session: BrowserSessionId, signal?: AbortSignal): Promise<void> {
    return this.historyStep(session, -1, signal)
  }

  /** Go forward in the active tab's history. */
  async forward(session: BrowserSessionId, signal?: AbortSignal): Promise<void> {
    return this.historyStep(session, 1, signal)
  }

  /** Reload the active tab. */
  async reload(session: BrowserSessionId, signal?: AbortSignal): Promise<void> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    signal?.throwIfAborted()
    const timeoutMs = 30_000
    await withTimeout(
      handle.sendCommand('Page.reload', { ignoreCache: false }),
      timeoutMs,
      signal,
      `browser: reload timed out after ${timeoutMs}ms`,
      // Best-effort: cancel the reload if it wedges the debugger queue.
      () => { void handle.sendCommand('Page.stopLoading').catch(() => {}) },
    )
    this.record(s, 'reload', {}, true)
    this.showActive(s)
  }

  /** Press one named key (Enter/Tab/arrows/…) via CDP key events. */
  async key(session: BrowserSessionId, request: BrowserKeyRequest, signal?: AbortSignal): Promise<void> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    signal?.throwIfAborted()
    const spec = KEY_SPECS[request.key]
    if (spec === undefined) {
      throw new BrowserError(`browser: unsupported key "${request.key}" (supported: ${BROWSER_KEY_NAMES.join(', ')})`, 'BROWSER_KEY_UNSUPPORTED')
    }
    const params = { key: spec.key, code: spec.code, windowsVirtualKeyCode: spec.vk, nativeVirtualKeyCode: spec.vk, ...spec.text !== undefined ? { text: spec.text } : {} }
    const timeoutMs = 15_000
    const release = (): Promise<Record<string, unknown>> =>
      handle.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
    try {
      await withTimeout(handle.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', ...params }), timeoutMs, signal, `browser: key press timed out after ${timeoutMs}ms`)
    } catch (error) {
      // The press may still land late; release best-effort so the key is
      // never left in a stuck pressed state.
      void release().catch(() => {})
      throw new BrowserError(`browser: key "${request.key}" failed: ${String(error)}`, 'BROWSER_KEY_FAILED', { cause: error })
    }
    try {
      await withTimeout(release(), timeoutMs, signal, `browser: key release timed out after ${timeoutMs}ms`)
    } catch (error) {
      // The press already landed; retry the release before surfacing.
      void release().catch(() => {})
      throw new BrowserError(`browser: key "${request.key}" failed: ${String(error)}`, 'BROWSER_KEY_FAILED', { cause: error })
    }
    this.record(s, 'key', { key: request.key }, true)
  }

  /**
   * Fill a form's fields in one batch. Runs one page-context script that
   * resolves each field (selector, or name/label/placeholder among visible
   * controls), sets its value with the native prototype setter (React/Vue
   * controlled inputs included) plus input/change events, handles
   * select/checkbox/radio/contenteditable, and optionally submits the form.
   */
  async fillForm(session: BrowserSessionId, request: BrowserFillRequest, signal?: AbortSignal): Promise<BrowserFillResult> {
    const s = this.session(session)
    const tab = this.activeTab(s)
    signal?.throwIfAborted()
    const specs = JSON.stringify(request.fields.map(f => ({
      selector: f.selector ?? null,
      name: f.name ?? null,
      label: f.label ?? null,
      placeholder: f.placeholder ?? null,
      kind: f.kind ?? 'text',
      value: f.value,
    })))
    const submitFlag = request.submit === true
    const script = `(() => {
      const specs = ${specs}
      const out = []
      const setNative = (el, proto, value) => {
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
        if (setter) setter.call(el, value)
        else el.value = value
      }
      const visible = (el) => {
        const r = el.getBoundingClientRect()
        const cs = getComputedStyle(el)
        return r.width >= 4 && r.height >= 4 && cs.visibility !== 'hidden' && cs.display !== 'none'
      }
      const describe = (spec) => spec.selector || spec.name || spec.label || spec.placeholder || '(unspecified)'
      const matches = (el, spec) => {
        if (spec.selector) { try { return el.matches(spec.selector) } catch { return false } }
        if (spec.name && el.name === spec.name) return true
        if (spec.placeholder && el.placeholder === spec.placeholder) return true
        if (spec.label) {
          if (el.getAttribute('aria-label') === spec.label) return true
          if (el.id) {
            const lbl = document.querySelector('label[for=' + JSON.stringify(el.id) + ']')
            if (lbl && (lbl.textContent || '').trim() === spec.label) return true
          }
          const wrap = el.closest('label')
          if (wrap && (wrap.textContent || '').trim() === spec.label) return true
        }
        return false
      }
      const candidates = (spec) => {
        const all = spec.selector
          ? [...document.querySelectorAll(spec.selector)]
          : [...document.querySelectorAll('input, textarea, select, [contenteditable="true"]')].filter(el => matches(el, spec))
        const vis = all.filter(visible)
        return vis.length > 0 ? vis : all
      }
      for (const spec of specs) {
        let els
        try {
          els = candidates(spec)
        } catch (e) {
          // A malformed selector must not abort the whole batch; report the
          // field as failed and continue with the rest.
          out.push({ ok: false, error: String(e), target: describe(spec) })
          continue
        }
        if (els.length === 0) { out.push({ ok: false, error: 'field not found', target: describe(spec) }); continue }
        const el = els[0]
        const tag = el.tagName
        const type = (el.type || '').toLowerCase()
        try {
          if (tag === 'SELECT') {
            const wanted = String(spec.value)
            if (el.multiple) {
              const wantedList = wanted.split(',').map(x => x.trim())
              let hit = false
              for (const o of [...el.options]) {
                o.selected = wantedList.includes(o.value) || wantedList.includes((o.textContent || '').trim())
                if (o.selected) hit = true
              }
              if (!hit) { out.push({ ok: false, error: 'option not found: ' + wanted, target: describe(spec) }); continue }
            } else {
              let opt = [...el.options].find(o => o.value === wanted)
              if (!opt) opt = [...el.options].find(o => (o.textContent || '').trim() === wanted)
              if (!opt) { out.push({ ok: false, error: 'option not found: ' + wanted, target: describe(spec) }); continue }
              setNative(el, HTMLSelectElement.prototype, opt.value)
            }
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
            out.push({ ok: true, method: 'select', target: describe(spec) })
          } else if (type === 'file') {
            out.push({ ok: false, error: 'file inputs cannot be set from script; use browser_download or ask the human', target: describe(spec) })
          } else if (type === 'checkbox') {
            const want = spec.value === true || spec.value === 'true' || spec.value === 'on'
            if (el.checked !== want) el.click()
            out.push({ ok: true, method: 'checkbox', target: describe(spec) })
          } else if (type === 'radio') {
            const wanted = String(spec.value)
            const radio = [...document.querySelectorAll('input[type="radio"][name=' + JSON.stringify(el.name || '') + ']')]
              .find(r => r.value === wanted || (r === el && (spec.value === true || spec.value === 'true')))
            if (!radio) { out.push({ ok: false, error: 'radio option not found: ' + wanted, target: describe(spec) }); continue }
            if (!radio.checked) radio.click()
            out.push({ ok: true, method: 'radio', target: describe(spec) })
          } else if (el.isContentEditable) {
            el.textContent = String(spec.value)
            el.dispatchEvent(new Event('input', { bubbles: true }))
            out.push({ ok: true, method: 'contenteditable', target: describe(spec) })
          } else if (tag === 'TEXTAREA') {
            setNative(el, HTMLTextAreaElement.prototype, String(spec.value))
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
            out.push({ ok: true, method: 'textarea', target: describe(spec) })
          } else {
            setNative(el, HTMLInputElement.prototype, String(spec.value))
            el.dispatchEvent(new Event('input', { bubbles: true }))
            el.dispatchEvent(new Event('change', { bubbles: true }))
            out.push({ ok: true, method: 'input', target: describe(spec) })
          }
        } catch (e) {
          out.push({ ok: false, error: String(e), target: describe(spec) })
        }
      }
      let submitted = false
      if (${submitFlag}) {
        let last = null
        for (const spec of specs) {
          try { const els = candidates(spec); if (els.length > 0) { last = els[0]; break } } catch { /* skip */ }
        }
        const form = last && (last.form || last.closest('form'))
        if (form) { form.requestSubmit(); submitted = true }
      }
      return { fields: out, submitted }
    })()`
    const timeoutMs = request.timeoutMs ?? 30_000
    const result = await withTimeout(
      handleSendEvaluate(tab.handle, script),
      timeoutMs,
      signal,
      `browser: fillForm timed out after ${timeoutMs}ms`,
      () => terminatePage(tab.handle),
    )
    if (!result.ok) {
      throw new BrowserError(`browser: fillForm evaluation failed: ${result.exception}`, 'BROWSER_FILL_FAILED')
    }
    const value = result.value as BrowserFillResult
    const okCount = value.fields.filter(f => f.ok).length
    this.record(s, 'fill', { fields: request.fields.length, submit: submitFlag }, okCount === value.fields.length, {
      result: `${okCount}/${value.fields.length} fields filled${value.submitted ? ', form submitted' : ''}`,
    })
    return { fields: value.fields, submitted: value.submitted === true }
  }

  /**
   * Build an in-page async IIFE that locates ONE element by css/text/xpath
   * (polling until it appears or the budget runs out) and then runs `body`
   * with `el` in scope. Shared by the target-based tools: click/type (②),
   * setValue/check/select/clear/getValue (③), and the scrape item wait.
   */
  private buildTargetScript(spec: BrowserElementTarget, timeoutMs: number, body: string): string {
    return `(async () => {
      const spec = ${JSON.stringify(spec)}
      const timeoutMs = ${String(timeoutMs)}
      const sleep = ms => new Promise(r => setTimeout(r, ms))
      const isVisible = el => el instanceof HTMLElement && (el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0)
      const ownText = el => Array.from(el.childNodes).filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent || '').join('').trim()
      const depth = el => { let d = 0; let p = el.parentElement; while (p) { d++; p = p.parentElement } return d }
      const match = () => {
        const by = typeof spec.by === 'string' ? spec.by : 'css'
        const value = String(spec.value ?? '')
        const index = typeof spec.index === 'number' ? spec.index : 0
        let els = []
        if (by === 'css') {
          try { els = Array.from(document.querySelectorAll(value)) } catch { return null }
        } else if (by === 'xpath') {
          try {
            const snap = document.evaluate(value, document, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null)
            for (let i = 0; i < snap.snapshotLength; i++) {
              const n = snap.snapshotItem(i)
              if (n instanceof Element) els.push(n)
            }
          } catch { return null }
        } else {
          const all = Array.from(document.querySelectorAll('body *'))
          const exact = all.filter(el => isVisible(el) && ownText(el) === value)
          // Exact first, then contains; deepest element preferred (so a
          // button inside a card wins over the card itself).
          const pool = exact.length > 0 ? exact : all.filter(el => isVisible(el) && ownText(el).includes(value))
          els = pool.sort((a, b) => depth(b) - depth(a))
        }
        return els[index] ?? null
      }
      const deadline = Date.now() + timeoutMs
      let el = null
      for (;;) {
        el = match()
        if (el !== null) break
        if (Date.now() >= deadline) return { ok: false, error: 'element not found: ' + JSON.stringify(spec) }
        await sleep(100)
      }
      ${body}
    })()`
  }

  /**
   * Shared evaluate wrapper for the target-based tools. Runs the in-page
   * script and returns its result object; throws a typed BrowserError on
   * evaluation failure or an in-page `{ ok: false, error }` verdict.
   */
  private async runTargetScript(
    tab: Tab,
    script: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
    errorCode: string,
    errorLabel: string,
  ): Promise<Record<string, unknown>> {
    const result = await withTimeout(
      handleSendEvaluate(tab.handle, script),
      timeoutMs,
      signal,
      `${errorLabel} timed out after ${timeoutMs}ms`,
      () => terminatePage(tab.handle),
    )
    if (!result.ok) throw new BrowserError(`${errorLabel} failed: ${result.exception}`, errorCode)
    const value = result.value as { ok?: boolean; error?: string } | undefined
    if (value?.ok !== true) throw new BrowserError(`${errorLabel} failed: ${value?.error ?? 'unknown'}`, errorCode)
    return value as Record<string, unknown>
  }

  /** Set one element's value (native setter + input/change, React-friendly). */
  async setValue(session: BrowserSessionId, request: BrowserSetValueRequest, signal?: AbortSignal): Promise<BrowserSetValueResult> {
    const s = this.session(session)
    const tab = this.activeTab(s)
    signal?.throwIfAborted()
    const timeoutMs = request.timeoutMs ?? 5_000
    const body = `
      const value = ${JSON.stringify(String(request.value))}
      const setNative = (el, proto, v) => {
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
        if (setter) setter.call(el, v)
        else el.value = v
      }
      const tag = el.tagName
      const type = (el.type || '').toLowerCase()
      if (tag === 'SELECT') {
        const wanted = value
        let opt = [...el.options].find(o => o.value === wanted)
        if (!opt) opt = [...el.options].find(o => (o.textContent || '').trim() === wanted)
        if (!opt) return { ok: false, error: 'option not found: ' + wanted }
        setNative(el, HTMLSelectElement.prototype, opt.value)
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return { ok: true, method: 'select', value: opt.value }
      }
      if (el.isContentEditable) {
        el.textContent = value
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return { ok: true, method: 'contenteditable', value }
      }
      if (tag === 'TEXTAREA') {
        setNative(el, HTMLTextAreaElement.prototype, value)
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
        return { ok: true, method: 'textarea', value }
      }
      setNative(el, HTMLInputElement.prototype, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return { ok: true, method: 'input', value }
    `
    const script = this.buildTargetScript(request.target, timeoutMs, body)
    const out = await this.runTargetScript(tab, script, timeoutMs, signal, 'BROWSER_SET_VALUE_FAILED', 'browser: setValue')
    this.record(s, 'setValue', { target: request.target, value: String(request.value) }, true, { result: out.method as string })
    return { method: out.method as string, value: out.value as string }
  }

  /** Check or uncheck one checkbox/radio. */
  async check(session: BrowserSessionId, request: BrowserCheckRequest, signal?: AbortSignal): Promise<{ readonly checked: boolean }> {
    const s = this.session(session)
    const tab = this.activeTab(s)
    signal?.throwIfAborted()
    const timeoutMs = request.timeoutMs ?? 5_000
    const want = request.checked ?? true
    const body = `
      const want = ${String(want)}
      const type = (el.type || '').toLowerCase()
      if (type === 'checkbox') {
        if (el.checked !== want) el.click()
        return { ok: true, checked: el.checked }
      }
      if (type === 'radio') {
        if (want && !el.checked) el.click()
        return { ok: true, checked: el.checked }
      }
      return { ok: false, error: 'element is not a checkbox or radio (' + el.tagName + ')' }
    `
    const script = this.buildTargetScript(request.target, timeoutMs, body)
    const out = await this.runTargetScript(tab, script, timeoutMs, signal, 'BROWSER_CHECK_FAILED', 'browser: check')
    this.record(s, 'check', { target: request.target, checked: want }, true)
    return { checked: out.checked === true }
  }

  /** Select one option of a <select>, by value, visible text, or index. */
  async selectOption(session: BrowserSessionId, request: BrowserSelectRequest, signal?: AbortSignal): Promise<BrowserSelectResult> {
    const s = this.session(session)
    const tab = this.activeTab(s)
    signal?.throwIfAborted()
    const timeoutMs = request.timeoutMs ?? 5_000
    const body = `
      if (el.tagName !== 'SELECT') return { ok: false, error: 'element is not a <select> (' + el.tagName + ')' }
      const optionValue = ${JSON.stringify(request.optionValue ?? null)}
      const optionText = ${JSON.stringify(request.optionText ?? null)}
      const optionIndex = ${String(request.optionIndex ?? -1)}
      let opt = null
      if (optionValue !== null) opt = [...el.options].find(o => o.value === optionValue)
      if (!opt && optionText !== null) opt = [...el.options].find(o => (o.textContent || '').trim() === optionText)
      if (!opt && optionIndex >= 0) opt = el.options[optionIndex] ?? null
      if (!opt) return { ok: false, error: 'option not found' }
      const setNative = (el, proto, v) => {
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
        if (setter) setter.call(el, v)
        else el.value = v
      }
      setNative(el, HTMLSelectElement.prototype, opt.value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
      return { ok: true, value: opt.value, text: (opt.textContent || '').trim() }
    `
    const script = this.buildTargetScript(request.target, timeoutMs, body)
    const out = await this.runTargetScript(tab, script, timeoutMs, signal, 'BROWSER_SELECT_FAILED', 'browser: select')
    this.record(s, 'select', { target: request.target, optionValue: request.optionValue ?? null, optionText: request.optionText ?? null, optionIndex: request.optionIndex ?? null }, true)
    return { value: out.value as string, text: out.text as string }
  }

  /** Clear one input/textarea/contenteditable (or uncheck a checkbox/radio). */
  async clearField(session: BrowserSessionId, request: BrowserClearRequest, signal?: AbortSignal): Promise<{ readonly cleared: boolean }> {
    const s = this.session(session)
    const tab = this.activeTab(s)
    signal?.throwIfAborted()
    const timeoutMs = request.timeoutMs ?? 5_000
    const body = `
      const setNative = (el, proto) => {
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
        if (setter) setter.call(el, '')
        else el.value = ''
      }
      if (el.isContentEditable) {
        el.textContent = ''
        el.dispatchEvent(new Event('input', { bubbles: true }))
      } else if (el.tagName === 'TEXTAREA') {
        setNative(el, HTMLTextAreaElement.prototype)
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
      } else if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
        if (el.checked) el.click()
      } else {
        setNative(el, HTMLInputElement.prototype)
        el.dispatchEvent(new Event('input', { bubbles: true }))
        el.dispatchEvent(new Event('change', { bubbles: true }))
      }
      return { ok: true }
    `
    const script = this.buildTargetScript(request.target, timeoutMs, body)
    await this.runTargetScript(tab, script, timeoutMs, signal, 'BROWSER_CLEAR_FAILED', 'browser: clear')
    this.record(s, 'clear', { target: request.target }, true)
    return { cleared: true }
  }

  /** Read one element's current value (for verification). */
  async getValue(session: BrowserSessionId, request: BrowserGetValueRequest, signal?: AbortSignal): Promise<BrowserGetValueResult> {
    const s = this.session(session)
    const tab = this.activeTab(s)
    signal?.throwIfAborted()
    const timeoutMs = request.timeoutMs ?? 5_000
    const body = `
      const type = (el.type || '').toLowerCase()
      if (type === 'checkbox' || type === 'radio') return { ok: true, value: null, checked: el.checked }
      if (el.tagName === 'SELECT') {
        const o = el.options[el.selectedIndex]
        return { ok: true, value: el.value, selectedText: o ? (o.textContent || '').trim() : null }
      }
      const v = el.value !== undefined ? el.value : el.textContent
      return { ok: true, value: v === undefined || v === null ? null : String(v) }
    `
    const script = this.buildTargetScript(request.target, timeoutMs, body)
    const out = await this.runTargetScript(tab, script, timeoutMs, signal, 'BROWSER_GET_VALUE_FAILED', 'browser: getValue')
    this.record(s, 'getValue', { target: request.target }, true)
    return {
      value: out.value === null || out.value === undefined ? null : String(out.value),
      ...out.checked !== undefined ? { checked: out.checked === true } : {},
      ...out.selectedText !== undefined && out.selectedText !== null ? { selectedText: String(out.selectedText) } : {},
    }
  }

  /**
   * Extract structured data from repeated DOM items (static CSS, CSP-safe —
   * no arbitrary code runs). Waits for the item selector, then maps each item
   * through the field selectors; `selector@attr` reads an attribute instead
   * of text (`a@href` yields an absolute URL).
   */
  async scrape(session: BrowserSessionId, request: BrowserScrapeRequest, signal?: AbortSignal): Promise<BrowserScrapeResult> {
    const s = this.session(session)
    const tab = this.activeTab(s)
    signal?.throwIfAborted()
    const timeoutMs = request.timeoutMs ?? 5_000
    const script = `(async () => {
      const itemSel = ${JSON.stringify(request.item)}
      const fields = ${JSON.stringify(request.fields)}
      const timeoutMs = ${String(timeoutMs)}
      const sleep = ms => new Promise(r => setTimeout(r, ms))
      const parseField = f => {
        const m = /^(.*)@([A-Za-z][A-Za-z0-9_-]*)$/.exec(f.selector.trim())
        if (m) return { base: m[1].trim(), attr: m[2] }
        return { base: f.selector, attr: null }
      }
      const deadline = Date.now() + timeoutMs
      let items = []
      for (;;) {
        try { items = Array.from(document.querySelectorAll(itemSel)) } catch (e) { return { ok: false, error: String(e) } }
        if (items.length > 0) break
        if (Date.now() >= deadline) return { ok: false, error: 'no elements matched: ' + itemSel }
        await sleep(100)
      }
      const out = []
      for (const it of items) {
        const row = {}
        for (const f of fields) {
          const { base, attr } = parseField(f)
          let el = null
          try { el = base === '' ? it : it.querySelector(base) } catch { el = null }
          if (!el) { row[f.name] = null; continue }
          if (attr !== null) {
            const v = el.getAttribute(attr)
            row[f.name] = attr === 'href' && el.tagName === 'A' && v ? new URL(v, location.href).href : v
            continue
          }
          row[f.name] = (el.textContent || '').trim()
        }
        out.push(row)
      }
      return { ok: true, count: out.length, items: out }
    })()`
    const result = await withTimeout(
      handleSendEvaluate(tab.handle, script),
      timeoutMs,
      signal,
      `browser: scrape timed out after ${timeoutMs}ms`,
      () => terminatePage(tab.handle),
    )
    if (!result.ok) throw new BrowserError(`browser: scrape evaluation failed: ${result.exception}`, 'BROWSER_SCRAPE_FAILED')
    const value = result.value as { ok?: boolean; error?: string; count?: number; items?: Record<string, string | null>[] }
    if (value.ok !== true) throw new BrowserError(`browser: scrape failed: ${value.error ?? 'unknown'}`, 'BROWSER_SCRAPE_FAILED')
    const items = value.items ?? []
    this.record(s, 'scrape', { item: request.item, fields: request.fields.map(f => f.name) }, true, { result: `${items.length} items` })
    return { count: items.length, items }
  }

  /**
   * Download a URL to a local file, keeping the session's cookies/login.
   * Requires the self-hosted host (which implements view-level download); the
   * desktop shell's embedded views delegate downloads to the real browser UI.
   * Admission: only HTTP(S) targets (the in-page fetch cannot meaningfully
   * fetch anything else), and the save path must be absolute — confined to
   * `downloadDir` when one is configured, so a prompt-injected agent cannot
   * write arbitrary machine paths.
   */
  async download(session: BrowserSessionId, request: { readonly url: string; readonly savePath: string }, signal?: AbortSignal): Promise<{ readonly path: string }> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    signal?.throwIfAborted()
    // URL admission: HTTP(S) only (mirrors the navigation guard). The seam
    // intentionally does not block private/localhost targets — a shared real
    // browser legitimately reaches local dev servers.
    let parsed: URL
    try {
      parsed = new URL(request.url)
    } catch {
      throw new BrowserError(`browser: refusing download of unparseable URL "${request.url}"`, 'BROWSER_DOWNLOAD_BLOCKED')
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new BrowserError(`browser: refusing download of non-HTTP(S) URL "${request.url}"`, 'BROWSER_DOWNLOAD_BLOCKED')
    }
    // savePath admission: must be absolute; when downloadDir is configured it
    // must resolve inside it (no ..-escape).
    if (!isAbsolute(request.savePath)) {
      throw new BrowserError('browser: download savePath must be an absolute path', 'BROWSER_DOWNLOAD_BLOCKED')
    }
    if (this.downloadDir !== undefined) {
      const dir = resolve(this.downloadDir)
      const file = resolve(request.savePath)
      // Case-insensitive comparison: Windows paths are case-insensitive, and
      // resolve() does not normalize case. Without this, C:\Users\X\Downloads
      // and c:\users\x\downloads would be treated as different roots.
      const dirLower = dir.toLowerCase()
      const fileLower = file.toLowerCase()
      if (fileLower !== dirLower && !fileLower.startsWith(dirLower + sep.toLowerCase())) {
        throw new BrowserError(`browser: download savePath must be inside downloadDir "${dir}"`, 'BROWSER_DOWNLOAD_BLOCKED')
      }
    }
    const downloadable = handle as { download?(url: string, savePath: string): Promise<void> }
    if (typeof downloadable.download !== 'function') {
      throw new BrowserError('browser: download is only available on the self-hosted browser', 'BROWSER_DOWNLOAD_UNSUPPORTED')
    }
    // The child fetches and writes the file; a slow/hung network can block
    // it well past the tool budget, so bound it. NOTE: unlike CDP calls,
    // there is no child-side abort mechanism for the RPC download — when the
    // parent's timeout fires the child continues writing. The parent's pending
    // entry is cleaned up (the promise settles) and the child's eventual
    // reply is harmlessly consumed by the RPC layer.
    const timeoutMs = 60_000
    await withTimeout(
      downloadable.download(request.url, request.savePath),
      timeoutMs,
      signal,
      `browser: download timed out after ${timeoutMs}ms`,
    )
    this.record(s, 'download', { url: request.url, savePath: request.savePath }, true, { result: request.savePath })
    return { path: request.savePath }
  }

  /**
   * Export the session's cookies (login state) as serializable objects.
   * Self-hosted only; the desktop shell's embedded views use the real profile.
   */
  async flushAuth(session: BrowserSessionId): Promise<readonly ExportedCookie[]> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    const host = handle as { flushAuth?(): Promise<ExportedCookie[]> }
    if (typeof host.flushAuth !== 'function') {
      throw new BrowserError('browser: auth export is only available on the self-hosted browser', 'BROWSER_AUTH_UNSUPPORTED')
    }
    const timeoutMs = 30_000
    const cookies = await withTimeout(host.flushAuth(), timeoutMs, undefined, `browser: auth export timed out after ${timeoutMs}ms`)
    this.record(s, 'flushAuth', {}, true, { result: `${cookies.length} cookies` })
    return cookies
  }

  /** Import cookies into the session (restore login state). Self-hosted only. */
  async restoreAuth(session: BrowserSessionId, cookies: readonly ExportedCookie[]): Promise<number> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    const host = handle as { restoreAuth?(cookies: readonly ExportedCookie[]): Promise<number> }
    if (typeof host.restoreAuth !== 'function') {
      throw new BrowserError('browser: auth restore is only available on the self-hosted browser', 'BROWSER_AUTH_UNSUPPORTED')
    }
    const timeoutMs = 30_000
    const restored = await withTimeout(host.restoreAuth(cookies), timeoutMs, undefined, `browser: auth restore timed out after ${timeoutMs}ms`)
    this.record(s, 'restoreAuth', { count: cookies.length }, true, { result: `${restored} cookies` })
    return restored
  }

  /** Capture the current page, optionally full-page, PNG or JPEG, scalable. */
  async screenshot(
    session: BrowserSessionId,
    request?: BrowserScreenshotRequest,
    signal?: AbortSignal,
  ): Promise<{ readonly dataUrl: string; readonly path?: string }> {
    const s = this.session(session)
    const { handle } = this.activeTab(s)
    signal?.throwIfAborted()
    const format = request?.format ?? 'png'
    // Native capturePage path (self-hosted): CDP Page.captureScreenshot can
    // hang indefinitely on a view once another (hidden) WebContentsView exists
    // in the window; capturePage is fast for visible views and resolves
    // immediately (empty) for hidden ones. JPEG and downscaling are encoded
    // in the child from the NativeImage, so this path is the only one that
    // can produce JPEG (CDP JPEG hangs on Electron 43).
    const capturable = handle as { capture?(opts?: ScreenshotOptions): Promise<{ base64: string; mime: string }> }
    if (request?.fullPage !== true && typeof capturable.capture === 'function') {
      // Ensure the target view is the visible one before capturing.
      this.showActive(s)
      const timeoutMs = 30_000
      const shot = await withTimeout(
        capturable.capture({
          ...format === 'jpeg' ? { format, quality: request?.quality } : {},
          ...request?.maxWidth !== undefined ? { maxWidth: request.maxWidth } : {},
          ...request?.maxHeight !== undefined ? { maxHeight: request.maxHeight } : {},
        }),
        timeoutMs,
        signal,
        `browser: screenshot timed out after ${timeoutMs}ms`,
      )
      if (shot.base64 === '') {
        throw new BrowserError('browser: capture returned an empty image (view not painted); retry shortly', 'BROWSER_SCREENSHOT_FAILED')
      }
      return this.saveScreenshot(shot.base64, request?.savePath, shot.mime ?? 'image/png')
    }
    // Fallback: a desktop-shell handle (no capture()) or a full-page capture
    // uses CDP; full-page needs `captureBeyondViewport` which capturePage
    // lacks. PNG only — the JPEG hang is a CDP-on-Electron-43 defect.
    const params: Record<string, unknown> = {}
    if (request?.fullPage === true) {
      // `captureBeyondViewport` captures the full scrollable content; without
      // a clip this yields the full-page image (CDP default is the viewport).
      params.captureBeyondViewport = true
    }
    const timeoutMs = 30_000
    const result = await withTimeout(
      handle.sendCommand(CDP_PAGE_CAPTURE_SCREENSHOT, params),
      timeoutMs,
      signal,
      `browser: screenshot timed out after ${timeoutMs}ms`,
    )
    const data = result.data
    if (typeof data !== 'string') {
      throw new BrowserError('browser: screenshot returned no image data', 'BROWSER_SCREENSHOT_FAILED')
    }
    return this.saveScreenshot(data, request?.savePath, 'image/png')
  }

  /** Build the data URL and optionally write the image to disk. */
  private saveScreenshot(base64: string, savePath: string | undefined, mime: string): { dataUrl: string; path?: string } {
    if (savePath !== undefined) {
      try {
        writeFileSync(savePath, Buffer.from(base64, 'base64'))
        return { dataUrl: `data:${mime};base64,${base64}`, path: savePath }
      } catch (error) {
        // Report the write problem but keep the capture usable.
        throw new BrowserError(`browser: screenshot save to "${savePath}" failed: ${String(error)}`, 'BROWSER_SCREENSHOT_SAVE_FAILED', { cause: error })
      }
    }
    return { dataUrl: `data:${mime};base64,${base64}` }
  }

  /** Append one operation to the session's history. */
  private record(
    s: Session,
    action: string,
    params: Record<string, unknown>,
    ok: boolean,
    detail?: { result?: string; error?: string },
  ): void {
    const entry: BrowserHistoryEntry = {
      seq: s.nextSeq++,
      action,
      params,
      ok,
      ...detail?.result !== undefined ? { result: detail.result } : {},
      ...detail?.error !== undefined ? { error: detail.error } : {},
      at: Date.now(),
    }
    s.history.push(entry)
    // Bound memory: keep the last 500 operations.
    if (s.history.length > 500) s.history.splice(0, s.history.length - 500)
  }

  /** Return the session's chronological operation log (newest last). */
  async history(session: BrowserSessionId): Promise<readonly BrowserHistoryEntry[]> {
    return this.session(session).history
  }

  /**
   * Replay one recorded operation by sequence number. Navigate/click/type are
   * re-issued against the current page; execute re-runs its script. The
   * replayed step is appended to history as a new entry.
   * @param session - the session id.
   * @param seq - the recorded entry's sequence number to replay.
   */
  async replay(session: BrowserSessionId, seq: number): Promise<void> {
    const s = this.session(session)
    const entry = s.history.find(e => e.seq === seq)
    if (entry === undefined) {
      throw new BrowserError(`browser: no history entry with seq ${seq}`, 'BROWSER_HISTORY_UNKNOWN')
    }
    switch (entry.action) {
      case 'navigate': {
        const url = entry.params.url
        if (typeof url !== 'string') throw new BrowserError(`browser: history seq ${seq} navigate has no url`, 'BROWSER_HISTORY_INVALID')
        await this.navigate(session, { url })
        this.record(s, 'replay', { seq, of: entry.action, url }, true)
        return
      }
      case 'click': {
        const target = entry.params.target as BrowserElementTarget | undefined
        if (target !== undefined) {
          await this.click(session, { target })
          this.record(s, 'replay', { seq, of: entry.action, target }, true)
          return
        }
        const x = entry.params.x
        const y = entry.params.y
        if (typeof x !== 'number' || typeof y !== 'number') throw new BrowserError(`browser: history seq ${seq} click has no coordinates`, 'BROWSER_HISTORY_INVALID')
        await this.click(session, { x, y })
        this.record(s, 'replay', { seq, of: entry.action, x, y }, true)
        return
      }
      case 'type': {
        const text = entry.params.text
        if (typeof text !== 'string') throw new BrowserError(`browser: history seq ${seq} type has no text`, 'BROWSER_HISTORY_INVALID')
        const target = entry.params.target as BrowserElementTarget | undefined
        await this.type(session, { text, ...target !== undefined ? { target } : {} })
        this.record(s, 'replay', { seq, of: entry.action, text, ...target !== undefined ? { target } : {} }, true)
        return
      }
      case 'scroll': {
        await this.scroll(session, entry.params as BrowserScrollRequest)
        this.record(s, 'replay', { seq, of: entry.action }, true)
        return
      }
      case 'key': {
        const key = entry.params.key
        if (typeof key !== 'string') throw new BrowserError(`browser: history seq ${seq} key has no key`, 'BROWSER_HISTORY_INVALID')
        await this.key(session, { key })
        this.record(s, 'replay', { seq, of: entry.action, key }, true)
        return
      }
      case 'execute': {
        const script = entry.params.script
        if (typeof script !== 'string') throw new BrowserError(`browser: history seq ${seq} execute has no script`, 'BROWSER_HISTORY_INVALID')
        const recordedArgs = entry.params.args
        const args = Array.isArray(recordedArgs)
          ? recordedArgs.filter((a): a is string | number | boolean => typeof a === 'string' || typeof a === 'number' || typeof a === 'boolean')
          : undefined
        const result = await this.execute(session, { script, ...args !== undefined && args.length > 0 ? { args } : {} })
        this.record(s, 'replay', { seq, of: entry.action, script, ...args !== undefined && args.length > 0 ? { args } : {} }, result.ok, result.ok ? { result: String(result.value) } : { error: result.exception })
        return
      }
      default:
        throw new BrowserError(`browser: history seq ${seq} action "${entry.action}" is not replayable`, 'BROWSER_HISTORY_NOT_REPLAYABLE')
    }
  }

  /** Close the session and destroy all its views. Idempotent. */
  close(session: BrowserSessionId): Promise<void> {
    const existing = this.sessions.get(session)
    if (existing !== undefined) {
      this.sessions.delete(session)
      for (const tab of existing.tabs) this.host.destroyView(tab.handle)
    }
    return Promise.resolve()
  }

  /** Look up a session or throw the unknown-session error. */
  private session(session: BrowserSessionId): Session {
    const existing = this.sessions.get(session)
    if (existing === undefined) {
      throw new BrowserError(`browser: session "${session}" is not open`, 'BROWSER_SESSION_UNKNOWN')
    }
    return existing
  }

  /** The active tab of a session. */
  private activeTab(s: Session): Tab {
    const tab = s.tabs[s.activeIndex]
    if (tab === undefined) throw new BrowserError('browser: session has no active tab', 'BROWSER_TAB_UNKNOWN')
    return tab
  }

  /** Append a fresh tab and make it active. */
  private newTab(s: Session): void {
    const handle = this.host.createView()
    // Same window as the session's other tabs.
    this.host.groupView?.(handle, s.id, s.label)
    s.tabs.push({ id: `tab:${randomUUID()}`, handle })
    s.activeIndex = s.tabs.length - 1
    this.showActive(s)
  }

  /** Find a session's tab by its backing view id (toolbar actions carry view ids). */
  private tabByViewId(s: Session, viewId: string): Tab | undefined {
    return s.tabs.find(tab => tab.handle.id === viewId)
  }

  /**
   * Route a user-initiated action from the host's UI into the session model.
   * Fire-and-forget by design: a user action failing (e.g. an unreachable
   * URL typed into the address bar) must never crash the host UI loop — it
   * is reported to the host (toolbar) when the host supports it, else logged.
   */
  private async handleUserAction(action: BrowserUserAction): Promise<void> {
    const s = this.sessions.get(action.windowId)
    if (s === undefined) {
      // The window the human clicked in has no live session here (session
      // closed, or a child restart changed identity). Never swallow the click
      // silently — surface it so the toolbar can tell the human what happened.
      const message = `action ${action.type} failed: no live browser session for window "${action.windowId}"`
      process.stderr.write(`[dsh-browser] ${message}\n`)
      this.notifyUserActionError(action, new Error('no live browser session'))
      return
    }
    try {
      switch (action.type) {
        case 'navigate':
          await this.openUrl(s.id, { url: action.url })
          return
        case 'newTab':
          this.newTab(s)
          if (action.url !== undefined && action.url !== '') {
            await this.navigate(s.id, { url: action.url })
          }
          return
        case 'activateTab': {
          const tab = this.tabByViewId(s, action.viewId)
          if (tab !== undefined) await this.switchTab(s.id, tab.id)
          return
        }
        case 'closeTab': {
          const tab = this.tabByViewId(s, action.viewId)
          if (tab !== undefined) await this.closeTab(s.id, tab.id)
          return
        }
        case 'back':
          await this.back(s.id)
          return
        case 'forward':
          await this.forward(s.id)
          return
        case 'reload':
          await this.reload(s.id)
          return
      }
    } catch (error) {
      this.notifyUserActionError(action, error)
    }
  }

  /** Report a failed user action to the host UI (toolbar), when supported. */
  private notifyUserActionError(action: BrowserUserAction, error: unknown): void {
    const notify = (this.host as { notifyUserActionError?(windowId: string, message: string): void }).notifyUserActionError
    const message = `action ${action.type} failed: ${String(error)}`
    if (typeof notify === 'function') {
      notify(action.windowId, message)
    } else {
      process.stderr.write(`[dsh-browser] user action failed: ${message}\n`)
    }
  }

  /** Ask the host to show the active tab's view, carrying the session label. */
  private showActive(s: Session): void {
    this.host.showView?.(this.activeTab(s).handle, s.label)
  }

  /** Read the current URL of a view through CDP. */
  private async currentUrl(handle: ElectronViewHandle): Promise<string> {
    // Bound the read: a wedged renderer would otherwise hang listTabs.
    const timeoutMs = 10_000
    const result = await withTimeout(
      handleSendEvaluate(handle, 'location.href'),
      timeoutMs,
      undefined,
      `browser: url read timed out after ${timeoutMs}ms`,
      () => terminatePage(handle),
    )
    return result.ok && typeof result.value === 'string' ? result.value : ''
  }
}

/**
 * Bound a promise so a wedged CDP call surfaces as an error instead of
 * hanging the tool call forever. The caller's signal, when provided, wins
 * over the timeout if it fires first.
 * @param promise - the operation to bound.
 * @param ms - the timeout budget.
 * @param signal - optional caller signal.
 * @param message - the timeout error message.
 * @returns the promise's value, or a rejected promise on timeout/abort.
 */
function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  signal: AbortSignal | undefined,
  message: string,
  onCancel?: () => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let done = false
    const timer = setTimeout(() => {
      if (done) return
      done = true
      // A fired timeout must also release the abort listener; { once: true }
      // only releases it on the next abort, which may never come.
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      const error = new Error(message)
      error.name = 'TimeoutError'
      reject(error)
      // Best-effort interrupt of the underlying CDP call (see onCancel).
      onCancel?.()
    }, ms)
    const finish = (fn: () => void): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      fn()
    }
    const onAbort = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
      onCancel?.()
    }
    if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    )
  })
}

/**
 * Best-effort interrupt of a wedged page-script evaluation. `Runtime.evaluate`
 * with `awaitPromise` can hold the renderer (and the target's debugger queue)
 * behind a busy loop or a never-settling promise; terminating kills the
 * running script so subsequent commands are not stuck forever. Fire-and-forget:
 * if the interrupt itself hangs, it is ignored. Capped at
 * MAX_PENDING_TERMINATIONS per view to prevent unbounded pending entries
 * when the child is truly stuck.
 * @param handle - the view handle to terminate in.
 */
const pendingTerminations = new WeakMap<ElectronViewHandle, number>()
const MAX_PENDING_TERMINATIONS = 3
function terminatePage(handle: ElectronViewHandle): void {
  const count = pendingTerminations.get(handle) ?? 0
  if (count >= MAX_PENDING_TERMINATIONS) return
  pendingTerminations.set(handle, count + 1)
  void handle.sendCommand('Runtime.terminateExecution').finally(() => {
    pendingTerminations.set(handle, Math.max(0, (pendingTerminations.get(handle) ?? 1) - 1))
  }).catch(() => {})
}

/**
 * Run a `Runtime.evaluate` through a view handle and normalize the result.
 * Shared by execute, snapshot, content, and internal URL reads.
 * @param handle - the view handle to evaluate in.
 * @param expression - the JS expression.
 * @param signal - optional abort signal; a fired signal rejects the call.
 */
async function handleSendEvaluate(
  handle: ElectronViewHandle,
  expression: string,
  signal?: AbortSignal,
): Promise<BrowserExecuteResult> {
  signal?.throwIfAborted()
  const result = await handle.sendCommand(CDP_RUNTIME_EVALUATE, {
    expression,
    returnByValue: true,
    awaitPromise: true,
  } satisfies CdpEvaluateParams)
  if (result.exceptionDetails !== undefined) {
    const detail = result.exceptionDetails as { text?: string; exception?: { description?: string } }
    return { ok: false, exception: detail.exception?.description ?? detail.text ?? 'unknown exception' }
  }
  return { ok: true, value: (result.result as { value?: unknown } | undefined)?.value ?? null }
}

