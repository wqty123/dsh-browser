/**
 * Production source-reveal wiring.
 *
 * Reuses the additive `createRevealer` + `parseBrowserRefUri` +
 * `buildBrowserRefLinkProps` contracts. The reply-side `BrowserRefLink` (mounted
 * into `conversation.user.text.node` by the assembly) calls `onActivate(uri)`;
 * we decode the `dsh-browser-ref:` URI, resolve the frozen owner (sessionId,
 * browserSessionId, label/frame), validate against the CURRENT session and then
 * call `POST /reference/reveal`. Session-mismatch / unknown / unavailable are
 * surfaced as understandable statuses instead of a dead link.
 *
 * The plugin's reveal route resolves the page from the stored reference's
 * browserSessionId/frame itself, so the client sends `referenceId`/`partId` and
 * validates the identity facts locally; `apply` is a documented no-op because
 * the tab switch/highlight happens on the plugin (never `openUrl`/Page.navigate).
 *
 * @module dsh-browser-reference/production/reveal
 */
import type { RevealRequest, RevealResult, RevealStatus } from '../types.ts'
import { createRevealer, RevealFailed, type RevealAdapter, type RevealLocation } from '../reveal.ts'
import { parseBrowserRefUri } from '../scheme.ts'
import type { BrowserRefLinkSpec } from '../BrowserRefLink.tsx'
import type { ReferenceHttpClient } from './http-transport.ts'
import { bridgePackageError } from '../../../../bridge-compatibility.ts'

/** Frozen identity of a captured reference, resolved from the stored snapshot. */
export interface RevealOwner {
  readonly sessionId: string
  readonly browserSessionId: string
  readonly label: string
  readonly frameRoute?: 'main' | 'frame'
  readonly frameSelector?: string
}

export interface ProductionRevealerOptions {
  readonly http: ReferenceHttpClient
  /** Resolve a reference id to its frozen owner, or undefined when unknown. */
  readonly resolveOwner: (referenceId: string) => RevealOwner | undefined
  /** Current DSH session id (for session-mismatch validation). */
  readonly currentSessionId: () => string
  readonly onActivate?: (uri: string) => Promise<RevealStatus>
  /**
   * Report the outcome of EVERY activation (including the reply-side link's
   * `onActivate`, which used to call `run` directly and stay silent). The
   * runtime injects `showReveal` so a failed source link gets the same hint as
   * the document-level bridge.
   */
  readonly report?: (status: string) => void
}

export interface ProductionRevealer {
  readonly revealer: ReturnType<typeof createRevealer>
  /**
   * Decode a `dsh-browser-ref:` URI and reveal it.
   * @param uri - the frozen `dsh-browser-ref:` link.
   * @param options - `navigate` asks the plugin to move its page to the source.
   * @returns an understandable status.
   */
  activate(uri: string, options?: { readonly navigate?: boolean; readonly sourcePageId?: string }): Promise<RevealStatus>
  /** Build the dedicated button props for a reply-side link. */
  linkSpec(uri: string, label?: string): BrowserRefLinkSpec
  /** Last activation status, for the UI to render a hint. */
  lastStatus(): RevealStatus | undefined
  lastReason(): string | undefined
  dispose(): void
}

class RevealUnavailableError extends Error {}

/**
 * Translate the plugin's answer into a client status.
 *
 * `partial` means the page WAS located and at least one part was highlighted,
 * so it is a success; every other non-`revealed` answer is a distinct failure
 * the person can act on, and is therefore named instead of being flattened.
 */
function wireStatus(status: string | undefined): RevealStatus {
  switch (status) {
    case 'revealed':
    case 'ok':
    case 'partial':
      return 'revealed'
    case 'ambiguous':
      return 'ambiguous'
    case 'missing':
      return 'missing'
    case 'not-found':
      return 'not-found'
    case 'page-mismatch':
      return 'page-mismatch'
    case 'session-unavailable':
      return 'session-unavailable'
    default:
      return 'unavailable'
  }
}

