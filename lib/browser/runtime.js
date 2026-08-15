/**
 * Service Definition for the browser capability seam (`ctx.browser`): the
 * provider registry and provider-selecting execution for browser sessions.
 * Duplicate ids are rejected. At execution time, a configured provider must
 * exist and be usable; without one, exactly one usable provider is required,
 * so selection never depends on registration order.
 * @module dsh-browser/browser
 */
import { Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { BrowserError } from "./types.js";
export { BrowserError, } from "./types.js";
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
export class BrowserRuntime extends Service {
    /** Provider selection config. */
    static Config = z.object({
        browserProvider: z.string(),
    });
    providers = new Map();
    providerId;
    constructor(ctx, config = {}) {
        super(ctx, 'browser');
        this.providerId = config.browserProvider;
    }
    /**
     * Register a browser provider. Throws {@link BrowserError}
     * `BROWSER_DUPLICATE_PROVIDER` if its id is already registered. Returns a
     * disposer; disposed with the calling fiber.
     * @param provider - the provider; its `id` is the registry key.
     * @returns the disposer that unregisters the provider.
     */
    registerBrowserProvider(provider) {
        if (this.providers.has(provider.id)) {
            throw new BrowserError(`a browser provider with id "${provider.id}" is already registered`, 'BROWSER_DUPLICATE_PROVIDER');
        }
        // Bind the generator to this instance instead of aliasing `this` to a
        // local (no-this-alias): the effect body mutates the instance registry.
        const dispose = this.ctx.effect(function* () {
            this.providers.set(provider.id, provider);
            yield () => this.providers.delete(provider.id);
        }.bind(this), 'browser.registerProvider()');
        // ctx.effect's disposer returns Promise<void>; our disposer API is
        // synchronous fire-and-forget — discard the (always-resolved) promise.
        return () => void dispose();
    }
    /** Resolve the selected provider or throw the matching {@link BrowserError}. */
    resolveProvider() {
        const { providerId, providers } = this;
        if (providerId !== undefined) {
            const provider = providers.get(providerId);
            if (!provider) {
                throw new BrowserError(`configured browser provider "${providerId}" is not registered`, 'BROWSER_PROVIDER_CONFIGURED_MISSING');
            }
            if (!provider.available()) {
                throw new BrowserError(`configured browser provider "${providerId}" is registered but unavailable`, 'BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE');
            }
            return provider;
        }
        const usable = [...providers.values()].filter(provider => provider.available());
        const [single] = usable;
        if (single === undefined) {
            throw new BrowserError('no usable browser provider is registered', 'BROWSER_PROVIDER_UNAVAILABLE');
        }
        if (usable.length > 1) {
            const ids = usable.map(provider => provider.id).join(', ');
            throw new BrowserError(`multiple usable browser providers are registered (${ids}); configure one explicitly`, 'BROWSER_PROVIDER_AMBIGUOUS');
        }
        return single;
    }
    /** Open a new browser session through the selected provider. */
    async open() {
        return this.resolveProvider().open();
    }
    /** Open a URL through the selected provider, optionally in a new tab. */
    async openUrl(session, request, signal) {
        return this.resolveProvider().openUrl(session, request, signal);
    }
    /** List the session's tabs through the selected provider. */
    async listTabs(session) {
        return this.resolveProvider().listTabs(session);
    }
    /** Switch to a tab through the selected provider. */
    async switchTab(session, tabId) {
        return this.resolveProvider().switchTab(session, tabId);
    }
    /** Close one tab through the selected provider. */
    async closeTab(session, tabId) {
        return this.resolveProvider().closeTab(session, tabId);
    }
    /** Close every tab and reset the session through the selected provider. */
    async reset(session) {
        return this.resolveProvider().reset(session);
    }
    /** Navigate the session's page through the selected provider. */
    async navigate(session, request, signal) {
        return this.resolveProvider().navigate(session, request, signal);
    }
    /** Execute JS in the session's page context through the selected provider. */
    async execute(session, request, signal) {
        return this.resolveProvider().execute(session, request, signal);
    }
    /** Produce an AI-friendly snapshot of the session's page. */
    async snapshot(session, signal) {
        return this.resolveProvider().snapshot(session, signal);
    }
    /** Fetch page content in a requested format. */
    async content(session, request, signal) {
        return this.resolveProvider().content(session, request, signal);
    }
    /** Click at viewport coordinates through the selected provider. */
    async click(session, request, signal) {
        return this.resolveProvider().click(session, request, signal);
    }
    /** Type into the focused element through the selected provider. */
    async type(session, request, signal) {
        return this.resolveProvider().type(session, request, signal);
    }
    /** Fill a form's fields in one batch through the selected provider. */
    async fillForm(session, request, signal) {
        return this.resolveProvider().fillForm(session, request, signal);
    }
    /** Capture the current page through the selected provider. */
    async screenshot(session, request, signal) {
        return this.resolveProvider().screenshot(session, request, signal);
    }
    /** Check for a human-verification challenge on the active tab. */
    async detectChallenge(session, signal) {
        return this.resolveProvider().detectChallenge(session, signal);
    }
    /** Return the session's chronological operation log through the provider. */
    async history(session) {
        return this.resolveProvider().history(session);
    }
    /** Replay one recorded operation by sequence number through the provider. */
    async replay(session, seq) {
        return this.resolveProvider().replay(session, seq);
    }
    /** Download a URL to a local file through the provider. */
    async download(session, request, signal) {
        return this.resolveProvider().download(session, request, signal);
    }
    /** Export the session's cookies through the provider. */
    async flushAuth(session) {
        return this.resolveProvider().flushAuth(session);
    }
    /** Import cookies into the session through the provider. */
    async restoreAuth(session, cookies) {
        return this.resolveProvider().restoreAuth(session, cookies);
    }
    /** Close the session through the selected provider. Idempotent; a missing
     *  provider is treated as already-closed so teardown paths stay no-ops. */
    async close(session) {
        try {
            await this.resolveProvider().close(session);
        }
        catch (error) {
            const code = error instanceof BrowserError ? error.code : undefined;
            if (code === 'BROWSER_PROVIDER_UNAVAILABLE'
                || code === 'BROWSER_PROVIDER_CONFIGURED_MISSING'
                || code === 'BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE'
                || code === 'BROWSER_PROVIDER_AMBIGUOUS') {
                return; // provider gone; nothing to close
            }
            throw error;
        }
    }
}
export default BrowserRuntime;
