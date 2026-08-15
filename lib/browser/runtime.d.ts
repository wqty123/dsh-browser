/**
 * Service Definition for the browser capability seam (`ctx.browser`): the
 * provider registry and provider-selecting execution for browser sessions.
 * Duplicate ids are rejected. At execution time, a configured provider must
 * exist and be usable; without one, exactly one usable provider is required,
 * so selection never depends on registration order.
 * @module dsh-browser/browser
 */
import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import type { BrowserClickRequest, BrowserContentRequest, BrowserContentResult, BrowserDownloadRequest, BrowserExecuteRequest, BrowserExecuteResult, BrowserFillRequest, BrowserFillResult, BrowserHistoryEntry, BrowserNavigateRequest, BrowserOpenRequest, BrowserProvider, BrowserScreenshotRequest, BrowserScreenshotResult, BrowserSessionId, BrowserSnapshotResult, BrowserTab, BrowserTypeRequest, BrowserChallenge, ExportedCookie } from './types.ts';
export { BrowserError, } from './types.ts';
export type { BrowserChallenge, BrowserClickRequest, BrowserContentFormat, BrowserContentRequest, BrowserContentResult, BrowserDownloadRequest, BrowserExecuteRequest, BrowserExecuteResult, BrowserFillField, BrowserFillRequest, BrowserFillResult, BrowserHistoryEntry, BrowserNavigateRequest, BrowserOpenRequest, BrowserProvider, BrowserScreenshotRequest, BrowserScreenshotResult, BrowserSessionId, BrowserSnapshotElement, BrowserSnapshotResult, BrowserTab, BrowserTypeRequest, ExportedCookie, } from './types.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        browser: BrowserRuntime;
    }
}
/**
 * Config for the browser seam. `browserProvider` pins which provider wins;
 * it is optional (a single registered usable provider auto-selects).
 */
export interface BrowserRuntimeConfig {
    /** Explicit browser provider id. Omitted = auto-select when exactly one usable. */
    readonly browserProvider?: string;
}
/**
 * The browser access service. Registered as `ctx.browser` (one instance per
 * context).
 *
 * Selection semantics (resolved at execution time, never order-dependent):
 * - A configured id that is registered and `available()` → that provider.
 * - A configured id not registered → `BROWSER_PROVIDER_CONFIGURED_MISSING`.
 * - A configured id registered but unavailable → `BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE`.
 * - No id configured, exactly one registered usable provider → that provider.
 * - No id configured, multiple usable providers → `BROWSER_PROVIDER_AMBIGUOUS`.
 * - No id configured, no usable provider → `BROWSER_PROVIDER_UNAVAILABLE`.
 */
export declare class BrowserRuntime extends Service {
    /** Provider selection config. */
    static Config: z<BrowserRuntimeConfig>;
    private providers;
    private readonly providerId;
    constructor(ctx: Context, config?: BrowserRuntimeConfig);
    /**
     * Register a browser provider. Throws {@link BrowserError}
     * `BROWSER_DUPLICATE_PROVIDER` if its id is already registered. Returns a
     * disposer; disposed with the calling fiber.
     * @param provider - the provider; its `id` is the registry key.
     * @returns the disposer that unregisters the provider.
     */
    registerBrowserProvider(provider: BrowserProvider): () => void;
    /** Resolve the selected provider or throw the matching {@link BrowserError}. */
    private resolveProvider;
    /** Open a new browser session through the selected provider. */
    open(): Promise<BrowserSessionId>;
    /** Open a URL through the selected provider, optionally in a new tab. */
    openUrl(session: BrowserSessionId, request: BrowserOpenRequest, signal?: AbortSignal): Promise<void>;
    /** List the session's tabs through the selected provider. */
    listTabs(session: BrowserSessionId): Promise<readonly BrowserTab[]>;
    /** Switch to a tab through the selected provider. */
    switchTab(session: BrowserSessionId, tabId: string): Promise<void>;
    /** Close one tab through the selected provider. */
    closeTab(session: BrowserSessionId, tabId: string): Promise<void>;
    /** Close every tab and reset the session through the selected provider. */
    reset(session: BrowserSessionId): Promise<void>;
    /** Navigate the session's page through the selected provider. */
    navigate(session: BrowserSessionId, request: BrowserNavigateRequest, signal?: AbortSignal): Promise<void>;
    /** Execute JS in the session's page context through the selected provider. */
    execute(session: BrowserSessionId, request: BrowserExecuteRequest, signal?: AbortSignal): Promise<BrowserExecuteResult>;
    /** Produce an AI-friendly snapshot of the session's page. */
    snapshot(session: BrowserSessionId, signal?: AbortSignal): Promise<BrowserSnapshotResult>;
    /** Fetch page content in a requested format. */
    content(session: BrowserSessionId, request: BrowserContentRequest, signal?: AbortSignal): Promise<BrowserContentResult>;
    /** Click at viewport coordinates through the selected provider. */
    click(session: BrowserSessionId, request: BrowserClickRequest, signal?: AbortSignal): Promise<void>;
    /** Type into the focused element through the selected provider. */
    type(session: BrowserSessionId, request: BrowserTypeRequest, signal?: AbortSignal): Promise<void>;
    /** Fill a form's fields in one batch through the selected provider. */
    fillForm(session: BrowserSessionId, request: BrowserFillRequest, signal?: AbortSignal): Promise<BrowserFillResult>;
    /** Capture the current page through the selected provider. */
    screenshot(session: BrowserSessionId, request?: BrowserScreenshotRequest, signal?: AbortSignal): Promise<BrowserScreenshotResult>;
    /** Check for a human-verification challenge on the active tab. */
    detectChallenge(session: BrowserSessionId, signal?: AbortSignal): Promise<BrowserChallenge>;
    /** Return the session's chronological operation log through the provider. */
    history(session: BrowserSessionId): Promise<readonly BrowserHistoryEntry[]>;
    /** Replay one recorded operation by sequence number through the provider. */
    replay(session: BrowserSessionId, seq: number): Promise<void>;
    /** Download a URL to a local file through the provider. */
    download(session: BrowserSessionId, request: BrowserDownloadRequest, signal?: AbortSignal): Promise<{
        readonly path: string;
    }>;
    /** Export the session's cookies through the provider. */
    flushAuth(session: BrowserSessionId): Promise<readonly ExportedCookie[]>;
    /** Import cookies into the session through the provider. */
    restoreAuth(session: BrowserSessionId, cookies: readonly ExportedCookie[]): Promise<number>;
    /** Close the session through the selected provider. Idempotent; a missing
     *  provider is treated as already-closed so teardown paths stay no-ops. */
    close(session: BrowserSessionId): Promise<void>;
}
export default BrowserRuntime;
