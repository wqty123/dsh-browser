/**
 * Whether a request may touch the settings document.
 * @param request - the incoming request.
 * @param writing - true for PUT/POST, which is held to the stricter rule.
 * @returns whether the request is admitted.
 */
export function sameOrigin(request, writing = false) {
    const origin = String(request.headers.origin ?? '').trim();
    // The desktop shell's own schemes come FIRST, before any header-based check.
    //
    // Order is the whole point here. The shell serves its UI from `dsh-app://app` while plugin
    // routes live on `http://127.0.0.1:<port>`, so a request from the panel is a CROSS-SCHEME
    // request and the browser reports `Sec-Fetch-Site: cross-site` for it — which the check below
    // refuses before `Origin` is ever examined. Putting the scheme test afterwards (the first
    // attempt) therefore changed nothing: the desktop panel still could not save a single setting,
    // and the option looked present and inert.
    //
    // Accepting the scheme is sound rather than a loosening. Only the shell can mint a
    // `dsh-app://` document: it is not a scheme a web page can navigate to, and no other process
    // on the machine can set `Origin` to it. `Sec-Fetch-Site` remains the discriminator for
    // http(s), where it is meaningful, and curl still cannot write because it sends no `Origin`.
    const APP_SCHEMES = ['dsh-app:', 'dsh-desktop:'];
    if (origin !== '' && origin !== 'null') {
        try {
            if (APP_SCHEMES.includes(new URL(origin).protocol))
                return true;
        }
        catch {
            // An unparseable Origin falls through to the ordinary checks below.
        }
    }
    const site = String(request.headers['sec-fetch-site'] ?? '').toLowerCase();
    // `cross-site` is another origin entirely; `same-site` is another origin of the same site
    // (a.example.com -> b.example.com), which is not this panel either. Both are refused.
    if (site === 'cross-site' || site === 'same-site')
        return false;
    // `Origin: null` is what a sandboxed or opaque-origin document sends. Never this panel.
    if (origin === 'null')
        return false;
    // Reads are let through without an Origin: they return the document the panel is already
    // showing, and refusing them would only break hand-inspection of a file that sits readable
    // on disk anyway. Writes are not: a browser always sends `Origin` on one.
    if (origin === '')
        return !writing;
    try {
        const parsed = new URL(origin);
        // The host comparison is for http(s), where a page and its route share one host.
        return parsed.host.toLowerCase() === String(request.headers.host ?? '').trim().toLowerCase();
    }
    catch {
        return false;
    }
}
