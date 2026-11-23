import { DEFAULT_OPERATION_TIMEOUT_MS } from '../../assets/browser-policy.mjs'
import type { RawCaptureResult } from '../browser-reference/page-script.ts'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { HistoryStore } from './history-store.ts'
import type { BrowserSettings } from './settings-store.ts'
import type { DocumentIdentity } from './document-readiness.ts'
import type { BrowserExecuteRequest, BrowserExecuteResult, BrowserHistoryEntry, BrowserSessionId, ExportedCookie } from '../browser/types.ts'
import { BrowserError } from '../browser/types.ts'
import type { BrowserTabWireId } from '../browser/handles.ts'
import type { CarrierPage, CarrierLossReason } from '../browser/types.ts'
import type { BrowserReferenceTarget } from '../browser-reference/types.ts'

export const PROVIDER_TIMEOUTS = Object.freeze({
  evaluation: 3_000,
  interaction: 5_000,
  lookup: 10_000,
  action: 15_000,
  prepare: DEFAULT_OPERATION_TIMEOUT_MS + 1_000,
  download: 60_000,
})

/** Stable provider id registered with `ctx.browser`. */
export const ELECTRON_BROWSER_PROVIDER_ID = 'electron'

/** `until`: a hidden page waiting for the person's activation to come to the front stops waiting when this aborts (the takeover ended). */
export interface QuietRevealOptions { readonly select?: boolean; readonly until?: AbortSignal }

/**
 * The minimal Electron surface this provider needs. Implemented by the
 * desktop shell with a real `WebContentsView`; a fake implements it in tests.
 */
