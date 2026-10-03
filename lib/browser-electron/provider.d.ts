/**
 * Electron-backed browser provider: `WebContentsView` sessions driven over
 * `webContents.debugger` (CDP). The provider itself does not import Electron — it operates through the {@link ElectronBrowserViewHost} seam, which the
 * desktop shell implements with real Electron objects. That keeps this
 * package testable under plain Node and leaves the Electron dependency to the
 * shell that owns the `BrowserWindow`.
 * @module dsh-browser/browser-electron
 */
import { type VisitedPage } from './history-store.js';
import type { BrowserSettings } from './settings-store.js';
import type { BrowserA11yRequest, BrowserA11yResult, BrowserChallenge, BrowserCheckRequest, BrowserClearRequest, BrowserClickRequest, BrowserContentRequest, BrowserContentResult, BrowserElementTarget, BrowserExecuteRequest, BrowserExecuteResult, BrowserFillRequest, BrowserFillResult, BrowserGetValueRequest, BrowserGetValueResult, BrowserHistoryEntry, BrowserOpenRequest, BrowserProvider, BrowserScrapeRequest, BrowserScrapeResult, BrowserScreenshotRequest, BrowserSelectRequest, BrowserSelectResult, BrowserSessionId, BrowserSetValueRequest, BrowserSetValueResult, BrowserSnapshotResult, BrowserTab, BrowserTypeRequest, BrowserWaitRequest, BrowserWaitResult, BrowserScrollRequest, BrowserKeyRequest, ExportedCookie } from '../browser/types.js';
/** Stable provider id registered with `ctx.browser`. */
export declare const ELECTRON_BROWSER_PROVIDER_ID = "electron";
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
    createView(): ElectronViewHandle;
    /**
     * Destroy a view created by this host. Called on session close; idempotent
     * for an already-destroyed view.
     * @param handle - the handle returned by {@link createView}.
     */
    destroyView(handle: ElectronViewHandle): void;
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
    showView?(handle: ElectronViewHandle, label?: string): void;
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
     */
    presentView?(handle: ElectronViewHandle, label?: string): Promise<void>;
    /**
     * Optional cheap usability probe (no network): whether the host can back
     * views at all right now. The self-hosted host checks for a usable Electron
     * binary; a host without the probe is assumed usable. Lets the seam's
     * provider selection (BROWSER_PROVIDER_UNAVAILABLE etc.) be real instead
     * of failing only at first use.
     */
    available?(): boolean;
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
    groupView?(handle: ElectronViewHandle, windowId: string, label?: string): void;
    /**
     * Optional: receive user-initiated browser actions from the host's own UI
     * (e.g. a toolbar address bar, back/forward buttons, tab strip). The
     * provider routes them into the session model so the agent and the human
     * always see the same tabs and navigation state.
     * @param handler - called for every user action; must not throw.
     */
    onUserAction?(handler: (action: BrowserUserAction) => void): void;
    /**
     * Optional: receive notice that the human closed a browser window. Closing the
     * interface ends the session it showed — the next call opens a clean one —
     * while browsing history and login state survive on disk.
     * @param handler - called with the group (session) key; must not throw.
     */
    onViewClosed?(handler: (windowId: string) => void): void;
    /**
     * Release the service's page(s) without ending the plugin's own lifetime.
     *
     * Only carriers that outlive a browser session need this. A self-hosted window
     * dies with its view, but the desktop shell's sidebar keeps running no matter
     * what the plugin does — so "release the browser when the session ends"
     * (settings: ui.closeWithSession) has to be asked for explicitly there.
     * @returns a promise that settles once the release was attempted.
     */
    releasePage?(): Promise<void>;
    /**
     * Fold the carrier's presentation away while keeping the page alive.
     *
     * The desktop sidebar keeps running regardless of the plugin, so "do not take
     * over the screen" (settings: ui.autoExpandOnce = false) can only be honoured by
     * asking the shell to fold it. A self-hosted window has no such state and simply
     * does not implement this.
     * @returns a promise that settles once the fold was attempted.
     */
    collapse?(): Promise<void>;
    /**
     * Release everything the carrier owns (a spawned browser, a socket, a child).
     * Called when the plugin stops using it, never while it is still in service.
     */
    dispose?(): void;
}
/**
 * A user-initiated browser action from the host's own UI (toolbar). The
 * `windowId` is the session id the view was grouped under, so the provider
 * can route the action to the right session.
 */
