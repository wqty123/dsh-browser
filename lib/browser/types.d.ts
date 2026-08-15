/**
 * Vocabulary for the browser capability seam (`ctx.browser`). One seam owns
 * provider registration, session lifecycle, cancellation, errors, and product
 * configuration; providers differ only in what backs a session (an Electron
 * `WebContentsView` in the desktop shell, a headless Chromium relay for
 * remote deployments, and so on).
 * @module dsh-browser/browser/types
 */
import { HarnessError } from '@deepseek-ai/dsh-llm';
/**
 * Stable identity of one browser session, resolved by the Host through a
 * Typert `LookupMap` to the live session object (the same mechanism
 * `Agent → agentId` uses). The id is opaque to the wire; only the provider
 * and its host binding can interpret it.
 */
export type BrowserSessionId = string;
/**
 * What one browser-capable backend is asked to do. Navigation is the minimal
 * operation every provider shares; the seam deliberately keeps the request
 * minimal so a provider swap never changes how the model asks.
 */
export interface BrowserNavigateRequest {
    /** The URL to open. Admission (HTTP(S) only, no credentials/private targets) is provider-owned. */
    readonly url: string;
}
/**
 * Click at viewport coordinates. Coordinates are viewport-relative pixels in
 * the session's own coordinate space — the same space the human interacts
 * with, so a real view and a relay agree without scaling.
 */
export interface BrowserClickRequest {
    /** Viewport-relative x in CSS pixels. */
    readonly x: number;
    /** Viewport-relative y in CSS pixels. */
    readonly y: number;
}
/** Type text into the focused element. */
export interface BrowserTypeRequest {
    /** The text to insert. */
    readonly text: string;
}
/**
 * A screenshot of the current page state. `dataUrl` is a base64 data URL the
 * tool layer renders directly; the live view itself never crosses the wire
 * (the human watches the real view in the desktop shape).
 */
export interface BrowserScreenshotResult {
    /** Base64 data URL of the capture (PNG or JPEG per the request). */
    readonly dataUrl: string;
    /** File path the capture was also saved to, when the request asked for it. */
    readonly path?: string;
}
/** Screenshot capture options. PNG only (CDP JPEG hangs on Electron 43). */
export interface BrowserScreenshotRequest {
    /** Capture the full scrollable page instead of the viewport. Default false. */
    readonly fullPage?: boolean;
    /** Absolute file path to also save the PNG to (for vision-tool reads). */
    readonly savePath?: string;
}
/** Download options: fetch a URL into a local file, keeping the session's cookies. */
export interface BrowserDownloadRequest {
    /** The URL to download. */
    readonly url: string;
    /** Absolute path of the file to write. */
    readonly savePath: string;
}
/** A serializable cookie, exported from or imported into the browser session. */
export interface ExportedCookie {
    /** Cookie URL (scheme + domain + path), as accepted by cookies.set. */
    readonly url: string;
    readonly name: string;
    readonly value: string;
    readonly domain?: string;
    readonly path?: string;
    readonly secure?: boolean;
    readonly httpOnly?: boolean;
    readonly expirationDate?: number;
}
/**
 * Execute arbitrary JavaScript in the session's page context. This is the
 * primary interaction path — DOM-referenced, not screen-coordinate-based:
 * focus/input/click go through the page's own JS (native setters for
 * framework-controlled inputs), matching how a human-driven agent operates.
 */
export interface BrowserExecuteRequest {
    /** The JavaScript expression to evaluate in the page context. */
    readonly script: string;
    /** Optional arguments injected into the script scope as `arguments[0..n]`. */
    readonly args?: readonly unknown[];
    /** Evaluation budget in ms; a wedged page rejects with a timeout. Default 30000. */
    readonly timeoutMs?: number;
}
/**
 * Result of an execute. Mirrors CDP `Runtime.evaluate` semantics: either a
 * value (by value, not by reference) or the exception thrown.
 */
export type BrowserExecuteResult = {
    readonly ok: true;
    readonly value: unknown;
} | {
    readonly ok: false;
    readonly exception: string;
};
/**
 * One interactive element in a snapshot, with a stable reference number the
 * tool layer (and the model) can cite to target the element.
 */
export interface BrowserSnapshotElement {
    /** 1-based reference number, stable for the lifetime of one snapshot. */
    readonly ref: number;
    /** Element kind: 'input' | 'button' | 'link' | 'textarea' | 'select' | 'checkbox' | 'other'. */
    readonly kind: string;
    /** Text content or placeholder/label, truncated for the snapshot. */
    readonly label: string;
    /** Best-effort CSS selector; may be empty when none is derivable. */
    readonly selector: string;
    /** Viewport-relative center, for coordinate fallbacks. */
    readonly x: number;
    readonly y: number;
}
/**
 * AI-friendly page snapshot: a compact, numbered inventory of interactive
 * elements plus page facts. Not raw HTML — the model dialogues with this.
 */
export interface BrowserSnapshotResult {
    /** Final page URL. */
    readonly url: string;
    /** Page title, if any. */
    readonly title?: string;
    /** Numbered interactive elements. */
    readonly elements: readonly BrowserSnapshotElement[];
    /** True when the snapshot was truncated (element cap reached). */
    readonly truncated: boolean;
}
/**
 * Content fetch formats. `html` is the raw DOM; `markdown` is a structured
 * reading view; `txt` is plain text (smallest); `json` is structured data.
 */
