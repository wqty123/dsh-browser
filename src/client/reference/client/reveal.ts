/**
 * Waitable, cancellable source-reveal contract (§14.1, B30/B37).
 *
 * Deliberately separate from `openUrl` / `Page.navigate`: the injected adapter
 * only selects/locates/highlights an existing tab and must never reload the
 * page. It does NOT reuse the synchronous `navigateTabIn` helper. A monotonic
 * intent token guarantees a late result from an older click cannot steal the
 * tab or scroll position back (B37).
 */
import type { RevealRequest, RevealResult, RevealStatus } from './types.ts'

export type RevealValidation = 'ok' | 'unknown-reference' | 'session-mismatch'

export interface RevealLocation {
  readonly tabId?: string
  readonly frameId?: string
  readonly detail?: string
}

export interface RevealAdapter {
  /** Cheap synchronous validation of session + reference ownership. */
  validate(request: RevealRequest): RevealValidation
  /** Async, abortable lookup; must not mutate page state. */
  locate(request: RevealRequest, signal: AbortSignal): Promise<RevealLocation>
  /** The only step allowed to switch/scroll/highlight; never calls openUrl/Page.navigate. */
  apply(request: RevealRequest, location: RevealLocation): void | Promise<void>
}

export interface Revealer {
  reveal(request: RevealRequest): Promise<RevealResult>
  dispose(): void
}

export interface RevealerOptions {
  readonly adapter: RevealAdapter
}

/**
 * A locate failure that already knows which status it stands for.
 *
 * The plugin answers with a reason ("page-mismatch", "session-unavailable",
 * "missing", …) that the person needs to act on; without carrying it through
 * the generic `unavailable` branch every one of those read as "the sidebar is
 * broken".
 */
export class RevealFailed extends Error {
  readonly status: RevealStatus
  constructor(status: RevealStatus, message?: string) {
    super(message ?? status)
    this.status = status
    this.name = 'RevealFailed'
  }
}

/**
 * Read through a function: the signal may abort during `await`, so a prior
 * `=== true` check must not be narrowed into "always false" for later reads.
 */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true
}

export function createRevealer(options: RevealerOptions): Revealer {
  const adapter = options.adapter
  let latest = 0
  let disposed = false

  return {
    async reveal(request) {
      if (disposed) return { status: 'unavailable', reason: 'revealer disposed' }
      const callerSignal = request.signal
      if (isAborted(callerSignal)) return { status: 'cancelled' }
      const validation = adapter.validate(request)
      if (validation !== 'ok') return { status: validation }

      const token = ++latest
      const controller = new AbortController()
      const forward = (): void => { controller.abort() }
      callerSignal?.addEventListener('abort', forward, { once: true })

      let location: RevealLocation
      try {
        location = await adapter.locate(request, controller.signal)
      } catch (cause: unknown) {
        if (isAborted(controller.signal) || isAborted(callerSignal)) return { status: 'cancelled' }
        // A typed failure names its own cause; anything else stays generic.
        if (cause instanceof RevealFailed) return { status: cause.status, reason: cause.message }
        return { status: 'unavailable', reason: cause instanceof Error ? cause.message : 'locate failed' }
      } finally {
        callerSignal?.removeEventListener('abort', forward)
      }

      // A newer intent or a cancellation invalidates this late result: do NOT
      // call apply, so an old async result cannot switch or scroll the page.
      if (token !== latest) return { status: 'superseded' }
      if (isAborted(controller.signal) || isAborted(callerSignal)) return { status: 'cancelled' }
      try {
        await adapter.apply(request, location)
      } catch (cause: unknown) {
        return { status: 'unavailable', reason: cause instanceof Error ? cause.message : 'apply failed' }
      }
      return { status: 'revealed' }
    },
    dispose() {
      disposed = true
      latest += 1
    },
  }
}