export type BrowserUserAction = {
    readonly type: 'navigate';
    readonly windowId: string;
    readonly url: string;
} | {
    readonly type: 'newTab';
    readonly windowId: string;
    readonly url?: string;
} | {
    readonly type: 'activateTab';
    readonly windowId: string;
    readonly viewId: string;
} | {
    readonly type: 'closeTab';
    readonly windowId: string;
    readonly viewId: string;
} | {
    readonly type: 'back';
    readonly windowId: string;
} | {
    readonly type: 'forward';
    readonly windowId: string;
} | {
    readonly type: 'reload';
    readonly windowId: string;
};
/**
 * A CDP-capable view handle. This is the subset of Electron's
 * `WebContents`/`WebContentsView` the provider drives; the shell's real
 * implementation adapts `webContents.debugger` to it.
 */
export interface ElectronViewHandle {
    /** Unique id of the backing view, used for diagnostics. */
    readonly id: string;
    /**
     * Send one CDP command and resolve with its result. Rejects when the
     * debugger is not attached or the command fails.
     * @param method - CDP method, e.g. `Page.navigate`.
     * @param params - CDP command parameters.
     * @returns the CDP `result` object.
     */
    sendCommand(method: string, params?: Record<string, unknown>): Promise<Record<string, unknown>>;
    /**
     * Whether this view's CDP can encode JPEG and honour a quality setting.
     *
     * Electron 43's CDP hangs on `Page.captureScreenshot` with `format: 'jpeg'`, so a view
     * backed by Electron must leave this unset and the provider keeps to PNG. A view backed
     * by an installed Chrome or Edge is the real browser, where JPEG works, and sets it so
     * the requested format is not silently downgraded.
     */
    readonly supportsCdpJpeg?: boolean;
    /**
     * Give the backing view web focus so keyboard input reaches its page.
     * Optional: an adapter that cannot focus a view omits it, and the provider
     * then behaves exactly as before.
     */
    focus?(): Promise<void>;
}
/** Provider config: navigation admission defaults and snapshot caps. */
export interface ElectronBrowserProviderConfig {
    /** Allow navigation only to HTTP(S) URLs; reject anything else. Default true. */
    readonly httpOnly?: boolean;
    /**
     * Persistent browsing history (visited pages), independent of session
     * lifetime. `enabled: false` keeps the browser working but records nothing;
     * the retained limits ride along so a user's choice from the settings panel
     * reaches the store without a second configuration path.
     */
    readonly history?: {
        readonly enabled?: boolean;
        readonly maxEntries?: number;
        readonly maxAgeDays?: number;
        /**
         * Explicit history file path. Default: beside the browser profile
         * (`$DSH_HOME/dsh-builtin-browser-host/history.jsonl`).
         */
        readonly file?: string;
    };
    /**
     * Live settings source (the settings panel's document). When present it wins
     * over the static `history` config, so a switch flipped in the UI takes effect
     * without restarting DSH.
     */
    readonly settings?: () => BrowserSettings;
    /** Maximum snapshot elements before truncation. Default 60. */
    readonly snapshotMaxElements?: number;
    /** Maximum content characters before truncation when no maxChars is given. No longer read: the cap is per format (html and json 50 000, otherwise 20 000). */
    readonly contentMaxChars?: number;
    /**
     * Directory `browser_download` save paths must resolve inside (prevents a
     * prompt-injected agent from writing arbitrary machine paths). Default:
     * `~/Downloads`. NOTE: this default is a convenience, not a security
     * boundary — on Windows it may resolve to OneDrive/redirected paths;
     * a production deployment should set an explicit, verified path.
     */
    readonly downloadDir?: string;
}
/**
 * CDP method/params for `Page.navigate`, as sent to {@link ElectronViewHandle.sendCommand}.
 */