/** Build a `RevealAdapter` over the plugin's reveal endpoint. */
export function createRevealAdapter(options: ProductionRevealerOptions): RevealAdapter {
  const { http, resolveOwner, currentSessionId } = options
  return {
    validate(request: RevealRequest) {
      const owner = resolveOwner(request.referenceId)
      if (owner === undefined) return 'unknown-reference'
      if (owner.sessionId !== request.sessionId || request.sessionId !== currentSessionId()) {
        return 'session-mismatch'
      }
      return 'ok'
    },
    async locate(request: RevealRequest, _signal: AbortSignal): Promise<RevealLocation> {
      const owner = resolveOwner(request.referenceId)
      if (owner === undefined) throw new RevealUnavailableError('unknown reference')
      const wire = await http.reveal(request.referenceId, request.partId, request.navigate === true, request.sourcePageId)
        .catch((error: unknown) => { throw bridgePackageError(error) ?? error })
      const packageError = bridgePackageError(wire)
      if (packageError !== undefined) throw packageError
      // A transport-level refusal (ok !== true) has no cause to report; a
      // decoded answer always does, so it travels with the status.
      if (wire.ok !== true) throw new RevealUnavailableError(wire.reason ?? 'reveal was refused')
      const status = wireStatus(wire.status)
      if (status !== 'revealed') throw new RevealFailed(status, wire.reason ?? wire.note ?? wire.status)
      // Identity facts (owner.sessionId + browserSessionId + label/frame) are
      // carried for audit; the plugin resolves the actual tab from the frozen
      // reference server-side.
      return {
        ...(wire.tabId === undefined ? {} : { tabId: wire.tabId }),
        ...(wire.frameId === undefined ? {} : { frameId: wire.frameId }),
        detail: JSON.stringify({
          sessionId: owner.sessionId,
          browserSessionId: owner.browserSessionId,
          label: owner.label,
          ...(owner.frameRoute === undefined ? {} : { frameRoute: owner.frameRoute }),
          ...(owner.frameSelector === undefined ? {} : { frameSelector: owner.frameSelector }),
        }),
      }
    },
    apply(): void {
      // The plugin's reveal route already selects/highlights the existing tab;
      // this client never reloads the page and never calls openUrl.
    },
  }
}

/** Build the production revealer that drives `createRevealer`. */
export function createProductionRevealer(options: ProductionRevealerOptions): ProductionRevealer {
  const revealer = createRevealer({ adapter: createRevealAdapter(options) })
  let last: RevealStatus | undefined
  let reason: string | undefined

  const run = async (parsed: ReturnType<typeof parseBrowserRefUri>, navigate = false, sourcePageId?: string): Promise<RevealStatus> => {
    reason = undefined
    let status: RevealStatus
    if (parsed === undefined) {
      status = 'unknown-reference'
    } else {
      const request: RevealRequest = {
        referenceId: parsed.referenceId,
        ...(parsed.partId === undefined ? {} : { partId: parsed.partId }),
        sessionId: options.currentSessionId(),
        ...sourcePageId === undefined ? {} : { sourcePageId },
        ...navigate ? { navigate: true } : {},
      }
      try {
        const result: RevealResult = await revealer.reveal(request)
        status = result.status
        reason = result.reason
      } catch {
        status = 'unavailable'
      }
    }
    last = status
    // ONE reporting channel for BOTH the bridge path and the reply-side link's
    // onActivate, so a failed React-rendered source link is never silent.
    options.report?.(status)
    return status
  }

  return {
    revealer,
    lastReason: () => reason,
    async activate(uri, activateOptions) {
      return run(parseBrowserRefUri(uri), activateOptions?.navigate === true, activateOptions?.sourcePageId)
    },
    linkSpec(uri, label) {
      const owner = (() => {
        const parsed = parseBrowserRefUri(uri)
        return parsed === undefined ? undefined : options.resolveOwner(parsed.referenceId)
      })()
      // Clickable whenever the URI is canonical. Before this, a reference whose owner was not yet loaded
      // in this process (a page reload, a message restored from history) rendered a DISABLED pill that
      // looked like a chip but did nothing — reported as "胶囊是虚假的". Resolution happens on activation,
      // where a genuinely missing reference can report itself.
      const available = parseBrowserRefUri(uri) !== undefined
      const spec: BrowserRefLinkSpec = {
        uri,
        available,
        // The sent message must keep the pill the composer showed. Without a class the reply-side
        // control inherits the host's default button chrome, so the reference visually degrades the
        // moment it is submitted. `.dsh-browser-ref-link` carries the same metrics as the composer
        // chip (26px tall, 999px radius, the same two theme tokens).
        className: 'dsh-browser-ref-link',
        onActivate: (activated) => {
          void (options.onActivate === undefined ? run(parseBrowserRefUri(activated)) : options.onActivate(activated))
        },
        ...(label === undefined ? {} : { children: label }),
        // Always carry a tooltip: a chip with no title reads as decoration. When the reference is not
        // loaded in this process yet, the tooltip still explains what the control does.
        title: owner === undefined ? '回到网页原文' : owner.label,
      }
      return spec
    },
    lastStatus: () => last,
    dispose() { revealer.dispose() },
  }
}