export interface ElectronBrowserViewHost {
  prepare?(scope?: BrowserSessionId): Promise<void>
  readonly referenceOverlayOwner?: 'client'
  referenceOverlayOwnerFor?(scope: BrowserSessionId): 'client' | undefined
  retireSession?(scope: BrowserSessionId): Promise<void>
  /** Move the view's window onto the screen if quiet mode parked it off-screen, without activating it; whether it moved. */
  revealQuietWindow?(handle: ElectronViewHandle, options?: QuietRevealOptions): Promise<boolean>
  /**
   * Create a new browser view and return a handle to its webContents-like
   * surface. The host owns windowing (adding the view to the window, sizing,
   * removal); the provider owns CDP-driven behavior.
   * @param owner - the conversation this view serves. A host shared by several conversations
   *   needs it to keep one conversation's page out of another's; a host with one conversation per
   *   process may ignore it. It is per VIEW and not per host on purpose: the desktop's host is a
   *   single instance that every conversation runs through, so an owner held there would be one
   *   conversation's id applied to all of them.
   */
  createView(identity: BrowserTabWireId): ElectronViewHandle
  /**
   * Destroy a view created by this host. Called on session close; idempotent
   * for an already-destroyed view.
   * @param handle - the handle returned by {@link createView}.
   */
  destroyView(handle: ElectronViewHandle, options?: { readonly keepPage?: boolean }): void
  /**
   * Show one view as the session's visible surface. The host keeps exactly
   * one visible; switching tabs reorders visibility without losing state.
   * Optional: a host without visible-tab switching treats every view as
   * always present (acceptable for headless/probe hosts).
   * @param handle - the handle to make visible.
   * @param label - human-readable session/task label, when the provider knows
   * one; the host may surface it (e.g. in the window title) so a human can
   * tell which task's page is currently visible.
   * @param options - presentation policy; `quiet` asks for a surface without taking
   * over the screen (see {@link PresentOptions}).
   */
  showView?(handle: ElectronViewHandle, label?: string, options?: PresentOptions): void
  /**
   * Optional: (re)present a view and WAIT until the host confirms it. Chromium
   * silently drops CDP-synthesized input (`Input.*`) for a view that has no
   * display surface, which made clicks/typing report success while the page
   * received nothing (and made the first input after a navigation vanish,
   * because the replaced renderer has no surface yet). Unlike
   * {@link showView}, this round-trips an RPC barrier that is ordered AFTER
   * the show on the same socket, so its reply means the view is on screen.
   * Rejects when the view cannot be presented; a host without this method is
   * assumed to present every view (headless/probe hosts).
   * @param handle - the handle to present.
   * @param label - human-readable session/task label, as in {@link showView}.
   * @param options - presentation policy, as in {@link showView}.
   */
  presentView?(handle: ElectronViewHandle, label?: string, options?: PresentOptions): Promise<void>
  /**
   * Optional: pages this carrier holds that the provider never created.
   *
   * A sidebar panel and an installed browser both own their own page creation. Clicking a link
   * that opens a new page — or any `window.open` the page performs — produces a page the provider
   * did not ask for and therefore never recorded. Those pages are real: they are what the human
   * sees, they hold memory, and they persist until something closes them. Without this the tab
   * model reports only what the provider itself made, so the extras are invisible to
   * `dsh_browser_list_tabs` and unclosable through `dsh_browser_close_tab`, accumulating for the
   * life of the browser.
   *
   * Views the host itself opened are NOT included. That exclusion belongs to the host, which is the
   * only side that can make it: a provider tab is identified by the provider's own id and a carrier
   * page by the carrier's, so a caller comparing the two matches nothing and reports every page
   * twice. Measured on the sidebar carrier: three clicks produced three webview guests while
   * `dsh_browser_list_tabs` reported one tab; on the installed-browser carrier the window held four
   * pages and the tool reported one.
   * @param owner - the calling task/conversation; shared sidebar hosts must scope to it.
   * @param options - `requireRunning` lists only from a carrier that is already
   *   running. A background scan (the reference-bar pump) must use it: opening
   *   the human's installed browser just to look for a page is a side effect
   *   nobody asked for.
   * @returns every page this conversation's carrier holds that this host did not open.
   */
  listPages?(scope: BrowserSessionId, options?: { readonly requireRunning?: boolean }): Promise<readonly CarrierPage[]>
  /**
   * Optional: take over one page reported by {@link listPages}, so it becomes a page this provider
   * drives rather than one it can only see.
   *
   * Reported as a defect: opening a window by hand, navigating it, and then asking a tool to read it
   * produced a SECOND page — the human's own tab was listed (under `page:`) and closable, but not
   * readable, which is the opposite of "the page you are looking at". A carrier that cannot do this
   * must leave it undefined rather than pretend: a switch that reported success and then read
   * nothing is the failure this removes.
   * @param viewId - the view to bind the page to.
   * @param id - the carrier's own page id, as {@link listPages} reported it.
   * @returns a handle for that page, usable for commands like any other view's.
   */
  adoptPage?(id: BrowserTabWireId, scope?: BrowserSessionId): Promise<ElectronViewHandle>
  /**
   * Optional: close one page reported by {@link listPages}.
   *
   * The pair exists because listing a page the caller cannot close is worse than not listing it:
   * `dsh_browser_list_tabs` would report pages that `dsh_browser_close_tab` answers "not open in
   * this session" about, which reads as a contradiction rather than a boundary.
   * @param id - the carrier's own page id, as {@link listPages} reported it.
   * @param owner - the same task/conversation used for listing; never a global fallback.
   */
  closePage?(id: BrowserTabWireId, scope?: BrowserSessionId): Promise<void>
  /**
   * Optional cheap usability probe (no network): whether the host can back
   * views at all right now. The self-hosted host checks for a usable Electron
   * binary; a host without the probe is assumed usable. Lets the seam's
   * provider selection (BROWSER_PROVIDER_UNAVAILABLE etc.) be real instead
   * of failing only at first use.
   */
  available?(): boolean
  /**
   * Tell the human that a toolbar action the agent could not complete has failed.
   *
   * Optional. Declared rather than reached through a cast because this is what issue #16 was:
   * the call used to be unbound, so `this` inside the host's implementation was undefined and
   * its first statement threw — inside an async catch, which turned it into an unhandled
   * rejection that took the whole DSH process down. A declared member is checkable; a cast is
   * not.
   * @param windowId - the window the action came from.
   * @param message - what to show the human.
   */
  notifyUserActionError?(windowId: string, message: string): void
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
  /**
   * Optional: receive notice that the human closed a browser window. Closing the
   * interface ends the session it showed — the next call opens a clean one —
   * while browsing history and login state survive on disk.
   * @param handler - called with the group (session) key; must not throw.
   */
  onViewClosed?(handler: (windowId: string) => void): void
  /**
   * Release the service's page(s) without ending the plugin's own lifetime.
   *
   * Only carriers that outlive a browser session need this. A self-hosted window
   * dies with its view, but the desktop shell's sidebar keeps running no matter
   * what the plugin does — so "release the browser when the session ends"
   * (settings: ui.closeWithSession) has to be asked for explicitly there.
   * @returns a promise that settles once the release was attempted.
   */
  /**
   * Release this carrier's browser pages for one conversation.
   * @param owner - the conversation whose pages to close. Omit to close every conversation's,
   *   which is only correct from a teardown that is itself global.
   */
  releasePage?(scope?: BrowserSessionId): Promise<void>
  /**
   * Report that this carrier can no longer serve anything, so its owner may replace it.
   *
   * A carrier that borrows an outside process can lose it: the desktop shell exits, and every call
   * after that would dial a port nobody owns. Without this signal the swap happens only at
   * startup, so the choice made then is final for the process's life — which is what a user
   * experiences as "the browser stopped working until I restart DSH". Optional: a carrier that
   * owns its own lifetime has nothing to report.
   *
   * The listener receives WHY, because the fallback's message has to match what happened: a shell
   * that exited and a shell whose panel cannot provide a page both reach the same fallback, and
   * announcing "the shell has exited" for the second tells the user their desktop crashed when it
   * did not.
   * @param listener - called once, when the carrier concludes it is gone.
   */
  onLost?(listener: (reason: CarrierLossReason) => void): void
  /**
   * Fold the carrier's presentation away while keeping the page alive.
   *
   * The desktop sidebar keeps running regardless of the plugin, so "do not take
   * over the screen" (settings: ui.autoExpandOnce = false) can only be honoured by
   * asking the shell to fold it. A self-hosted window has no such state and simply
   * does not implement this.
   * @returns a promise that settles once the fold was attempted.
   */
  collapse?(): Promise<void>
  /**
   * Release everything the carrier owns (a spawned browser, a socket, a child).
   * Called when the plugin stops using it, never while it is still in service.
   */
  dispose?(): void
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
  | {
    readonly type: 'capture-reference'
    readonly windowId: string
    readonly entry: 'native-menu' | 'page-overlay'
    readonly frameSelector?: string
    /** The exact image/table the human right-clicked, if any. */
    readonly target?: BrowserReferenceTarget
    /** The note typed in the selection bar. */
    readonly comment?: string
    /**
     * The selection text the bar froze before its comment field took focus.
     * Used to locate the capture again when the live selection is gone.
     */
    readonly selectionText?: string
    /**
     * The complete ordered capture the bar froze at that same moment (text
     * runs, assets, table ranges, anchors). Preferred over `selectionText`.
     */
    readonly capture?: RawCaptureResult
  }

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
  sendCommand(method: string, params?: Record<string, unknown>, options?: CommandOptions): Promise<Record<string, unknown>>
  /**
   * Whether this view's CDP can encode JPEG and honour a quality setting.
   *
   * Electron 43's CDP hangs on `Page.captureScreenshot` with `format: 'jpeg'`, so a view
   * backed by Electron must leave this unset and the provider keeps to PNG. A view backed
   * by an installed Chrome or Edge is the real browser, where JPEG works, and sets it so
   * the requested format is not silently downgraded.
   */
  readonly supportsCdpJpeg?: boolean
  /**
   * Give the backing view web focus so keyboard input reaches its page.
   * Optional: an adapter that cannot focus a view omits it, and the provider
   * then behaves exactly as before.
   */
  focus?(options?: PresentOptions): Promise<void>
  /**
   * Save a URL straight to disk, when the backing view can do that itself.
   *
   * Optional. Declared here rather than reached through a structural cast at the call site:
   * a cast tells the compiler nothing, so a host that implements the interface without this
   * method compiles and then silently does nothing.
   * @param url - the URL to fetch.
   * @param savePath - where to write it.
   */
  download?(url: string, savePath: string): Promise<void>
  /**
   * Export this view's cookies. Optional; see {@link download} for why it is declared.
   * @returns the cookies, scoped to the view's own page.
   */
  flushAuth?(): Promise<readonly ExportedCookie[]>
  /**
   * Import cookies into this view. Optional.
   * @param cookies - the cookies to write.
   * @returns how many were accepted.
   */
  restoreAuth?(cookies: readonly ExportedCookie[]): Promise<number>
  /**
   * Capture this view natively, returning the image and its measured size.
   *
   * Optional. The size is part of the contract because the caller's own tool schema declares
   * `width`/`height`; a host that can measure the image should say so here rather than leaving
   * the provider to guess.
   * @param opts - format, quality and downscale bounds.
   * @returns the encoded image and the pixel size the caller will receive.
   */
  capture?(opts?: ScreenshotOptions): Promise<{ base64: string; mime: string; width?: number; height?: number }>
}

