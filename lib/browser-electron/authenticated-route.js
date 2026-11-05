import { replyJson } from './json-reply.js';
/**
 * Check the current host credential on every request before reading settings, capturing a frame,
 * or starting a write. Origin checks remain inside the handler as an additional browser boundary.
 * @param connection - resolves the host's current connection service.
 * @param handler - the operation to run after authentication.
 * @returns an authenticated route handler.
 */
export function authenticatedRoute(connection, handler) {
    return (request, response) => {
        let host;
        try {
            host = connection();
        }
        catch {
            // A disposed host cannot authorize new work.
        }
        if (typeof host?.authorizeIndex !== 'function') {
            replyJson(response, 503, { error: 'browser-auth-unavailable' });
            return;
        }
        // A false result owns the response. Preserving it also preserves host-specific login behavior.
        if (!host.authorizeIndex(request, response))
            return;
        return handler(request, response);
    };
}
/**
 * Admit machine-wide installation changes from a direct loopback connection.
 * Forwarded requests belong to their remote operator even when the last hop is loopback.
 * @param request - request received by the host.
 * @returns true for direct loopback requests.
 */
export function isDirectLoopback(request) {
    const address = request.socket.remoteAddress;
    const local = address === '::1' || address === '127.0.0.1' || address === '::ffff:127.0.0.1';
    return local && !['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip']
        .some(name => request.headers[name] !== undefined);
}
