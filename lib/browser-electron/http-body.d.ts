/**
 * Bounded request bodies shared by every plugin HTTP route. Keeping one implementation means the
 * byte limit, UTF-8 decoding and oversize behaviour cannot drift between the settings and the
 * maintenance endpoints.
 * @module dsh-browser/browser-electron/http-body
 */
import type { IncomingMessage } from 'node:http';
/**
 * Read a body as UTF-8 text. Chunks are collected as Buffers and decoded once: setting an
 * encoding on the stream and concatenating `String(chunk)` corrupts a multi-byte character that
 * happens to be split across two TCP chunks.
 * @param request - the incoming request.
 * @param limit - maximum accepted bytes.
 * @returns the body text.
 */
export declare function readTextBody(request: IncomingMessage, limit?: number): Promise<string>;
/**
 * Read and parse a JSON body. An empty body is an empty object, matching the settings route's
 * long-standing behaviour.
 * @param request - the incoming request.
 * @param limit - maximum accepted bytes.
 * @returns the parsed value.
 */
export declare function readJsonBody<T>(request: IncomingMessage, limit?: number): Promise<T>;
