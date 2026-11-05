/** The shell's own URL schemes. Only the shell can mint a document on one of these. */
const APP_SCHEMES = ['dsh-app:', 'dsh-desktop:'];
/**
 * The scheme of a header value, when it names a URL.
 * @param value - a raw header value.
 * @returns the scheme, or undefined when the value is absent, opaque or unparseable.
 */
function schemeOf(value) {
    if (value === '' || value === 'null')
        return undefined;
    try {
        return new URL(value).protocol;
    }
    catch {
        return undefined;
    }
}
/**
 * Whether a request may touch the settings document.
 * @param request - the incoming request.
 * @param writing - true for PUT/POST, which is held to the stricter rule.
 * @returns whether the request is admitted.
 */
export function sameOrigin(request, writing = false) {
    const origin = String(request.headers.origin ?? '').trim();
    const site = String(request.headers['sec-fetch-site'] ?? '').toLowerCase();
    // A shell URL, in either the Origin or the referrer: the strongest evidence there is.
    if (APP_SCHEMES.includes(schemeOf(origin) ?? ''))
        return true;
    if (APP_SCHEMES.includes(schemeOf(String(request.headers.referer ?? '')) ?? ''))
        return true;
    // Desktop custom-scheme requests can omit browser origin metadata. The route's host-cookie
    // gate has already authenticated them; the renderer headers retain compatibility with older
    // shells that omit Origin while forwarding settings writes.
    if (origin === '') {
        const agent = String(request.headers['user-agent'] ?? '');
        const language = String(request.headers['accept-language'] ?? '');
        if (/^Mozilla\/5\.0/.test(agent) && language !== '')
            return true;
        // A missing Origin is valid for reads after the host-cookie gate has admitted the caller.
        return !writing;
    }
    // `cross-site` is another origin entirely; `same-site` is another origin of the same site
    // (a.example.com -> b.example.com), which is not this panel either. Both are refused.
    if (site === 'cross-site' || site === 'same-site')
        return false;
    // `Origin: null` is a sandboxed or opaque-origin document. Never this panel.
    if (origin === 'null')
        return false;
    try {
        const parsed = new URL(origin);
        // The host comparison is for http(s), where a page and its route share one host.
        return parsed.host.toLowerCase() === String(request.headers.host ?? '').trim().toLowerCase();
    }
    catch {
        return false;
    }
}
