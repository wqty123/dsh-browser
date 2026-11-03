/**
 * One JSON reply, written the same way by every route this plugin serves.
 *
 * Its own module rather than a helper inside one route file: there are four endpoints now, and the
 * second one that needed this had to import it from the live-view route — which reads as though the
 * readiness endpoints belong to the preview. They do not; only the header rules are shared.
 *
 * The header set is the substance, not boilerplate:
 * - `content-length` computed from the bytes actually written, so a proxy cannot truncate;
 * - `no-store` because every answer here is a reading of the current moment;
 * - `nosniff` + a same-origin resource policy, because these bodies name paths and pids.
 * @module dsh-browser/browser-electron/json-reply
 */
import type { ServerResponse } from 'node:http'

/**
 * Write one JSON body with no caching and no sniffing.
 * @param response - the response to write.
 * @param status - the HTTP status.
 * @param body - anything JSON-serialisable.
 */
export function replyJson(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store, private',
    'x-content-type-options': 'nosniff',
    'cross-origin-resource-policy': 'same-origin',
  })
  response.end(text)
}
