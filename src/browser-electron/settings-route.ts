/**
 * Admission for the settings route: who may read the document, and who may write it.
 *
 * Its own module for a blunt reason — `entry.ts` imports the host's peer packages (cordis, the
 * tools registry) and therefore cannot be loaded by the test suite, while this is precisely the
 * logic whose failure is invisible in a browser: too strict and the panel silently stops being
 * able to save, too loose and any process on the machine can rewrite the operator's switches.
 *
 * It is NOT authentication, and cannot be. The plugin has no credential to check: DSH hands
 * plugin routes the raw request (`packages/host/webserver/src/index.ts` registers handlers with
 * no gate of its own), so the strongest same-origin evidence available is what a browser
 * reliably sends.
 *
 * What that buys and what it does not:
 *   - a plain HTTP client (curl, a script, another process) cannot WRITE, because it sends no
 *     `user-agent` and no `accept-language`;
 *   - a page of THIS origin can, because a browser sending a same-origin write looks exactly
 *     like the panel. That is inherent to exposing an HTTP endpoint at all, and it is why the
 *     settings panel's own text must not promise a lock that does not exist.
 */
import type { IncomingMessage } from 'node:http'

/** The shell's own URL schemes. Only the shell can mint a document on one of these. */
const APP_SCHEMES = ['dsh-app:', 'dsh-desktop:']

/**
 * The scheme of a header value, when it names a URL.
 * @param value - a raw header value.
 * @returns the scheme, or undefined when the value is absent, opaque or unparseable.
 */
function schemeOf(value: string): string | undefined {
  if (value === '' || value === 'null') return undefined
  try {
    return new URL(value).protocol
  } catch {
    return undefined
  }
}

/**
 * Whether a request may touch the settings document.
 * @param request - the incoming request.
 * @param writing - true for PUT/POST, which is held to the stricter rule.
 * @returns whether the request is admitted.
 */
export function sameOrigin(request: IncomingMessage, writing = false): boolean {
  const origin = String(request.headers.origin ?? '').trim()
  const site = String(request.headers['sec-fetch-site'] ?? '').toLowerCase()

  // A shell URL, in either the Origin or the referrer: the strongest evidence there is.
  if (APP_SCHEMES.includes(schemeOf(origin) ?? '')) return true
  if (APP_SCHEMES.includes(schemeOf(String(request.headers.referer ?? '')) ?? '')) return true

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
    const agent = String(request.headers['user-agent'] ?? '')
    const language = String(request.headers['accept-language'] ?? '')
    if (/^Mozilla\/5\.0/.test(agent) && language !== '') return true
    // Reads stay open: they return the document the panel is already showing, and refusing them
    // would only break hand-inspection of a file that sits readable on disk anyway.
    return !writing
  }

  // `cross-site` is another origin entirely; `same-site` is another origin of the same site
  // (a.example.com -> b.example.com), which is not this panel either. Both are refused.
  if (site === 'cross-site' || site === 'same-site') return false
  // `Origin: null` is a sandboxed or opaque-origin document. Never this panel.
  if (origin === 'null') return false
  try {
    const parsed = new URL(origin)
    // The host comparison is for http(s), where a page and its route share one host.
    return parsed.host.toLowerCase() === String(request.headers.host ?? '').trim().toLowerCase()
  } catch {
    return false
  }
}
