/**
 * Read a body as UTF-8 text. Chunks are collected as Buffers and decoded once: setting an
 * encoding on the stream and concatenating `String(chunk)` corrupts a multi-byte character that
 * happens to be split across two TCP chunks.
 * @param request - the incoming request.
 * @param limit - maximum accepted bytes.
 * @returns the body text.
 */
export async function readTextBody(request, limit = 64 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        size += buffer.length;
        if (size > limit) {
            request.destroy();
            throw new Error(`request body exceeds ${limit} bytes`);
        }
        chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString('utf8');
}
/**
 * Read and parse a JSON body. An empty body is an empty object, matching the settings route's
 * long-standing behaviour.
 * @param request - the incoming request.
 * @param limit - maximum accepted bytes.
 * @returns the parsed value.
 */
export async function readJsonBody(request, limit = 64 * 1024) {
    const text = await readTextBody(request, limit);
    return JSON.parse(text === '' ? '{}' : text);
}
