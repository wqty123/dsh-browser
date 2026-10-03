/**
 * Whether a request may touch the settings document.
 * @param request - the incoming request.
 * @param writing - true for PUT/POST, which is held to the stricter rule.
 * @returns whether the request is admitted.
 */
export function sameOrigin(request, writing = false) {
    const site = String(request.headers['sec-fetch-site'] ?? '').toLowerCase();
    // `cross-site` is another origin entirely; `same-site` is another origin of the same site
    // (a.example.com -> b.example.com), which is not this panel either. Both are refused.
    if (site === 'cross-site' || site === 'same-site')
        return false;
    const origin = String(request.headers.origin ?? '').trim();
    // `Origin: null` is what a sandboxed or opaque-origin document sends. Never this panel.
    if (origin === 'null')
        return false;
    // Reads are let through without an Origin: they return the document the panel is already
    // showing, and refusing them would only break hand-inspection of a file that sits readable
    // on disk anyway. Writes are not: a browser always sends `Origin` on one.
    if (origin === '')
        return !writing;
    try {
        return new URL(origin).host.toLowerCase() === String(request.headers.host ?? '').trim().toLowerCase();
    }
    catch {
        return false;
    }
}
