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
        const parsed = new URL(origin);
        // The desktop shell serves its UI from Electron's own `dsh-app://` scheme, so its origin's
        // host is `app` while the request arrives at `127.0.0.1:<port>` — the host comparison below
        // could therefore never hold there, and every save from the desktop settings panel was
        // refused with 403 while the panel showed nothing at all. The symptom was a switch that
        // could be changed and silently did not stick; the option looked present and inert.
        //
        // Accepting the scheme is sound because only the shell can mint a `dsh-app://` document:
        // it is not a scheme reachable from a web page, and `Sec-Fetch-Site` above still rejects
        // cross-site senders. The host comparison stays for http(s), where it is meaningful.
        const APP_SCHEMES = ['dsh-app:', 'dsh-desktop:'];
        if (APP_SCHEMES.includes(parsed.protocol))
            return true;
        return parsed.host.toLowerCase() === String(request.headers.host ?? '').trim().toLowerCase();
    }
    catch {
        return false;
    }
}
