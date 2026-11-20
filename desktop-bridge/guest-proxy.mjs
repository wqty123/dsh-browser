/**
 * Sidebar guest proxy policy — pure helpers, no Electron imports.
 *
 * WHY THIS EXISTS
 * The Sidebar browser uses an in-memory `session.fromPartition(...)` guest
 * session. By default Chromium resolves that session's proxy from the OS. On
 * machines with a system-wide rules proxy (for example 127.0.0.1:7890), every
 * CONNECT goes through the proxy's exit node. Some first-party DeepSeek pages
 * are then rejected by AWS WAF / CloudFront with the "Request blocked" 403
 * page, while the very same URL answers 200 when connected directly. A normal
 * browser on that machine is unaffected because its per-process proxy rules
 * send those hosts direct.
 *
 * POLICY
 * DEFAULT IS DIRECT. A global rules proxy (e.g. 127.0.0.1:7890) is usually
 * slower than a direct connection for ordinary sites, and on this class of
 * machine the sidebar was measurably 15-20x slower when forced through it
 * (baidu load 21.6s via proxy vs 1.1s direct). The guest session therefore
 * does NOT inherit the OS proxy unless the user explicitly asks for it.
 *
 * When a proxy IS wanted, `auto` re-expresses the resolved system proxy as
 * `fixed_servers` plus a bypass list, because Electron ignores
 * `proxyBypassRules` in `system` mode. `system` leaves the OS settings alone.
 * If the machine has no proxy, `auto` leaves the session in `system` mode so a
 * VPN/rules proxy switched on later is picked up without restarting the app.
 *
 * Overrides: DSH_SIDEBAR_PROXY_MODE=direct|auto|system,
 *            DSH_SIDEBAR_PROXY_BYPASS=<chromium bypass rules>,
 *            DSH_SIDEBAR_PROXY_RULES=<chromium proxyRules>.
 *
 * If a direct connection cannot be established at all (`did-fail-load` with a
 * DNS/connection error), the bridge retries that session once through the
 * system proxy — see `shouldFallbackToSystemProxy`.
 */

/** Hosts that must never be forced through the user's global proxy. */
export const DEFAULT_SIDEBAR_PROXY_BYPASS = 'deepseek.com;*.deepseek.com;localhost;127.0.0.1'

/**
 * Chromium net error codes worth retrying through the system proxy: name not
 * resolved, cannot connect, connection closed/timed out, address unreachable.
 * A 404/500 must NOT trigger the fallback — only transport failures.
 */
const PROXY_FALLBACK_ERRORS = new Set([-105, -106, -109, -118, -130, -137, -138])

/** @param {number} errorCode Chromium net error from `did-fail-load`. */
export function shouldFallbackToSystemProxy(errorCode) {
  return PROXY_FALLBACK_ERRORS.has(Number(errorCode))
}

/**
 * Turn Electron's `session.resolveProxy()` answer into Chromium proxyRules.
 * @param {string} resolved - e.g. "PROXY 127.0.0.1:7890", "SOCKS5 127.0.0.1:7891", "DIRECT".
 * @returns {{ rules: string, authority: string } | undefined}
 */
export function parseSystemProxy(resolved) {
  const first = String(resolved ?? '').split(';')[0].trim()
  const match = /^(PROXY|HTTPS|HTTP|SOCKS5?|SOCKS)\s+(\S+)$/iu.exec(first)
  if (!match) return undefined
  const scheme = match[1].toUpperCase()
  const authority = match[2]
  // Bare host:port (optionally a scheme-less IPv6 literal is not accepted by
  // Chromium here). Refuse anything else so a malformed answer cannot inject
  // extra proxy rules into the session.
  if (!/^[A-Za-z0-9._:-]+$/u.test(authority)) return undefined
  const rules = scheme.startsWith('SOCKS') ? `socks=${authority}` : `http=${authority};https=${authority}`
  return { rules, authority }
}

/**
 * Strip the Electron/application tokens from a guest's User-Agent.
 *
 * Electron's default UA reads like
 * `Mozilla/5.0 (...) AppleWebKit/537.36 (KHTML, like Gecko) @deepseek-ai/dsh-desktop/0.2.2-rc.1 Chrome/152.0.7977.130 Electron/44.7.0 Safari/537.36`.
 * Site-side bot / risk controls (DeepSeek's "使用环境异常", Baidu's security
 * checks, and similar banners on most sites) key off those tokens and treat
 * the embedded webview as a non-standard client. A stock Chrome UA avoids the
 * false positive while keeping the real Chromium version, so feature detection
 * still works.
 *
 * @param {string} raw - the session's current user agent.
 * @returns {string} a stock-Chrome-shaped user agent.
 */
export function normalizeGuestUserAgent(raw) {
  return String(raw ?? '')
    // Drop EVERY product token the app injected between the Gecko marker and
    // Chrome/ — Electron can add more than one (app name, build tag), and a
    // single-token regex would leave the rest visible to site-side checks.
    .replace(/(\(KHTML, like Gecko\))(?:\s+\S+)+?(?=\s+Chrome\/)/giu, '$1')
    // Electron / app tokens can also be appended after the Chrome version.
    .replace(/\s+(?:Electron\/[^\s]+|@deepseek-ai\/[^\s]+|DeepSeekHarness\/[^\s]+)/giu, '')
    .trim()
}

/**
 * @param {{ mode?: string, resolved?: string, bypass?: string, rules?: string }} [input]
 * @returns {object | undefined} Electron `session.setProxy` config, or undefined to leave OS settings alone.
 */
export function sidebarProxyConfig({ mode = 'direct', resolved = '', bypass = DEFAULT_SIDEBAR_PROXY_BYPASS, rules } = {}) {
  const policy = String(mode ?? 'direct').trim().toLowerCase()
  if (policy === 'system') return undefined
  if (policy === 'direct') return { mode: 'direct' }
  const parsed = rules ? { rules } : parseSystemProxy(resolved)
  // No usable proxy: do not override the session at all. Pinning `direct`
  // would freeze the setting and break sites as soon as the user enables a
  // proxy later in the same app session.
  if (!parsed) return undefined
  return { mode: 'fixed_servers', proxyRules: parsed.rules, proxyBypassRules: bypass }
}