/**
 * One tab inside a session: its view, a stable id, and the last URL this provider accepted.
 *
 * `url` does two jobs. It separates "never navigated" from "navigated, but the URL could not be
 * read" — the two used to collapse into the same empty string — and it lets `listTabs` skip
 * probing a tab it already knows is blank, where a probe is a round trip on an uncommitted view
 * that can only answer nothing.
 *
 * A failed guest stays attached to its tab until the caller explicitly closes or resets it.
 */
export interface Tab {
  readonly id: BrowserTabWireId
  readonly handle: ElectronViewHandle
  url: string
  navigation?: symbol
  navigationAbort?: AbortController
  failure?: BrowserError
  /**
   * Consecutive failed page evaluations, used only by the reference pump to tell
   * "mid-navigation" (retried) from "this page is gone for now" (backed off).
   */
  misses?: number
  /** Earliest time the reference pump may try this page again. */
  retryAt?: number
}

/** One live browser session: an ordered list of tabs, one active. */
export interface Session {
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
  /**
   * Persistent browsing history (visited pages), independent of session
   * lifetime. `enabled: false` keeps the browser working but records nothing;
   * the retained limits ride along so a user's choice from the settings panel
   * reaches the store without a second configuration path.
   */
  readonly history?: {
    readonly enabled?: boolean
    readonly maxEntries?: number
    readonly maxAgeDays?: number
    /**
     * Explicit history file path. Default: beside the browser profile
     * (`$DSH_HOME/dsh-builtin-browser-host/history.jsonl`).
     */
    readonly file?: string
  }
  /**
   * Live settings source (the settings panel's document). When present it wins
   * over the static `history` config, so a switch flipped in the UI takes effect
   * without restarting DSH.
   */
  readonly settings?: () => BrowserSettings
  /** Maximum snapshot elements before truncation. Default 60. */
  readonly snapshotMaxElements?: number
  /**
   * Explicit content cap, overriding the per-format default when set.
   *
   * Honoured again, and it is worth saying why that is a fix rather than a feature: this was
   * `config.contentMaxChars ?? 100_000`, one number for every format, and when the caps became
   * per-format (html and json 50 000, otherwise 20 000) the field was left assigned and never
   * read. A configuration knob that silently does nothing is worse than no knob — it is an
   * operator's decision that quietly went nowhere. Leaving it unset means the per-format
   * default; setting it means the operator meant it.
   */
  readonly contentMaxChars?: number
  /**
   * Directory `dsh_browser_download` save paths must resolve inside (prevents a
   * prompt-injected agent from writing arbitrary machine paths). Default:
   * `~/Downloads`. NOTE: this default is a convenience, not a security
   * boundary — on Windows it may resolve to OneDrive/redirected paths;
   * a production deployment should set an explicit, verified path.
   */
  readonly downloadDir?: string
  /**
   * The conversation this process serves, when the composition knows it.
   *
   * The reference entry needs it to find the page the human has open in THIS
   * conversation's sidebar: the shell exposes a panel's pages by conversation id,
   * and a page bound under the wrong id would either be refused or wired into
   * another conversation's draft. Absent on hosts that do not name it (a plain
   * `dsh web`), where the sidebar entry simply does not apply.
   */
  readonly referenceLabel?: string | (() => string | undefined)
}

