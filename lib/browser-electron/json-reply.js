/**
 * Write one JSON body with no caching and no sniffing.
 * @param response - the response to write.
 * @param status - the HTTP status.
 * @param body - anything JSON-serialisable.
 */
/**
 * Write an already-serialised JSON body with caller-supplied headers.
 *
 * Routes do not all need the same header set: readiness answers carry length and sniffing
 * headers, while the settings route has always returned only a content type and no-store.
 * Sharing the write keeps those exact header sets from drifting into each other.
 * @param response - the response to write.
 * @param status - the HTTP status.
 * @param text - the serialised body.
 * @param headers - the exact header set this route has always sent.
 */
export function writeJsonText(response, status, text, headers) {
    response.writeHead(status, headers);
    response.end(text);
}
export function replyJson(response, status, body) {
    const text = JSON.stringify(body);
    writeJsonText(response, status, text, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
        'cache-control': 'no-store, private',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
    });
}
