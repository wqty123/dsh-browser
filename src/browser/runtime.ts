/**
 * Service Definition for the browser capability seam (`ctx.browser`): the
 * provider registry and provider-selecting execution for browser sessions.
 * Duplicate ids are rejected. At execution time, a configured provider must
 * exist and be usable; without one, exactly one usable provider is required,
 * so selection never depends on registration order.
 * @module dsh-browser/browser
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {
  BrowserClickRequest,
  BrowserContentRequest,
  BrowserContentResult,
  BrowserExecuteRequest,
  BrowserExecuteResult,
  BrowserHistoryEntry,
  BrowserNavigateRequest,
  BrowserOpenRequest,
  BrowserProvider,
  BrowserScreenshotRequest,
  BrowserScreenshotResult,
  BrowserSessionId,
  BrowserSnapshotResult,
  BrowserTab,
  BrowserTypeRequest,
} from './types.ts'
import { BrowserError } from './types.ts'

export {
  BrowserError,
} from './types.ts'
export type {
  BrowserClickRequest,
  BrowserContentFormat,
  BrowserContentRequest,
  BrowserContentResult,
  BrowserExecuteRequest,
  BrowserExecuteResult,
  BrowserHistoryEntry,
  BrowserNavigateRequest,
  BrowserOpenRequest,
  BrowserProvider,
  BrowserScreenshotRequest,
  BrowserScreenshotResult,
  BrowserSessionId,
  BrowserSnapshotElement,
  BrowserSnapshotResult,
  BrowserTab,
  BrowserTypeRequest,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    browser: BrowserRuntime
  }
}

/**
 * Config for the browser seam. `browserProvider` pins which provider wins;
 * it is optional (a single registered usable provider auto-selects).
 */
export interface BrowserRuntimeConfig {
  /** Explicit browser provider id. Omitted = auto-select when exactly one usable. */
  readonly browserProvider?: string
}

/**
 * The browser access service. Registered as `ctx.browser` (one instance per
 * context).
 *
 * Selection semantics (resolved at execution time, never order-dependent):
 * - A configured id that is registered and `available()` 鈫?that provider.
 * - A configured id not registered 鈫?`BROWSER_PROVIDER_CONFIGURED_MISSING`.
 * - A configured id registered but unavailable 鈫? *   `BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE`.
 * - No id configured, exactly one registered usable provider 鈫?that provider.
 * - No id configured, multiple usable providers 鈫?`BROWSER_PROVIDER_AMBIGUOUS`.
 * - No id configured, no usable provider 鈫?`BROWSER_PROVIDER_UNAVAILABLE`.
 */
export class BrowserRuntime extends Service {
  /** Provider selection config. */
  static Config: z<BrowserRuntimeConfig> = z.object({
    browserProvider: z.string(),
  })

  private providers = new Map<string, BrowserProvider>()
  private readonly providerId: string | undefined

  constructor(ctx: Context, config: BrowserRuntimeConfig = {}) {
    super(ctx, 'browser')
    this.providerId = config.browserProvider
  }