/**
 * CDP method/params for `Page.navigate`, as sent to {@link ElectronViewHandle.sendCommand}.
 */
export interface CdpNavigateParams {
  readonly url: string
}

/**
 * CDP method/params for `Input.dispatchMouseEvent`: a pointer move, or one half
 * of a click's press+release pair. `button`/`clickCount` belong to the press and
 * release halves; a move carries only the position.
 *
 * `buttons` is a BITMASK of what is held down at the moment of the event, and it is not the same
 * field as `button` — `button` says which one this event is about, `buttons` says which ones are
 * down. Chromium needs both to recognise a synthesized press as a real button press: with
 * `buttons` omitted (0), the event still reaches the page and a `click` listener still fires, but
 * the element's DEFAULT ACTION does not run. Measured on the sidebar carrier: a click on an
 * anchor sent `mousedown`/`mouseup`/`click` to the page with `isTrusted: true` and
 * `defaultPrevented: false`, and the browser did not follow the link — including for an anchor
 * injected by the test itself, so the page was not responsible.
 */
export interface CdpMouseParams {
  readonly type: 'mouseMoved' | 'mousePressed' | 'mouseReleased'
  readonly x: number
  readonly y: number
  readonly button?: 'left'
  readonly clickCount?: number
  /** Buttons held during the event: 1 = primary down. A move carries 0. */
  readonly buttons?: number
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

/** One cookie as CDP reports it (`Storage.getCookies`). */
export interface CdpCookie {
  readonly name?: unknown
  readonly value?: unknown
  readonly domain?: unknown
  readonly path?: unknown
  readonly expires?: unknown
  readonly httpOnly?: unknown
  readonly secure?: unknown
  readonly sameSite?: unknown
}

/**
 * The document size out of a `Page.getLayoutMetrics` response.
 *
 * CDP returns `cssContentSize` (the whole document) and `cssLayoutViewport` (what is
 * visible); the newer spellings `contentSize` / `layoutViewport` appear on some
 * versions, so both are accepted. Returns undefined when neither is usable, leaving the
 * caller to capture unscaled rather than guess.
 * @param metrics - the raw CDP response.
 * @returns the document and viewport size in CSS pixels.
 */
export function layoutSize(metrics: Record<string, unknown>): { width: number; height: number; viewportHeight: number } | undefined {
  const pick = (candidates: readonly unknown[]): { width: number; height: number } | undefined => {
    for (const candidate of candidates) {
      if (typeof candidate !== 'object' || candidate === null) continue
      const box = candidate as { width?: unknown; height?: unknown }
      if (typeof box.width === 'number' && typeof box.height === 'number' && box.width > 0 && box.height > 0) {
        return { width: box.width, height: box.height }
      }
    }
    return undefined
  }
  const content = pick([metrics.cssContentSize, metrics.contentSize])
  const viewport = pick([metrics.cssLayoutViewport, metrics.layoutViewport])
  if (content === undefined) return undefined
  return { width: content.width, height: content.height, viewportHeight: viewport?.height ?? content.height }
}

/**
 * Map CDP cookies onto the shape `dsh_browser_auth` exports.
 *
 * CDP reports a cookie as domain + path rather than a URL, and in seconds rather than
 * milliseconds, so both are converted. Entries missing a name, value or domain are
 * dropped rather than exported as broken cookies the caller cannot restore.
 * @param raw - the `cookies` array from a CDP response, of unknown shape.
 * @returns the mappable cookies.
 */
export function toExportedCookies(raw: unknown): ExportedCookie[] {
  if (!Array.isArray(raw)) return []
  const out: ExportedCookie[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const cookie = entry as CdpCookie
    // An empty domain is as unusable as a missing one: it cannot form a cookie URL, so
    // exporting it would hand the caller something that fails to restore.
    if (typeof cookie.name !== 'string' || cookie.name === '') continue
    if (typeof cookie.value !== 'string') continue
    if (typeof cookie.domain !== 'string' || cookie.domain === '') continue
    const path = typeof cookie.path === 'string' && cookie.path !== '' ? cookie.path : '/'
    // A leading dot means "this domain and its subdomains"; a cookie URL must not keep it.
    const host = cookie.domain.replace(/^\./, '')
    out.push({
      url: `${cookie.secure === true ? 'https' : 'http'}://${host}${path}`,
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path,
      ...cookie.secure === true ? { secure: true } : {},
      ...cookie.httpOnly === true ? { httpOnly: true } : {},
      ...typeof cookie.expires === 'number' && cookie.expires > 0 ? { expirationDate: cookie.expires } : {},
    })
  }
  return out
}

/**
 * Map an exported cookie onto the fields `Storage.setCookies` expects.
 *
 * An exported cookie may carry only a URL, so the domain and path are recovered from it
 * when they are absent; without either, CDP cannot place the cookie and it is skipped.
 * @param cookie - the cookie to convert.
 * @returns the CDP cookie, or undefined when it lacks a usable domain.
 */
export function toCdpCookie(cookie: ExportedCookie): Record<string, unknown> | undefined {
  let domain = cookie.domain
  let path = cookie.path
  if (domain === undefined || domain === '') {
    try {
      const parsed = new URL(cookie.url)
      domain = parsed.hostname
      if (path === undefined || path === '') path = parsed.pathname === '' ? '/' : parsed.pathname
    } catch {
      return undefined
    }
  }
  if (typeof domain !== 'string' || domain === '') return undefined
  return {
    name: cookie.name,
    value: cookie.value,
    domain,
    path: path === undefined || path === '' ? '/' : path,
    ...cookie.secure === true ? { secure: true } : {},
    ...cookie.httpOnly === true ? { httpOnly: true } : {},
    ...typeof cookie.expirationDate === 'number' ? { expires: cookie.expirationDate } : {},
  }
}

/**
 * How the carrier should present a view before it is used.
 *
 * `quiet` is the resolved `ui.quiet` switch. It does not mean "invisible": Chromium drops
 * synthesized `Input.*` for a view without a display surface, so input still needs one. It means
 * the carrier must get that surface without taking the screen over — no application activation
 * and no operating-system keyboard focus. New windows open inactive; a minimized window and the
 * foreground window's selected page remain under the operator's control. DOM focus and CDP input
 * still target the task's page. Explicit sidebar navigation can select the task's pane.
 */
export interface PresentOptions {
  readonly quiet?: boolean
  /** Explicit navigation or tab selection may change the task's sidebar tab without OS activation. */
  readonly select?: boolean
  /** A person's own selection, not the agent's: only this may reveal a window quiet mode parked off-screen. */
  readonly user?: boolean
}

/**
 * How a command should reach its page.
 *
 * Reported as issue #46: opening the live preview pushed the conversation's sidebar browser panel
 * to the front — a read-only "look at it" action changing the reader's layout. The chain was
 * `capturePassive` → `sendCommand('Page.captureScreenshot')` → the host's guest lookup → the bridge's
 * `ensureSidebar` → a retry that asked the client half to `openSession`, which is exactly what a tool
 * call is allowed to do and a preview is not.
 *
 * `present: false` says "this command must not make anything visible": use the page this
 * conversation already has, and treat "not displayed" as a state to report rather than a condition
 * to fix.
 */
export interface CommandOptions {
  readonly deadline?: number
  readonly signal?: AbortSignal
  /** Present the view first (default), or only use a page that is already there. */
  readonly present?: boolean
  /** Only use a guest already attached to this handle, without sidebar initialization. */
  readonly initialize?: boolean
}

/** Native capture options the self-hosted view handle understands. */
export interface ScreenshotOptions {
  readonly format?: 'png' | 'jpeg'
  readonly quality?: number
  readonly maxWidth?: number
  readonly maxHeight?: number
  /**
   * Capture without presenting the window first (`ui.quiet`).
   *
   * The self-hosted host answers this by skipping its restore/show/focus step: a visible window
   * still captures through `capturePage()`, and a minimized or hidden one falls through to the
   * CDP path, which needs no display surface.
   */
  readonly quiet?: boolean
}

/** CDP method for runtime evaluation (the execute path). */
export const CDP_RUNTIME_EVALUATE = 'Runtime.evaluate'

/** CDP method for navigation. */
export const CDP_PAGE_NAVIGATE = 'Page.navigate'

/** Named-key table for `key()`: CDP key/code names + Windows virtual key codes. */
export const KEY_SPECS: Readonly<Record<string, { readonly key: string; readonly code: string; readonly vk: number; readonly text?: string }>> = {
  // `text` is what makes a key produce CHARACTER INPUT rather than only a key event, and form
  // submission depends on the character: pressing Enter in a text field submits the form because
  // the browser processes a carriage return, not because a key went down. Without `text` the event
  // still reaches the page, a `keydown` listener still fires, and nothing happens — reported as
  // issue #36, where `requestSubmit()` worked and this did not.
  //
  // The same omission is why Space used to pass only its key event; that one was already fixed and
  // is the reason the table has a `text` column at all.
  Enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
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
 * Localized names a system Downloads folder may carry, in probe order: the
 * English default first, then the Chinese spellings — a zh-CN desktop calls
 * the folder `下载`, a zh-TW one `下載`, and neither is `Downloads`.
 */
export const DOWNLOAD_DIR_NAMES: readonly string[] = ['Downloads', '下载', '下載']

/**
 * Resolve the default download directory when the config names none: an
 * existing `XDG_DOWNLOAD_DIR` wins (the freedesktop standard, which is what a
 * localized Linux desktop writes), then the first localized `Downloads` folder
 * that exists under the home directory, and finally the English name — created
 * on first use — when none exists yet.
 * @returns the absolute default download directory.
 */
export function defaultDownloadDir(): string {
  const xdg = process.env.XDG_DOWNLOAD_DIR
  if (typeof xdg === 'string' && xdg !== '' && existsSync(xdg)) return xdg
  for (const name of DOWNLOAD_DIR_NAMES) {
    const candidate = join(homedir(), name)
    if (existsSync(candidate)) return candidate
  }
  return join(homedir(), DOWNLOAD_DIR_NAMES[0] ?? 'Downloads')
}

/**
 * Extra time the transport gets over an in-page locate script's own budget: the
 * script polls for `timeoutMs` and answers only afterwards, so the outer wait
 * must outlast it or its generic timeout hides the in-page reason.
 */
export const TARGET_SCRIPT_GRACE_MS = 2_000

/**
 * Longest a single in-page wait may hold one `Runtime.evaluate` open. The desktop sidebar's bridge
 * gives every CDP command 15 s and then refuses the guest for good, because a renderer command cannot
 * be cancelled; a locate or scrape that polled its whole caller budget inside one evaluate (15 s on
 * Baidu) crossed that limit while the page was healthy. Longer budgets are polled in slices instead.
 */
export const PAGE_POLL_SLICE_MS = 3_000

/**
 * The next in-page poll slice before `deadline`: `last` when it reaches the deadline, so only that
 * slice reports a miss and earlier ones answer `{ pending: true }` for the caller to poll again.
 */
export function pagePollSlice(deadline: number): { readonly sliceMs: number; readonly last: boolean } {
  const remaining = Math.max(0, deadline - Date.now())
  return remaining <= PAGE_POLL_SLICE_MS ? { sliceMs: remaining, last: true } : { sliceMs: PAGE_POLL_SLICE_MS, last: false }
}

/** Abortable sleep used by the settle loop. */
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => { clearTimeout(timer); resolve() }
    if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })
  })
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
export function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  signal: AbortSignal | undefined,
  message: string,
  onCancel?: (timedOut: boolean) => void,
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
      onCancel?.(true)
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
      onCancel?.(false)
    }
    if (signal !== undefined) signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      value => finish(() => resolve(value)),
      error => finish(() => reject(error)),
    )
  })
}

