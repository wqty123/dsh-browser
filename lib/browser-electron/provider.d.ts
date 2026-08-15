/**
 * Electron-backed browser provider: `WebContentsView` sessions driven over
 * `webContents.debugger` (CDP). The provider itself does not import Electron — it operates through the {@link ElectronBrowserViewHost} seam, which the
 * desktop shell implements with real Electron objects. That keeps this
 * package testable under plain Node and leaves the Electron dependency to the
 * shell that owns the `BrowserWindow`.
 * @module dsh-browser/browser-electron
 */
import type { BrowserChallenge, BrowserContentRequest, BrowserContentResult, BrowserExecuteRequest, BrowserExecuteResult, BrowserHistoryEntry, BrowserOpenRequest, BrowserProvider, BrowserSessionId, BrowserSnapshotResult, BrowserTab, ExportedCookie } from '../browser/types.ts';
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
     */
    showView?(handle: ElectronViewHandle): void;
}
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
}
/** Provider config: navigation admission defaults and snapshot caps. */
export interface ElectronBrowserProviderConfig {
    /** Allow navigation only to HTTP(S) URLs; reject anything else. Default true. */
    readonly httpOnly?: boolean;
    /** Maximum snapshot elements before truncation. Default 60. */
    readonly snapshotMaxElements?: number;
    /** Maximum content characters before truncation when no maxChars is given. Default 100_000. */
    readonly contentMaxChars?: number;
}
/**
 * CDP method/params for `Page.navigate`, as sent to {@link ElectronViewHandle.sendCommand}.
 */
export interface CdpNavigateParams {
    readonly url: string;
}
/**
 * CDP method/params for `Input.dispatchMouseEvent` (a click press+release pair).
 */
export interface CdpMouseParams {
    readonly type: 'mousePressed' | 'mouseReleased';
    readonly x: number;
    readonly y: number;
    readonly button: 'left';
    readonly clickCount: number;
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
/** CDP method for runtime evaluation (the execute path). */
export declare const CDP_RUNTIME_EVALUATE = "Runtime.evaluate";
/** CDP method for navigation. */
export declare const CDP_PAGE_NAVIGATE = "Page.navigate";
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
    constructor(host: ElectronBrowserViewHost, config?: ElectronBrowserProviderConfig);
    /** Usable whenever the host can create views (always in the desktop shell). */
    available(): boolean;
    /**
     * Open a NEW browser session with its own view. Every call mints a fresh
     * session id and backing view; per-task reuse is owned by the caller (the
     * tool layer caches one session per DSH task). Sessions are isolated from
     * each other: each keeps its own tabs, active tab, and history, and only
     * the active tab of a session is made visible.
     */
    open(): Promise<BrowserSessionId>;
    /** Open a URL in the active tab (default) or a new tab. */
    openUrl(session: BrowserSessionId, request: BrowserOpenRequest, signal?: AbortSignal): Promise<void>;
    /** List the session's tabs with their titles. */
    listTabs(session: BrowserSessionId): Promise<readonly BrowserTab[]>;
    /** Switch to a tab by id, making its view visible. */
    switchTab(session: BrowserSessionId, tabId: string): Promise<void>;
    /** Close one tab; closing the active tab activates the next. */
    closeTab(session: BrowserSessionId, tabId: string): Promise<void>;
    /** Close every tab and reset to one blank tab. */
    reset(session: BrowserSessionId): Promise<void>;
    /** Navigate the active tab's view to a URL, honoring HTTP(S)-only admission. */
    navigate(session: BrowserSessionId, request: {
        readonly url: string;
    }, signal?: AbortSignal): Promise<void>;
    /** Execute JS in the active tab's page context. */
    execute(session: BrowserSessionId, request: BrowserExecuteRequest, signal?: AbortSignal): Promise<BrowserExecuteResult>;
    /** Produce an AI-friendly snapshot of the active tab. */
    snapshot(session: BrowserSessionId, signal?: AbortSignal): Promise<BrowserSnapshotResult>;
    /** Check whether a human-verification challenge is blocking the active tab. */
    detectChallenge(session: BrowserSessionId, signal?: AbortSignal): Promise<BrowserChallenge>;
    /** Fetch page content in a requested format. */
    content(session: BrowserSessionId, request: BrowserContentRequest, signal?: AbortSignal): Promise<BrowserContentResult>;
    /** Click at viewport coordinates (CDP mousePressed + mouseReleased). */
    click(session: BrowserSessionId, request: {
        readonly x: number;
        readonly y: number;
    }, signal?: AbortSignal): Promise<void>;
    /** Type into the focused element. */
    type(session: BrowserSessionId, request: {
        readonly text: string;
    }, signal?: AbortSignal): Promise<void>;
    /**
     * Download a URL to a local file, keeping the session's cookies/login.
     * Requires the self-hosted host (which implements view-level download); the
     * desktop shell's embedded views delegate downloads to the real browser UI.
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
    /** Capture the current page, optionally full-page. PNG only (CDP JPEG hangs on Electron 43). */
    screenshot(session: BrowserSessionId, request?: {
        readonly fullPage?: boolean;
        readonly savePath?: string;
    }, signal?: AbortSignal): Promise<{
        readonly dataUrl: string;
        readonly path?: string;
    }>;
    /** Append one operation to the session's history. */
    private record;
    /** Return the session's chronological operation log (newest last). */
    history(session: BrowserSessionId): Promise<readonly BrowserHistoryEntry[]>;
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
    /** Ask the host to show the active tab's view. */
    private showActive;
    /** Read the current URL of a view through CDP. */
    private currentUrl;
}
