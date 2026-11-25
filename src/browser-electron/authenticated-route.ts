/**
 * Authenticate plugin HTTP routes with the browser session owned by DSH.
 * The connection service verifies its signed cookie and completes denied responses.
 * @module dsh-browser/browser-electron/authenticated-route
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { replyJson } from './json-reply.ts'

/** The host authentication method shared with its application and inspector routes. */
export interface BrowserConnection {
  authorizeIndex(request: IncomingMessage, response: ServerResponse): boolean
}

export interface BrowserPairingConnection {
  requestRejection(request: IncomingMessage): 401 | 403 | undefined
}

/** The request facts an admission entry reads; completing the response stays the caller's job. */
export interface BrowserTrustRequest {
  readonly headers: IncomingMessage['headers']
  readonly method?: string
  readonly url?: string
  readonly socket?: { readonly destroyed: boolean }
}

/** A credential's live Peer, or the status to answer with. */
export interface BrowserAdmission {
  readonly peer?: unknown
  readonly rejection?: 401 | 403 | 503
}

/**
 * What DSH >= 0.2.3 exposes in place of `authorizeIndex` and `requestRejection`.
 *
 * The login exchange moved into `@deepseek-ai/dsh-host-authentication-token`, which removed both
 * members from the connection service and left a single admission entry: `admit` applies the Host
 * and Origin fences and returns the first live Peer, or the status to answer with.
 */
export interface BrowserAdmissionConnection {
  admit(request: BrowserTrustRequest): BrowserAdmission
}

/** An exact HTTP route registered with the DSH web server. */
export type BrowserHttpHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>

/** Answer a rejected request the way the host's own routes answer it. */
function replyRejection(response: ServerResponse, rejection: 401 | 403 | 503, unavailable: string): void {
  const error = rejection === 401 ? 'unauthorized' : rejection === 403 ? 'forbidden' : unavailable
  replyJson(response, rejection, { error })
}

/**
 * Ask one host to admit the request.
 *
 * `admit` reads `connection.authentication` through the calling context, so a context that never
 * injected that service throws instead of refusing — see `admissionContext` in the entry, which
 * supplies a context that has it. An absent entry and a throwing one both answer undefined, and
 * that keeps these routes failing closed exactly as a missing `authorizeIndex` did.
 * @param host - the resolved connection service, if any.
 * @param request - the incoming request.
 * @returns the admission, or undefined when the host has no usable admission entry.
 */
function admitRequest(
  host: BrowserAdmissionConnection | undefined,
  request: IncomingMessage,
): BrowserAdmission | undefined {
  if (typeof host?.admit !== 'function') return undefined
  try {
    return host.admit({
      headers: request.headers,
      method: request.method,
      url: request.url,
      socket: { destroyed: request.socket?.destroyed === true },
    })
  } catch {
    return undefined
  }
}

/** The connection service as this module may see it on either host generation. */
type AnyConnection = BrowserConnection | BrowserAdmissionConnection | undefined

/**
 * Check the current host credential on every request before reading settings, capturing a frame,
 * or starting a write. Origin checks remain inside the handler as an additional browser boundary.
 * @param connection - resolves the host's current connection service.
 * @param handler - the operation to run after authentication.
 * @returns an authenticated route handler.
 */
export function authenticatedRoute(
  connection: () => AnyConnection,
  handler: BrowserHttpHandler,
): BrowserHttpHandler {
  return (request, response) => {
    let host: AnyConnection
    try {
      host = connection()
    } catch {
      // A disposed host cannot authorize new work.
    }
    // DSH <= 0.2.2: the connection service mints and checks the index credential itself.
    if (typeof (host as BrowserConnection | undefined)?.authorizeIndex === 'function') {
      // A false result owns the response. Preserving it also preserves host-specific login behavior.
      if (!(host as BrowserConnection).authorizeIndex(request, response)) return
      return handler(request, response)
    }
    // DSH >= 0.2.3 carries the same check in `connection.admit()`.
    const admission = admitRequest(host as BrowserAdmissionConnection | undefined, request)
    if (admission === undefined) {
      replyJson(response, 503, { error: 'browser-auth-unavailable' })
      return
    }
    if (admission.rejection !== undefined) {
      replyRejection(response, admission.rejection, 'browser-auth-unavailable')
      return
    }
    return handler(request, response)
  }
}

/** Admit passive previews through the same live-Peer and Host fence as DSH's API. */
export function pairedRoute(
  connection: () => BrowserPairingConnection | BrowserAdmissionConnection | undefined,
  handler: BrowserHttpHandler,
): BrowserHttpHandler {
  return (request, response) => {
    let host: BrowserPairingConnection | BrowserAdmissionConnection | undefined
    try {
      host = connection()
    } catch {
      // A disposed host cannot authorize new work.
    }
    // DSH <= 0.2.2: pairing had its own narrow check that never completed a response.
    if (typeof (host as BrowserPairingConnection | undefined)?.requestRejection === 'function') {
      let rejection: 401 | 403 | undefined
      try {
        rejection = (host as BrowserPairingConnection).requestRejection(request)
      } catch {
        replyJson(response, 503, { error: 'browser-pairing-unavailable' })
        return
      }
      if (rejection !== undefined && rejection !== 401 && rejection !== 403) {
        replyJson(response, 503, { error: 'browser-pairing-unavailable' })
        return
      }
      if (rejection !== undefined) {
        replyRejection(response, rejection, 'browser-pairing-unavailable')
        return
      }
      return handler(request, response)
    }
    // DSH >= 0.2.3 removed `requestRejection`; pairing uses the API's own fence.
    const admission = admitRequest(host as BrowserAdmissionConnection | undefined, request)
    if (admission === undefined) {
      replyJson(response, 503, { error: 'browser-pairing-unavailable' })
      return
    }
    if (admission.rejection !== undefined) {
      replyRejection(response, admission.rejection, 'browser-pairing-unavailable')
      return
    }
    return handler(request, response)
  }
}

/**
 * Admit machine-wide installation changes from a direct loopback connection.
 * Forwarded requests belong to their remote operator even when the last hop is loopback.
 * @param request - request received by the host.
 * @returns true for direct loopback requests.
 */
export function isDirectLoopback(request: IncomingMessage): boolean {
  const address = request.socket.remoteAddress
  const local = address === '::1' || address === '127.0.0.1' || address === '::ffff:127.0.0.1'
  return local && !['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip']
    .some(name => request.headers[name] !== undefined)
}