  /**
   * Register a browser provider. Throws {@link BrowserError}
   * `BROWSER_DUPLICATE_PROVIDER` if its id is already registered. Returns a
   * disposer; disposed with the calling fiber.
   * @param provider - the provider; its `id` is the registry key.
   * @returns the disposer that unregisters the provider.
   */
  registerBrowserProvider(provider: BrowserProvider): () => void {
    if (this.providers.has(provider.id)) {
      throw new BrowserError(`a browser provider with id "${provider.id}" is already registered`, 'BROWSER_DUPLICATE_PROVIDER')
    }
    // Bind the generator to this instance instead of aliasing `this` to a
    // local (no-this-alias): the effect body mutates the instance registry.
    const dispose = this.ctx.effect(function* (this: BrowserRuntime) {
      this.providers.set(provider.id, provider)
      yield () => this.providers.delete(provider.id)
    }.bind(this), 'browser.registerProvider()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is
    // synchronous fire-and-forget 鈥?discard the (always-resolved) promise.
    return () => void dispose()
  }

  /** Resolve the selected provider or throw the matching {@link BrowserError}. */
  private resolveProvider(): BrowserProvider {
    const { providerId, providers } = this
    if (providerId !== undefined) {
      const provider = providers.get(providerId)
      if (!provider) {
        throw new BrowserError(`configured browser provider "${providerId}" is not registered`, 'BROWSER_PROVIDER_CONFIGURED_MISSING')
      }
      if (!provider.available()) {
        throw new BrowserError(`configured browser provider "${providerId}" is registered but unavailable`, 'BROWSER_PROVIDER_CONFIGURED_UNAVAILABLE')
      }
      return provider
    }
    const usable = [...providers.values()].filter(provider => provider.available())
    const [single] = usable
    if (single === undefined) {
      throw new BrowserError('no usable browser provider is registered', 'BROWSER_PROVIDER_UNAVAILABLE')
    }
    if (usable.length > 1) {
      const ids = usable.map(provider => provider.id).join(', ')
      throw new BrowserError(`multiple usable browser providers are registered (${ids}); configure one explicitly`, 'BROWSER_PROVIDER_AMBIGUOUS')
    }
    return single
  }

  /** Open a new browser session through the selected provider. */
  async open(): Promise<BrowserSessionId> {
    return this.resolveProvider().open()
  }

  /** Open a URL through the selected provider, optionally in a new tab. */
  async openUrl(session: BrowserSessionId, request: BrowserOpenRequest, signal?: AbortSignal): Promise<void> {
    return this.resolveProvider().openUrl(session, request, signal)
  }

  /** List the session's tabs through the selected provider. */
  async listTabs(session: BrowserSessionId): Promise<readonly BrowserTab[]> {
    return this.resolveProvider().listTabs(session)
  }

  /** Switch to a tab through the selected provider. */
  async switchTab(session: BrowserSessionId, tabId: string): Promise<void> {
    return this.resolveProvider().switchTab(session, tabId)
  }

  /** Close one tab through the selected provider. */
  async closeTab(session: BrowserSessionId, tabId: string): Promise<void> {
    return this.resolveProvider().closeTab(session, tabId)
  }

  /** Close every tab and reset the session through the selected provider. */
  async reset(session: BrowserSessionId): Promise<void> {
    return this.resolveProvider().reset(session)
  }

  /** Navigate the session's page through the selected provider. */
  async navigate(session: BrowserSessionId, request: BrowserNavigateRequest, signal?: AbortSignal): Promise<void> {
    return this.resolveProvider().navigate(session, request, signal)
  }

  /** Execute JS in the session's page context through the selected provider. */
  async execute(session: BrowserSessionId, request: BrowserExecuteRequest, signal?: AbortSignal): Promise<BrowserExecuteResult> {
    return this.resolveProvider().execute(session, request, signal)
  }

  /** Produce an AI-friendly snapshot of the session's page. */
  async snapshot(session: BrowserSessionId, signal?: AbortSignal): Promise<BrowserSnapshotResult> {
    return this.resolveProvider().snapshot(session, signal)
  }

  /** Fetch page content in a requested format. */
  async content(session: BrowserSessionId, request: BrowserContentRequest, signal?: AbortSignal): Promise<BrowserContentResult> {
    return this.resolveProvider().content(session, request, signal)
  }

  /** Click at viewport coordinates through the selected provider. */
  async click(session: BrowserSessionId, request: BrowserClickRequest, signal?: AbortSignal): Promise<void> {
    return this.resolveProvider().click(session, request, signal)
  }

  /** Type into the focused element through the selected provider. */
  async type(session: BrowserSessionId, request: BrowserTypeRequest, signal?: AbortSignal): Promise<void> {
    return this.resolveProvider().type(session, request, signal)
  }

  /** Capture the current page through the selected provider. */
  async screenshot(session: BrowserSessionId, request?: BrowserScreenshotRequest, signal?: AbortSignal): Promise<BrowserScreenshotResult> {
    return this.resolveProvider().screenshot(session, request, signal)
  }

  /** Return the session's chronological operation log through the provider. */
  async history(session: BrowserSessionId): Promise<readonly BrowserHistoryEntry[]> {
    return this.resolveProvider().history(session)
  }

  /** Replay one recorded operation by sequence number through the provider. */
  async replay(session: BrowserSessionId, seq: number): Promise<void> {
    return this.resolveProvider().replay(session, seq)
  }

  /** Close the session through the selected provider. Idempotent. */
  async close(session: BrowserSessionId): Promise<void> {
    return this.resolveProvider().close(session)
  }
}

export default BrowserRuntime