export type BrowserContentFormat = 'html' | 'markdown' | 'txt' | 'json';
/** Content fetch request: format, optional selector scoping, and caps. */
export interface BrowserContentRequest {
    /** Desired format. */
    readonly format: BrowserContentFormat;
    /** Optional CSS selector limiting the fetch to one region (e.g. `#main`). */
    readonly selector?: string;
    /** Maximum characters of the returned content. */
    readonly maxChars?: number;
    /** Evaluation timeout in ms; the fetch aborts after this. Default 30000. */
    readonly timeoutMs?: number;
}
/** A fetched page content in the requested format. */
export interface BrowserContentResult {
    /** The content in the requested format, capped at `maxChars`. */
    readonly content: string;
    /** True when the content was truncated. */
    readonly truncated: boolean;
}
/**
 * A tab inside a browser session. Tabs share the session's profile/cookies
 * and are switchable without losing state.
 */
export interface BrowserTab {
    /** Stable tab id within the session. */
    readonly id: string;
    /** Current URL, or empty for a blank tab. */
    readonly url: string;
    /** Page title, if any. */
    readonly title?: string;
    /** Whether this tab is the active one. */
    readonly active: boolean;
}
/** Request to open a URL: into the active tab or a new tab. */
export interface BrowserOpenRequest {
    /** The URL to open. */
    readonly url: string;
    /** Open in a new tab (parallel). Default false (reuse the active tab). */
    readonly newTab?: boolean;
}
/**
 * A browser-capable backend. Registered with `ctx.browser.registerBrowserProvider`.
 * `id` is a stable string, unique across the seam.
 */
export interface BrowserProvider {
    readonly id: string;
    /** Cheap local usability check; must not make network calls. */
    available(): boolean;
    /**
     * Open a new session. The provider mints the session id and prepares its
     * backing surface (a view, a headless page, and so on). Sessions are isolated from
     * each other; a session must not be visible to any other session's caller.
     */
    open(): Promise<BrowserSessionId>;
    /** Open a URL, optionally in a new tab. Honor `signal` for cancellation. */
    openUrl(session: BrowserSessionId, request: BrowserOpenRequest, signal?: AbortSignal): Promise<void>;
    /** List the session's tabs. */
    listTabs(session: BrowserSessionId): Promise<readonly BrowserTab[]>;
    /** Switch to a tab by id. Unknown id -> `BROWSER_TAB_UNKNOWN`. */
    switchTab(session: BrowserSessionId, tabId: string): Promise<void>;
    /** Close one tab. Closing the active tab activates the next. */
    closeTab(session: BrowserSessionId, tabId: string): Promise<void>;
    /** Close every tab and reset the session's state. */
    reset(session: BrowserSessionId): Promise<void>;
    /** Navigate the active tab. Honor `signal` for cancellation. */
    navigate(session: BrowserSessionId, request: BrowserNavigateRequest, signal?: AbortSignal): Promise<void>;
    /** Execute JS in the active tab's page context. */
    execute(session: BrowserSessionId, request: BrowserExecuteRequest, signal?: AbortSignal): Promise<BrowserExecuteResult>;
    /** Produce an AI-friendly snapshot of the active tab. */
    snapshot(session: BrowserSessionId, signal?: AbortSignal): Promise<BrowserSnapshotResult>;
    /** Fetch page content in a requested format. */
    content(session: BrowserSessionId, request: BrowserContentRequest, signal?: AbortSignal): Promise<BrowserContentResult>;
    /** Click at viewport coordinates (fallback path; execute is preferred). Honor `signal` for cancellation. */
    click(session: BrowserSessionId, request: BrowserClickRequest, signal?: AbortSignal): Promise<void>;
    /** Type into the focused element (fallback path). Honor `signal` for cancellation. */
    type(session: BrowserSessionId, request: BrowserTypeRequest, signal?: AbortSignal): Promise<void>;
    /** Capture the current page. Honor `signal` for cancellation. */
    screenshot(session: BrowserSessionId, request?: BrowserScreenshotRequest, signal?: AbortSignal): Promise<BrowserScreenshotResult>;
    /** Download a URL to a local file. Honor `signal` for cancellation. */
    download(session: BrowserSessionId, request: BrowserDownloadRequest, signal?: AbortSignal): Promise<{
        readonly path: string;
    }>;
    /** Export the session's cookies (login state). */
    flushAuth(session: BrowserSessionId): Promise<readonly ExportedCookie[]>;
    /** Import cookies into the session (restore login state). */
    restoreAuth(session: BrowserSessionId, cookies: readonly ExportedCookie[]): Promise<number>;
    /** Return the session's chronological operation log. */
    history(session: BrowserSessionId): Promise<readonly BrowserHistoryEntry[]>;
    /** Replay one recorded operation by sequence number. */
    replay(session: BrowserSessionId, seq: number): Promise<void>;
    /** Close the session and destroy its backing surface. Idempotent. */
    close(session: BrowserSessionId): Promise<void>;
}
/** One recorded browser operation, in chronological order (seq 1, 2, 3…). */
export interface BrowserHistoryEntry {
    /** Monotonic sequence number within the session. */
    readonly seq: number;
    /** The operation name: navigate | execute | click | type | replay. */
    readonly action: string;
    /** The operation's arguments. */
    readonly params: Record<string, unknown>;
    /** Whether the operation succeeded. */
    readonly ok: boolean;
    /** Truncated result text, when the operation returned one. */
    readonly result?: string;
    /** Error text, when the operation failed. */
    readonly error?: string;
    /** Epoch millis of the operation. */
    readonly at: number;
}
/**
 * Typed browser error with a machine-routable, open-string `code` and chained
 * `cause`. Consumers must tolerate provider-specific codes. Shared codes cover
 * unavailable, missing, unusable, ambiguous, or duplicate providers, unknown
 * or closed sessions, cancellation, and provider failure; a provider adds its
 * own (e.g. `BROWSER_CDP_ATTACH_FAILED`).
 */
export declare class BrowserError extends HarnessError {
}