export interface CdpNavigateParams {
    readonly url: string;
}
/**
 * CDP method/params for `Input.dispatchMouseEvent`: a pointer move, or one half
 * of a click's press+release pair. `button`/`clickCount` belong to the press and
 * release halves; a move carries only the position.
 */
export interface CdpMouseParams {
    readonly type: 'mouseMoved' | 'mousePressed' | 'mouseReleased';
    readonly x: number;
    readonly y: number;
    readonly button?: 'left';
    readonly clickCount?: number;
}
/** CDP method/params for `Input.insertText`. */
export interface CdpInsertTextParams {
    readonly text: string;
}
/** CDP method/params for `Runtime.evaluate`. */
export interface CdpEvaluateParams {
    readonly expression: string;
    readonly returnByValue: boolean;
    readonly awaitPromise?: boolean;
}
/** CDP method for a full-page screenshot capture. */
export declare const CDP_PAGE_CAPTURE_SCREENSHOT = "Page.captureScreenshot";
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
export declare function layoutSize(metrics: Record<string, unknown>): {
    width: number;
    height: number;
    viewportHeight: number;
} | undefined;
/**
 * Map CDP cookies onto the shape `browser_auth` exports.
 *
 * CDP reports a cookie as domain + path rather than a URL, and in seconds rather than
 * milliseconds, so both are converted. Entries missing a name, value or domain are
 * dropped rather than exported as broken cookies the caller cannot restore.
 * @param raw - the `cookies` array from a CDP response, of unknown shape.
 * @returns the mappable cookies.
 */
export declare function toExportedCookies(raw: unknown): ExportedCookie[];
/**
 * Map an exported cookie onto the fields `Storage.setCookies` expects.
 *
 * An exported cookie may carry only a URL, so the domain and path are recovered from it
 * when they are absent; without either, CDP cannot place the cookie and it is skipped.
 * @param cookie - the cookie to convert.
 * @returns the CDP cookie, or undefined when it lacks a usable domain.
 */
export declare function toCdpCookie(cookie: ExportedCookie): Record<string, unknown> | undefined;
/** Native capture options the self-hosted view handle understands. */
export interface ScreenshotOptions {
    readonly format?: 'png' | 'jpeg';
    readonly quality?: number;
    readonly maxWidth?: number;
    readonly maxHeight?: number;
}
/** CDP method for runtime evaluation (the execute path). */
export declare const CDP_RUNTIME_EVALUATE = "Runtime.evaluate";
/** CDP method for navigation. */
export declare const CDP_PAGE_NAVIGATE = "Page.navigate";
/** Supported key names, exported for the tool's enum and error messages. */
export declare const BROWSER_KEY_NAMES: readonly string[];
/**
 * Browser provider over Electron views. Sessions hold an ordered list of
 * tabs; each tab is one view created by the host. The active tab receives
 * every operation; switching tabs calls the host's optional `showView` and
 * never loses state. Navigation is admitted only for HTTP(S) targets unless
 * {@link ElectronBrowserProviderConfig.httpOnly} is disabled.
 */