/**
 * Run a `Runtime.evaluate` through a view handle and normalize the result.
 * Shared by execute, snapshot, content, and internal URL reads.
 * @param handle - the view handle to evaluate in.
 * @param expression - the JS expression.
 * @param signal - optional abort signal; a fired signal rejects the call.
 */
/** Viewport point a target script reported, when it reported one. */
export function scriptPoint(out: Record<string, unknown> | undefined): { x: number; y: number } | undefined {
  const point = out?.__point as { x?: unknown; y?: unknown } | undefined
  const x = Number(point?.x)
  const y = Number(point?.y)
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined
}

export async function handleSendEvaluate(
  handle: ElectronViewHandle,
  expression: string,
  signal?: AbortSignal,
  options?: CommandOptions,
): Promise<BrowserExecuteResult> {
  signal?.throwIfAborted()
  const result = await handle.sendCommand(CDP_RUNTIME_EVALUATE, {
    expression,
    returnByValue: true,
    awaitPromise: true,
  } satisfies CdpEvaluateParams, options)
  if (result.exceptionDetails !== undefined) {
    const detail = result.exceptionDetails as { text?: string; exception?: { description?: string } }
    return { ok: false, exception: detail.exception?.description ?? detail.text ?? 'unknown exception' }
  }
  return { ok: true, value: (result.result as { value?: unknown } | undefined)?.value ?? null }
}

