/**
 * Admission for the settings route: who may read the document, and who may write it.
 *
 * Its own module for a blunt reason — `entry.ts` imports the host's peer packages (cordis, the
 * tools registry) and therefore cannot be loaded by the test suite, while this is precisely the
 * logic whose failure is invisible in a browser: too strict and the panel silently stops being
 * able to save, too loose and any process on the machine can rewrite the operator's switches.
 *
 * It is NOT authentication, and cannot be. The plugin has no credential to check: DSH hands
 * plugin routes the raw request (`packages/host/webserver/src/index.ts` registers handlers with
 * no gate of its own), so the strongest same-origin evidence available is what a browser
 * reliably sends.
 *
 * What that buys and what it does not:
 *   - a plain HTTP client (curl, a script, another process) cannot WRITE, because it sends no
 *     `user-agent` and no `accept-language`;
 *   - a page of THIS origin can, because a browser sending a same-origin write looks exactly
 *     like the panel. That is inherent to exposing an HTTP endpoint at all, and it is why the
 *     settings panel's own text must not promise a lock that does not exist.
 */
import type { IncomingMessage } from 'node:http';
/**
 * Whether a request may touch the settings document.
 * @param request - the incoming request.
 * @param writing - true for PUT/POST, which is held to the stricter rule.
 * @returns whether the request is admitted.
 */
export declare function sameOrigin(request: IncomingMessage, writing?: boolean): boolean;
