/**
 * Write one JSON body with no caching and no sniffing.
 * @param response - the response to write.
 * @param status - the HTTP status.
 * @param body - anything JSON-serialisable.
 */
export function replyJson(response, status, body) {
    const text = JSON.stringify(body);
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
        'cache-control': 'no-store, private',
        'x-content-type-options': 'nosniff',
        'cross-origin-resource-policy': 'same-origin',
    });
    response.end(text);
}