export abstract class ProviderCore {
  readonly id = ELECTRON_BROWSER_PROVIDER_ID

  protected readonly sessions = new Map<BrowserSessionId, Session>()
  protected carrierLaunchError: unknown

  /**
   * Tick that installs the selection bar in every live tab and collects what the
   * human confirmed. The Desktop sidebar carrier is the shell's own <webview>:
   * the page has no preload bridge and the bridge protocol carries no user-action
   * channel, so the bar leaves its intent in `window.__dshRefIntents` and this
   * pump takes it over CDP. Without it the sidebar has no reference entry.
   */
  protected referencePump: ReturnType<typeof setInterval> | undefined

  /** Guards against overlapping pump runs (setInterval keeps firing while one is slow). */
  protected referencePumping = false

  /**
   * Set once the carrier swapped to a newer provider. `onUserAction` and
   * `onViewClosed` return void and cannot be unsubscribed, so the callbacks
   * themselves must go inert: otherwise one human click is handled by every
   * old provider still retained by the view host, producing duplicate cards.
   */
  protected disposed = false

  /**
   * The session bound to the page the human has open, created on first sight.
   *
   * A reference is captured from a browser SESSION, and a page the human opened from
   * the sidebar's own address bar belongs to no session of ours. Adopting it into one
   * is what makes the selection bar appear there at all — and it is done here, inside
   * the pump, so it needs nothing from the human and nothing from the agent.
   */
  protected referenceSession: BrowserSessionId | undefined