export declare class ElectronBrowserProvider implements BrowserProvider {
    private readonly host;
    readonly id = "electron";
    private readonly sessions;
    private readonly httpOnly;
    private readonly snapshotMaxElements;
    private readonly contentMaxChars;
    private readonly downloadDir;
    /**
     * Persistent browsing history, or `undefined` when the user turned it off.
     * Sessions come and go; this record outlives all of them.
     */
    private readonly historyStore;
    /** Live settings source; absent when nothing owns a settings document. */
    private readonly settingsSource;
    constructor(host: ElectronBrowserViewHost, config?: ElectronBrowserProviderConfig);
    /**
     * Usable when the host says it can back views (the self-hosted host probes
     * for a usable Electron binary; the desktop shell is assumed usable).
     */
    available(): boolean;
    /**
     * Open a NEW browser session with its own view. Every call mints a fresh
     * session id and backing view; per-task reuse is owned by the caller (the
     * tool layer caches one session per DSH task). Sessions are isolated from
     * each other: each keeps its own tabs, active tab, and history, and only
     * the active tab of a session is made visible.
     * @param label - optional human-readable label (e.g. the DSH task id) shown
     * in the window title so a human can tell which task's page is visible.
     */
    open(label?: string): Promise<BrowserSessionId>;
    /** Open a URL in the active tab (default) or a new tab. */
    openUrl(session: BrowserSessionId, request: BrowserOpenRequest, signal?: AbortSignal): Promise<void>;
    /** List the session's tabs with their titles. */
    listTabs(session: BrowserSessionId): Promise<readonly BrowserTab[]>;
    /** Switch to a tab by id, making its view visible. */
    switchTab(session: BrowserSessionId, tabId: string): Promise<void>;
    /** Close one tab; closing the active tab activates the next. */
    closeTab(session: BrowserSessionId, tabId: string): Promise<void>;
    /**
     * Find a tab by id, preferring the calling session. Tab ids are globally
     * unique UUIDs, so when the calling session does not hold the tab (the tool
     * layer's session resolution can drift from the session that opened it),
     * fall back to locating it in any other session instead of failing — the
     * caller explicitly named a tab, so acting on it is what they want. Throws
     * BROWSER_TAB_UNKNOWN with the session's actual tabs when the id exists
     * nowhere.
     */
    private locateTab;
    /** Close every tab and reset to one blank tab. */
    reset(session: BrowserSessionId): Promise<void>;
    /** Navigate the active tab's view to a URL, honoring HTTP(S)-only admission. */
    navigate(session: BrowserSessionId, request: {
        readonly url: string;
    }, signal?: AbortSignal): Promise<void>;
    /**
     * A per-document stamp: `performance.timeOrigin` is unique per document load,
     * so it tells a same-URL reload and an A→B→A redirect apart from the document
     * that was current before the navigation. Empty string when unreadable.
     */
    private documentStamp;
    /**
     * One cheap in-page reading of the document's identity and parse state.
     *
     * Returns null when the page did NOT answer (mid-commit, execution context
     * destroyed) — the caller keeps waiting. A page that answered with an
     * unexpected shape (an override or a non-conforming host; the production
     * expression always yields a string) is reported as `unknown` rather than as
     * "no answer": blocking the navigation for the whole budget on a page that
     * demonstrably responded has no upside.
     */
    private documentProbe;
    /**
     * Page.navigate resolves at navigation COMMIT, not at load: the new document
     * is already current (so location.href and document.title are the new page's)
     * while its DOM is still being parsed. browser_open snapshots immediately
     * after navigating, which is why it could report the right title with zero
     * interactive elements — and why a separate browser_snapshot right after
     * always found them.
     *
     * Wait — bounded, best-effort — for the new document to settle: readyState
     * must reach interactive/complete AND the document identity must have
     * changed. A page that never settles must not fail a navigation that already
     * succeeded, so a timeout here is swallowed.
     */
    private settleDocument;
    /**
     * Make sure the active tab's view can actually receive synthesized input.
     * Chromium drops `Input.*` events for a view with no display surface, so this
     * runs before click/type/key and fails loudly (BROWSER_VIEW_NOT_PRESENTED)
     * rather than reporting a success the page never saw.
     * @param s - the session whose active view must be presented.
     * @param signal - optional cancellation.
     * @returns the view the session's active tab has AFTER the presentation barrier.
     */
    private present;
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
    private assertSameView;
    /**
     * Give the view web focus before synthesizing keyboard input.
     *
     * A renderer only delivers key events to the view that holds web focus. A
     * view that was created but never clicked holds none — and `Input` events
     * injected over CDP do not grant it — so the FIRST `browser_key` of a fresh
     * session vanished inside the renderer while the command still answered
     * success. Hosts that cannot focus a view (a test double, a different shell
     * adapter) simply have no `focus`, and nothing changes for them.
     */
    private focusView;
    /** Execute JS in the active tab's page context. */
    execute(session: BrowserSessionId, request: BrowserExecuteRequest, signal?: AbortSignal): Promise<BrowserExecuteResult>;
    /**
     * Poll until the active tab's page is ready (and optional URL/selector
     * match), or the budget runs out. Returns a verdict instead of throwing on
     * timeout — the caller (model) decides what a miss means. Polling evaluates
     * in the CURRENT document, so after a navigation the old document may
     * briefly answer; pass the expected `url` to disambiguate.
     */
    waitFor(session: BrowserSessionId, request: BrowserWaitRequest, signal?: AbortSignal): Promise<BrowserWaitResult>;
    /** Produce an AI-friendly snapshot of the active tab. */
    snapshot(session: BrowserSessionId, signal?: AbortSignal): Promise<BrowserSnapshotResult>;
    /**
     * Read the active tab's accessibility tree: semantic roles/names/states for
     * every interactive node (Chrome's `computedRole`/`computedName` when
     * available, tag/attribute inference otherwise). Pierces same-origin
     * iframes and shadow roots like the snapshot; cross-origin frames stay
     * opaque. Coordinates are top-document viewport-relative, so a node can
     * also be driven by click/type.
     */
    a11y(session: BrowserSessionId, request: BrowserA11yRequest, signal?: AbortSignal): Promise<BrowserA11yResult>;
    /** Check whether a human-verification challenge is blocking the active tab. */
    detectChallenge(session: BrowserSessionId, signal?: AbortSignal): Promise<BrowserChallenge>;
    /** Fetch page content in a requested format. */
    content(session: BrowserSessionId, request: BrowserContentRequest, signal?: AbortSignal): Promise<BrowserContentResult>;
    /**
     * Click at viewport coordinates, or at a located element's center when a
     * `target` (css/text/xpath) is given. CDP mousePressed + mouseReleased.
     */
    click(session: BrowserSessionId, request: BrowserClickRequest | {
        readonly target: BrowserElementTarget;
    }, signal?: AbortSignal): Promise<void>;
    /**
     * Type into the focused element, or focus a located element (css/text/xpath)
     * first and then insert the text.
     */
    type(session: BrowserSessionId, request: BrowserTypeRequest | {
        readonly target: BrowserElementTarget;
    }, signal?: AbortSignal): Promise<void>;
    /** Scroll the page: by deltas, to a selector, or to top/bottom. */
    scroll(session: BrowserSessionId, request: BrowserScrollRequest, signal?: AbortSignal): Promise<void>;
    /** Go back (-1) or forward (+1) in the active tab's navigation history. */
    private historyStep;
    /** Go back in the active tab's history. */
    back(session: BrowserSessionId, signal?: AbortSignal): Promise<void>;
    /** Go forward in the active tab's history. */
    forward(session: BrowserSessionId, signal?: AbortSignal): Promise<void>;
    /** Reload the active tab. */
    reload(session: BrowserSessionId, signal?: AbortSignal): Promise<void>;
    /** Press one named key (Enter/Tab/arrows/…) via CDP key events. */
    key(session: BrowserSessionId, request: BrowserKeyRequest, signal?: AbortSignal): Promise<void>;
    /**
     * Fill a form's fields in one batch. Runs one page-context script that
     * resolves each field (selector, or name/label/placeholder among visible
     * controls), sets its value with the native prototype setter (React/Vue
     * controlled inputs included) plus input/change events, handles
     * select/checkbox/radio/contenteditable, and optionally submits the form.
     */
    fillForm(session: BrowserSessionId, request: BrowserFillRequest, signal?: AbortSignal): Promise<BrowserFillResult>;
    /**
     * Build an in-page async IIFE that locates ONE element by css/text/xpath
     * (polling until it appears or the budget runs out) and then runs `body`
     * with `el` in scope. Shared by the target-based tools: click/type (②),
     * setValue/check/select/clear/getValue (③), and the scrape item wait.
     * A selector that fails to PARSE is reported immediately instead of being
     * polled until the budget expires — see the comment in `match`.
     */
    private buildTargetScript;
    /**
     * Shared evaluate wrapper for the target-based tools. Runs the in-page
     * script and returns its result object; throws a typed BrowserError on
     * evaluation failure or an in-page `{ ok: false, error }` verdict.
     */
    private runTargetScript;
    /** Set one element's value (native setter + input/change, React-friendly). */
    setValue(session: BrowserSessionId, request: BrowserSetValueRequest, signal?: AbortSignal): Promise<BrowserSetValueResult>;
    /** Check or uncheck one checkbox/radio. */
    check(session: BrowserSessionId, request: BrowserCheckRequest, signal?: AbortSignal): Promise<{
        readonly checked: boolean;
    }>;
    /** Select one option of a <select>, by value, visible text, or index. */
    selectOption(session: BrowserSessionId, request: BrowserSelectRequest, signal?: AbortSignal): Promise<BrowserSelectResult>;
    /** Clear one input/textarea/contenteditable (or uncheck a checkbox/radio). */
    clearField(session: BrowserSessionId, request: BrowserClearRequest, signal?: AbortSignal): Promise<{
        readonly cleared: boolean;
    }>;
    /** Read one element's current value (for verification). */
    getValue(session: BrowserSessionId, request: BrowserGetValueRequest, signal?: AbortSignal): Promise<BrowserGetValueResult>;
    /**
     * Extract structured data from repeated DOM items (static CSS, CSP-safe —
     * no arbitrary code runs). Waits for the item selector, then maps each item
     * through the field selectors; `selector@attr` reads an attribute instead
     * of text (`a@href` yields an absolute URL).
     */
    scrape(session: BrowserSessionId, request: BrowserScrapeRequest, signal?: AbortSignal): Promise<BrowserScrapeResult>;
    /**
     * Refuse an action the settings have switched off.
     *
     * These switches belong to the OPERATOR. The settings document is written through the
     * plugin's own panel and no tool can reach it, so — unlike `browser_restrict`, which the
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
    private assertActionAllowed;
    /**
     * Admit a caller-supplied save path for a file the browser writes to disk.
     * ONE gate for both `browser_download` and `browser_screenshot`: the path
     * must be absolute, must resolve inside `downloadDir`, and must not already
     * exist. Without it a prompt-injected agent could write — or silently
     * replace — any file the DSH process can reach, which also escapes the file
     * sandbox every other tool in the set runs under.
     * @param savePath - the caller's target path.
     * @param kind - the operation, used in the error code and message.
     * @returns the resolved absolute target path.
     * @throws BrowserError when the path is relative, outside the directory, or occupied.
     */
    private admitSavePath;
    /**
     * Download an HTTP(S) URL with the session's cookies to a local file.
     * Admission is the shared {@link admitSavePath} gate; only the self-hosted
     * host implements it (the desktop shell's embedded views delegate downloads
     * to the real browser UI). Both admitted paths and screenshots are confined
     * to `downloadDir`, so a prompt-injected agent cannot write arbitrary
     * machine paths.
     * @param session - the session whose cookies are used.
     * @param request - the URL plus the absolute target path.
     * @param signal - optional cancellation.
     * @returns the path the file was written to.
     */
    download(session: BrowserSessionId, request: {
        readonly url: string;
        readonly savePath: string;
    }, signal?: AbortSignal): Promise<{
        readonly path: string;
    }>;
    /**
     * Export the session's cookies (login state) as serializable objects.
     * Self-hosted only; the desktop shell's embedded views use the real profile.
     */
    flushAuth(session: BrowserSessionId): Promise<readonly ExportedCookie[]>;
    /** Import cookies into the session (restore login state). Self-hosted only. */
    restoreAuth(session: BrowserSessionId, cookies: readonly ExportedCookie[]): Promise<number>;
    /** Capture the current page, optionally full-page, PNG or JPEG, scalable. */
    screenshot(session: BrowserSessionId, request?: BrowserScreenshotRequest, signal?: AbortSignal): Promise<{
        readonly dataUrl: string;
        readonly path?: string;
    }>;
    /**
     * Build the data URL and optionally write the image to disk. The caller's
     * path goes through the SAME {@link admitSavePath} gate as a download — it
     * must be absolute, resolve inside `downloadDir`, and not be an existing
     * file — so a screenshot cannot be used to write to, or silently replace,
     * files anywhere the DSH process happens to have permission (issue #13).
     */
    private saveScreenshot;
    /** Append one operation to the session's history. */
    private record;
    /** Return the session's chronological operation log (newest last). */
    history(session: BrowserSessionId): Promise<readonly BrowserHistoryEntry[]>;
    /**
     * Record one page visit in the persistent browsing history. Fire-and-forget by
     * design: a visit must never delay or fail the navigation that produced it,
     * and the title is only worth reading once the document has settled.
     * @param s - the session that drove the visit.
     * @param handle - the view whose document just loaded.
     */
    private recordVisit;
    /**
     * List persisted visits, newest first — what `browser_visited` reads back.
     * @param options - result cap and an optional hostname filter.
     * @returns the matching visits, or an empty list when history is disabled.
     */
    visited(options?: {
        readonly limit?: number;
        readonly domain?: string;
        readonly query?: string;
        readonly session?: string;
    }): readonly VisitedPage[];
    /**
     * Show the synthetic pointer on a view, unless the user switched it off. The
     * cursor is the "the agent has taken over this tab" signal, so it is painted
     * for every operation that has a landing point — including DOM-level ones that
     * move no real pointer.
     * @param handle - the view to paint into.
     * @param x - viewport x in CSS pixels.
     * @param y - viewport y in CSS pixels.
     * @param action - click pulses a ripple; move only relocates.
     * @param label - short description of the operation, shown beside the pointer.
     * @param force - paint even when the pointer is already there (a click ripple must
     *   always play; a bare move need not repeat).
     */
    private showCursor;
    /**
     * Replay one recorded operation by sequence number. Navigate/click/type are
     * re-issued against the current page; execute re-runs its script. The
     * replayed step is appended to history as a new entry.
     * @param session - the session id.
     * @param seq - the recorded entry's sequence number to replay.
     */
    replay(session: BrowserSessionId, seq: number): Promise<void>;
    /** Close the session and destroy all its views. Idempotent. */
    close(session: BrowserSessionId): Promise<void>;
    /** Look up a session or throw the unknown-session error. */
    private session;
    /** The active tab of a session. */
    private activeTab;
    /** Append a fresh tab and make it active. */
    private newTab;
    /** Find a session's tab by its backing view id (toolbar actions carry view ids). */
    private tabByViewId;
    /**
     * Whether a session is still live. The human closing a window ends its session
     * (see {@link handleViewClosed}), so callers that cache ids must ask first.
     * @param session - the session id to test.
     */
    exists(session: BrowserSessionId): boolean;
    /**
     * The human closed a browser window: the session that window showed is over.
     * Ending it here is what makes the next call a clean start rather than a
     * resurrection of an invisible window. Browsing history and login state live
     * on disk, so nothing the human cares about is lost with it.
     * @param windowId - the group key the host reported, which is the session id.
     */
    private handleViewClosed;
    /**
     * Route a user-initiated action from the host's UI into the session model.
     * Fire-and-forget by design: a user action failing (e.g. an unreachable
     * URL typed into the address bar) must never crash the host UI loop — it
     * is reported to the host (toolbar) when the host supports it, else logged.
     */
    private handleUserAction;
    /**
     * Report a failed user action to the host UI (toolbar), when supported.
     *
     * Two properties matter here, because this runs inside the catch of an async
     * handler (issue #16):
     *  - the receiver must be preserved. Reading the method off the host and calling
     *    it unbound runs the host's implementation with `this === undefined`, so its
     *    very first statement (`void this.ready()`) throws, the throw escapes the
     *    async catch as an unhandled rejection, and the whole DSH host exits;
     *  - this method must be incapable of throwing. Reporting a failed action is
     *    diagnostics: it can never be allowed to become the failure.
     */
    private notifyUserActionError;
    /**
     * Ask the host to show the active tab's view, carrying the session label.
     *
     * The two halves are sequential, not alternatives. `showView` makes the view the
     * visible one — which is what keeps what the human sees in step with what the agent
     * drives, and what lets `capturePage` return an image at all (a hidden view captures
     * empty) — while `collapse` folds the carrier's own chrome away when the user asked
     * for no auto-expand. Making them exclusive meant that with auto-expand off this
     * method did nothing at all on carriers without `collapse` (the self-hosted one),
     * silently desynchronising the two and failing every screenshot.
     */
    private showActive;
    /** Read the current URL of a view through CDP. */
    private currentUrl;
}
