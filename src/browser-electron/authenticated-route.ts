/**
 * Authenticate plugin HTTP routes with the browser session owned by DSH.
 * The connection service verifies its signed cookie and completes denied responses.
 * @module dsh-browser/browser-electron/authenticated-route
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { replyJson } from './json-reply.js'

/** The host authentication method shared with its application and inspector routes. */
export interface BrowserConnection {
  authorizeIndex(request: IncomingMessage, response: ServerResponse): boolean
}

/** An exact HTTP route registered with the DSH web server. */
export type BrowserHttpHandler = (request: IncomingMessage, response: ServerResponse) => void | Promise<void>

/**
 * Check the current host credential on every request before reading settings, capturing a frame,
 * or starting a write. Origin checks remain inside the handler as an additional browser boundary.
 * @param connection - resolves the host's current connection service.
 * @param handler - the operation to run after authentication.
 * @returns an authenticated route handler.
 */
export function authenticatedRoute(
  connection: () => BrowserConnection | undefined,
  handler: BrowserHttpHandler,
): BrowserHttpHandler {
  return (request, response) => {
    let host: BrowserConnection | undefined
    try {
      host = connection()
    } catch {
      // A disposed host cannot authorize new work.
    }
    if (typeof host?.authorizeIndex !== 'function') {
      replyJson(response, 503, { error: 'browser-auth-unavailable' })
      return
    }
    // A false result owns the response. Preserving it also preserves host-specific login behavior.
    if (!host.authorizeIndex(request, response)) return
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
