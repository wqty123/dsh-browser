/**
 * Browser-origin checks used after DSH authenticates each plugin HTTP request.
 * Desktop protocol forwarding supplies the host session cookie while Chromium may omit Origin
 * and Referer for the custom application scheme. These checks preserve that request shape and
 * reject browser requests that explicitly name another web origin.
 * @module dsh-browser/browser-electron/settings-route
 */
import type { IncomingMessage } from 'node:http';
/**
 * Whether a request may touch the settings document.
 * @param request - the incoming request.
 * @param writing - true for PUT/POST, which is held to the stricter rule.
 * @returns whether the request is admitted.
 */
export declare function sameOrigin(request: IncomingMessage, writing?: boolean): boolean;