  /** Ticks between sidebar page scans while nothing is adopted yet. */
  protected referenceScanCountdown = 0

  /** Last scan's diagnosis, surfaced by {@link referenceStatus}. */
  protected readonly referenceScan: { label?: string; pages: number; lastError?: string } = { pages: 0 }
  protected readonly httpOnly: boolean
  protected readonly snapshotMaxElements: number
  protected readonly contentMaxChars: number | undefined
  protected readonly downloadDir: string | undefined

  /**
   * Persistent browsing history, or `undefined` when the user turned it off.
   * Sessions come and go; this record outlives all of them.
   */
  protected readonly historyStore: HistoryStore | undefined

  /** Live settings source; absent when nothing owns a settings document. */
  protected readonly settingsSource: (() => BrowserSettings) | undefined

  constructor(
    protected readonly host: ElectronBrowserViewHost,
    protected readonly config: ElectronBrowserProviderConfig = {},
  ) {
    this.httpOnly = config.httpOnly ?? true
    this.snapshotMaxElements = config.snapshotMaxElements ?? 60
    this.contentMaxChars = config.contentMaxChars
    // Confine downloads AND screenshot saves to a dedicated directory by
    // default: the OS Downloads folder is the human-visible, browser-natural
    // place for written files, and it is the one directory the DSH file
    // sandbox does not have to arbitrate. The localized name is probed so a
    // Chinese desktop (`~/下载`) works without configuring `downloadDir`.
    this.downloadDir = config.downloadDir ?? defaultDownloadDir()
    this.settingsSource = config.settings
    // Browsing history follows the browser profile's persistence rules (close
    // the interface, lose nothing), and can be switched off from settings.
    this.historyStore = config.history?.enabled === false
      ? undefined
      : new HistoryStore(config.history?.file, {
        ...config.history?.maxEntries !== undefined ? { maxEntries: config.history.maxEntries } : {},
        ...config.history?.maxAgeDays !== undefined ? { maxAgeDays: config.history.maxAgeDays } : {},
      })
    // Route toolbar (host UI) actions into the session model: the human and
    // the agent then always drive the same tabs, history, and navigation.
    this.host.onUserAction?.(action => { if (!this.disposed) void this.handleUserAction(action) })
    // A window the human closed ends the session it showed: the next call opens a
    // clean one instead of driving a page nobody can see.
    this.host.onViewClosed?.(windowId => { if (!this.disposed) void this.handleViewClosed(windowId) })
    this.startReferenceEntryPump()
  }

  /**
   * Evaluate one expression in a tab and return its value.
   *
   * Bounded on purpose: the pump runs on a timer, and an unresponsive renderer
   * would otherwise hold the whole tick (and every later one) forever.
   * @param tab - the tab to evaluate in.
   * @param expression - the JS expression.
   * @param timeoutMs - how long to wait before treating the page as not answering.
   */
  protected async evaluateInTab(tab: Tab, expression: string, timeoutMs: number = PROVIDER_TIMEOUTS.evaluation): Promise<unknown> {
    const raw = await withTimeout(
      tab.handle.sendCommand('Runtime.evaluate', {
        expression, returnByValue: true, awaitPromise: true,
      }),
      timeoutMs,
      undefined,
      `browser: reference probe timed out after ${timeoutMs}ms`,
    )
    const result = (raw as { result?: { value?: unknown } }).result
    return result?.value
  }

  /** Set by {@link openUrl}; read by the client through the HTTP surface. */
  protected lastOpen: { readonly url: string; readonly at: number } | undefined

  /**
   * Refuse to send synthesized input to a view that is no longer the one it was located
   * against.
   *
   * `locateHandle` was captured before a page-side locate that can consume its whole
   * 10s budget; the session's active tab is re-read afterwards. If they differ, the human
   * switched tabs mid-flight (the product's whole point is that they can take over), and
   * the coordinates belong to one page while the dispatch would go to another. Comparing
   * the handles turns that into a loud, retryable error instead of input the caller
   * believes landed.
   * @param session - the session id, for the message.
   * @param locateHandle - the view the locate ran in.
   * @param liveHandle - the view that is active now.
   */
  protected assertSameView(session: BrowserSessionId, locateHandle: ElectronViewHandle, liveHandle: ElectronViewHandle): void {
    if (locateHandle === liveHandle) return
    throw new BrowserError(
      `browser: the session's active view changed while the element was being located (session ${session}); the operation was not dispatched — retry it`,
      'BROWSER_VIEW_CHANGED',
    )
  }

