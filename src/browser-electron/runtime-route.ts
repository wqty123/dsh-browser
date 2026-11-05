/**
 * The readiness endpoints the settings panel reads.
 *
 * The host authenticates both routes with its signed browser-session cookie. The read returns
 * readiness, while a POST starts runtime preparation and also passes the settings write-origin
 * checks.
 *
 * Both answer with the whole report rather than a delta: the panel replaces what it shows with what
 * it is told, so a stale poll can never leave a wrong state on screen.
 * @module dsh-browser/browser-electron/runtime-route
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ProvisionSnapshot } from './electron-provision.js'
import { replyJson } from './json-reply.js'
import { sameOrigin } from './settings-route.js'
import type { RuntimeStatusReport } from './runtime-status.js'

/** Where the panel reads readiness. */
export const RUNTIME_STATUS_ROUTE = '/dsh-builtin-browser/runtime-status'

/**
 * Where the panel asks for the bundled runtime.
 *
 * Non-blocking by design: it starts (or joins) the one background attempt and answers immediately
 * with the state that attempt is in, which is `preparing`. A request that waited for the download
 * would time out in the browser long before a slow network finished, and would hold a connection
 * open for something the panel can poll instead.
 */
export const RUNTIME_PROVISION_ROUTE = '/dsh-builtin-browser/runtime-provision'

/** What both handlers need. */
export interface RuntimeRouteDeps {
  /** The current report; a cheap read, never a spawn. */
  readonly report: () => RuntimeStatusReport
  /**
   * Start (or join) a provision and return the state it is in now.
   *
   * Must not throw: a failure belongs in the report as a 200 with a `failed` state, because a user
   * looking at a panel needs to read the reason, not an HTTP status.
   */
  readonly provision: () => ProvisionSnapshot
}

/**
 * Read readiness: `{ ok, runtime }`.
 * @param request - the incoming request.
 * @param response - the response to write.
 * @param deps - the readers.
 */
export async function handleRuntimeStatus(
  request: IncomingMessage,
  response: ServerResponse,
  deps: RuntimeRouteDeps,
): Promise<void> {
  if (request.method !== 'GET') {
    replyJson(response, 405, { error: 'method-not-allowed' })
    return
  }
  if (!sameOrigin(request)) {
    replyJson(response, 403, { error: 'not-same-origin' })
    return
  }
  replyJson(response, 200, { ok: true, runtime: deps.report() })
}

/**
 * Start (or join) a provision, then answer with the state it is in.
 *
 * Always 200 once admitted, whatever happened: the state carries `failed` with its reason, and a
 * panel that had to distinguish 4xx from 5xx to say "the download failed" would show a network
 * error where the user needs the sentence explaining it.
 * @param request - the incoming request.
 * @param response - the response to write.
 * @param deps - the readers.
 */
export async function handleRuntimeProvision(
  request: IncomingMessage,
  response: ServerResponse,
  deps: RuntimeRouteDeps,
): Promise<void> {
  if (request.method !== 'POST') {
    replyJson(response, 405, { error: 'method-not-allowed' })
    return
  }
  // `true`: starting a download is a write, and is admitted the way a settings write is.
  if (!sameOrigin(request, true)) {
    replyJson(response, 403, { error: 'not-same-origin' })
    return
  }
  let snapshot: ProvisionSnapshot
  try {
    snapshot = deps.provision()
  } catch (error) {
    // `provision` is documented not to throw; if a caller breaks that contract the panel still gets
    // an answer it can render, rather than a dropped connection it cannot tell from a hang.
    replyJson(response, 200, {
      ok: true,
      runtime: deps.report(),
      provisionError: String(error),
    })
    return
  }
  replyJson(response, 200, { ok: true, runtime: deps.report(), provision: snapshot })
}
