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
    // MEASURED on the running desktop, and what three earlier attempts each guessed wrong: a
    // request from the shell's own settings panel carries NO origin, NO sec-fetch-site and NO
    // referer. It is not "dsh-app://app" and it is not "null" — the headers are simply absent,
    // because Chromium attaches no cross-origin metadata to a request leaving a custom scheme.
    //
    // So the rule for that shape cannot be "a request without an Origin is a script", which is
    // what refused every desktop save, and it cannot lean on `Sec-Fetch-Site` either. It has to
    // test what a hand-rolled client does not send:
    //   - a renderer sends a full Mozilla-compatible `user-agent` AND an `accept-language`;
    //   - curl sends neither unless told to, and a local process that forges both can also read
    //     the settings document directly — it sits readable on disk, as the panel's own text
    //     says. This was never the boundary it looked like.
    if (origin === '') {
        const agent = String(request.headers['user-agent'] ?? '');
        const language = String(request.headers['accept-language'] ?? '');
        if (/^Mozilla\/5\.0/.test(agent) && language !== '')
            return true;
        // Reads stay open: they return the document the panel is already showing, and refusing them
        // would only break hand-inspection of a file that sits readable on disk anyway.
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