  /**
   * Give the view web focus before synthesizing keyboard input.
   *
   * A renderer only delivers key events to the view that holds web focus. A
   * view that was created but never clicked holds none — and `Input` events
   * injected over CDP do not grant it — so the FIRST `dsh_browser_key` of a fresh
   * session vanished inside the renderer while the command still answered
   * success. Hosts that cannot focus a view (a test double, a different shell
   * adapter) simply have no `focus`, and nothing changes for them.
   */
  protected async focusView(handle: ElectronViewHandle): Promise<void> {
    if (handle.focus === undefined) return
    const quiet = this.isQuiet()
    try {
      // Bounded, unlike the rest of this call: the child RPC has no timeout of its own,
      // and this runs before typing, so an unresponsive child would hang dsh_browser_key for
      // good. A timeout is caught below exactly like any other focus failure, so the
      // best-effort contract is unchanged.
      await withTimeout(handle.focus(quiet ? { quiet } : undefined), PROVIDER_TIMEOUTS.interaction, undefined, 'browser: focusing the view timed out')
    } catch (error) {
      if (quiet) throw error
      // Best-effort: a view that refuses focus must not fail the caller's key
      // press; the dispatch below reports a real channel failure itself.
    }
  }

  /** Execute JS in the active tab's page context. */
  async execute(session: BrowserSessionId, request: BrowserExecuteRequest, signal?: AbortSignal): Promise<BrowserExecuteResult> {
    this.assertActionAllowed('execute')
    return this.evaluatePage(session, request, signal)
  }

  protected async evaluatePage(session: BrowserSessionId, request: BrowserExecuteRequest, signal?: AbortSignal): Promise<BrowserExecuteResult> {
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
      const timeoutMs = request.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS
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
        timedOut => { this.interrupt(handle, timedOut) },
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
      // A caller that aborted is not a failure of the page: report its own reason, or the
      // cancellation surfaces as "execute failed: AbortError" and — if the caller's reason
      // happens to be named TimeoutError — as "timed out after 30000ms", quoting a budget
      // that belongs to the caller rather than to this call.
      if (signal?.aborted) throw signal.reason
      if (error instanceof Error && error.name === 'TimeoutError') {
        throw new BrowserError(`browser: execute timed out after ${request.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS}ms`, 'BROWSER_EXECUTE_TIMEOUT', { cause: error })
      }
      throw new BrowserError(`browser: execute failed: ${String(error)}`, 'BROWSER_EXECUTE_FAILED', { cause: error })
    }
  }

  /**
   * Refuse an action the settings have switched off.
   *
   * These switches belong to the OPERATOR. The settings document is written through the
   * plugin's own panel and no tool can reach it, so — unlike `dsh_browser_restrict`, which the
   * model owns and can lift at will — a refusal here stands for as long as the setting does.
   * That is the point of them: a deployment can take page-script execution, downloads, or
   * login-state writes off the table without relying on the model's cooperation.
   *
   * Read through `settingsSource` on every call rather than captured at construction, so
   * flipping a switch applies to the next command instead of the next restart — the same
   * rule the credentials gate follows.
   * @param action - which switch to consult.
   * @throws BrowserError when that switch is off.
   */
  protected assertActionAllowed(action: 'execute' | 'download' | 'credentialWrite'): void {
    const settings = this.settingsSource?.()
    if (settings === undefined) return
    if (action === 'execute' && !settings.actions.allowExecute) {
      throw new BrowserError('browser: running page scripts is switched off in settings (Browser → actions)', 'BROWSER_EXECUTE_DISABLED')
    }
    if (action === 'download' && !settings.actions.allowDownload) {
      throw new BrowserError('browser: downloads are switched off in settings (Browser → actions)', 'BROWSER_DOWNLOAD_DISABLED')
    }
    if (action === 'credentialWrite' && !settings.actions.allowCredentialWrite) {
      throw new BrowserError('browser: writing cookies is switched off in settings (Browser → actions)', 'BROWSER_AUTH_WRITE_DISABLED')
    }
  }

  protected abstract startReferenceEntryPump(): void
  protected abstract prepareCarrier(signal?: AbortSignal, scope?: BrowserSessionId): Promise<void>
  protected abstract checkNavigation(tab: Tab, navigation: symbol): void
  protected abstract documentIdentity(handle: ElectronViewHandle, signal?: AbortSignal, checkCurrent?: () => void,
    deadline?: number, allowErrorDocument?: boolean): Promise<DocumentIdentity>
  protected abstract settleDocument(handle: ElectronViewHandle, before: DocumentIdentity | undefined, signal?: AbortSignal,
    acknowledgement?: { readonly frameId?: string; readonly loaderId?: string }, checkCurrent?: () => void,
    historyEntry?: number, deadline?: number, allowErrorDocument?: boolean): Promise<void>
  protected abstract present(s: Session, signal?: AbortSignal): Promise<ElectronViewHandle>
  protected abstract record(
    s: Session,
    action: string,
    params: Record<string, unknown>,
    ok: boolean,
    detail?: { result?: string; error?: string },
  ): void
  protected abstract recordVisit(s: Session, handle: ElectronViewHandle): void
  protected abstract session(session: BrowserSessionId): Session
  protected abstract activeTab(s: Session): Tab
  protected abstract interrupt(handle: ElectronViewHandle, timedOut: boolean): void
  protected abstract quarantine(handle: ElectronViewHandle): void
  protected abstract handleViewClosed(windowId: string): Promise<void>
  protected abstract handleUserAction(action: BrowserUserAction, propagate?: boolean): Promise<void>
  protected abstract isQuiet(): boolean
  protected abstract showActive(s: Session, select?: boolean, user?: boolean): void
  protected abstract currentUrl(handle: ElectronViewHandle): Promise<string>
}
