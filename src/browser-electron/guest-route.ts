/**
 * Same-origin guest proxy for the Web sidebar.
 *
 * WHY THIS EXISTS
 * The DSH desktop shell hosts a sidebar tab in an Electron `<webview>`, so the plugin can reach into
 * that guest and inject the reference bar. The Web shell has no such handle: its sidebar renders an
 * ordinary `<iframe>`, and an iframe pointed at a real site is cross-origin — unreadable and
 * uninjectable. That is why "the sidebar cannot reference" on Web while the same flow works in the
 * desktop shell, and why opening a page used to escape into a separate browser window.
 *
 * The fix is to serve the guest THROUGH the host: the iframe loads
 * `/dsh-builtin-browser/browser-view/guest/<encoded-url>`, this module fetches the page, rewrites its
 * document and subresource URLs to the same prefix, injects the reference overlay, and returns it
 * from the plugin's own origin. The frame is then same-origin, so selection, the bar and the intent
 * channel all work exactly as they do in the desktop guest.
 *
 * SCOPE AND LIMITS (deliberate, documented rather than hidden)
 * - Methods and bodies are forwarded; only HTML document responses are rewritten.
 * - Frames and scripts inside the page are not executed by the host; they load through the same
 *   prefix so they stay readable.
 * - The overlay is injected on every HTML response, so a rewritten navigation keeps the bar.
 * @module dsh-builtin-browser/browser-electron/guest-route
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { guestRuntimeScript } from './guest-runtime.ts'

/** Prefix every proxied document and subresource lives under. */

/**
 * Whether a proxied target is this machine (or this host) itself.
 *
 * The sidebar must never proxy DSH into itself: the guest would fetch the very server that is serving it,
 * and the connection came back as "guest proxy: cannot reach 127.0.0.1:3102: fetch failed" — a message that
 * reads like a network fault instead of "this is not allowed". Debugging DSH deliberately uses the
 * built-in browser instead (see the sidebar skill card).
 * @param url - the requested target.
 * @returns true for loopback, link-local and private hosts.
 */
function isSelfTarget(url: URL): boolean {
  const host = url.hostname.toLowerCase().replace(/\.$/u, '')
  if (host.endsWith('.localhost') || host === '[::]' || host.startsWith('[::ffff:')
    || /^\[(?:f[cd]|fe[89ab])/u.test(host) || /^169\.254\./u.test(host)) return true
  if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1' || host === '0.0.0.0') return true
  if (/^(?:0|127)\./u.test(host)) return true
  if (/^10\./u.test(host) || /^192\.168\./u.test(host)) return true
  if (/^172\.(1[6-9]|2\d|3[01])\./u.test(host)) return true
  return false
}

export const GUEST_ROUTE = '/dsh-builtin-browser/browser-view/guest'

/** Per-host cookies seen on proxied responses; replayed on the next request to that host. */
const cookieJar = new Map<string, Map<string, string>>()

/**
 * Record a response's cookies for one host.
 * @param host - the upstream host.
 * @param values - raw `set-cookie` header values.
 */
function rememberCookies(host: string, values: readonly string[]): void {
  if (values.length === 0) return
  const jar = cookieJar.get(host) ?? new Map<string, string>()
  for (const raw of values) {
    const pair = raw.split(';')[0] ?? ''
    const index = pair.indexOf('=')
    if (index <= 0) continue
    const name = pair.slice(0, index).trim()
    const expiry = /;\s*expires=([^;]+)/iu.exec(raw)?.[1]
    if (/;\s*max-age\s*=\s*0(?:;|$)/iu.test(raw) || (expiry !== undefined && Date.parse(expiry) <= Date.now())) jar.delete(name)
    else jar.set(name, pair.slice(index + 1).trim())
  }
  cookieJar.set(host, jar)
}

/**
 * The cookie header to replay for one host.
 * @param host - the upstream host.
 * @returns the header value, or undefined when nothing was recorded.
 */
function cookiesFor(host: string): string | undefined {
  const jar = cookieJar.get(host)
  if (jar === undefined || jar.size === 0) return undefined
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
}

/** Responses larger than this pass through without rewriting. */
const MAX_REWRITE_BYTES = 4 * 1024 * 1024

/** Content types eligible for rewriting; sub-requests and non-HTML still pass through raw. */
const REWRITABLE = /^(text\/|application\/(json|javascript|xhtml\+xml|xml|rss\+xml|atom\+xml))/iu

/** Only these site-minted cookies on the proxy origin may accompany jar cookies upstream. */
const FORWARD_COOKIE = /^(BAIDUID|BDUSS|BIDUPSID|PSTM|ZFY|BDSVRTM|H_PS_PSSID|__bsi|ab_sr|sug|sugstore|H_PS_|SUB|SUBP|SSOLoginState|SRF|ALF|XSRF)/iu

function forwardableCookies(header: string | undefined): string | undefined {
  if (typeof header !== 'string' || header === '') return undefined
  const pairs = header.split(';').map(part => part.trim()).filter(part => part !== '')
  const kept = pairs.filter(part => FORWARD_COOKIE.test(part.split('=')[0] ?? ''))
  return kept.length === 0 ? undefined : kept.join('; ')
}

/** A desktop Chrome identity; several sites refuse a request without one. */
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** Only site request metadata may leave the app; never forward DSH cookies or internal headers. */
const SAFE_REQUEST_HEADERS = new Set([
  'accept', 'accept-language', 'content-type', 'content-language', 'x-requested-with',
  'authorization', 'x-csrf-token', 'x-xsrf-token', 'range', 'if-range',
  'if-none-match', 'if-modified-since', 'cache-control',
])

/** Response headers that would break a same-origin document. */
const DROP_RESPONSE_HEADERS = new Set([
  'content-security-policy', 'content-security-policy-report-only', 'x-frame-options',
  'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive',
  'strict-transport-security', 'cross-origin-opener-policy', 'cross-origin-embedder-policy',
  'cross-origin-resource-policy', 'permissions-policy', 'set-cookie', 'refresh',
])

/**
 * Encode a target URL for the proxy prefix.
 * @param target - absolute http(s) URL.
 * @returns the path the iframe navigates to.
 */
export function guestPath(target: string): string {
  // The host's route registry only registers EXACT paths, so the target rides in a query parameter
  // instead of the path. Every rewritten reference keeps the same shape.
  return `${GUEST_ROUTE}?u=${encodeURIComponent(target)}`
}

/**
 * Decode a request path back to a target URL.
 * @param rawUrl - the incoming request URL (path + query).
 * @returns the absolute target, or undefined when the request is not a canonical proxied URL.
 */
export function guestTarget(rawUrl: string): URL | undefined {
  const index = rawUrl.indexOf('?')
  if (index === -1) return undefined
  const path = rawUrl.slice(0, index)
  if (path !== GUEST_ROUTE) return undefined
  let decoded: string
  try {
    decoded = new URLSearchParams(rawUrl.slice(index + 1)).get('u') ?? ''
  } catch {
    return undefined
  }
  if (decoded === '') return undefined
  try {
    const url = new URL(decoded)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined
    return url
  } catch {
    return undefined
  }
}

function decodeAttribute(value: string): string {
  const named: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' }
  return value.replace(/&(?:#(x[\da-f]+|\d+);?|(amp|quot|apos|lt|gt);)/giu, (match, numeric?: string, name?: string) => {
    if (numeric === undefined) return named[name?.toLowerCase() ?? ''] ?? match
    const point = /^x/iu.test(numeric) ? Number.parseInt(numeric.slice(1), 16) : Number(numeric)
    return point === 0 || point > 0x10ffff || (point >= 0xd800 && point <= 0xdfff) ? '\ufffd' : String.fromCodePoint(point)
  })
}

function escapeAttribute(value: string, quote: string): string {
  return value.replace(/[&<>"'`=\s]/gu, char => {
    if (char === '&') return '&amp;'
    if (char === '<') return '&lt;'
    if (char === '>') return '&gt;'
    return quote === '' || char === quote ? `&#${char.codePointAt(0)};` : char
  })
}

/**
 * Rewrite one document so its own links and assets stay inside the proxy.
 *
 * Attribute rewriting is deliberately conservative: only URL-bearing attributes are touched, and
 * `http(s)://` / protocol-relative / root-relative / relative references are all funnelled through
 * {@link guestPath}. Fragments, `data:`, `blob:` and `javascript:` are left alone — rewriting them
 * would break the page.
 * @param html - the fetched document.
 * @param base - the URL the document was fetched from (for resolving relative references).
 * @returns the rewritten document.
 */
export function rewriteDocument(html: string, base: URL): string {
  const proxied = (raw: string): string | undefined => {
    const trimmed = raw.trim()
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('data:')
      || trimmed.startsWith('blob:') || trimmed.startsWith('javascript:') || trimmed.startsWith('mailto:')) {
      return undefined
    }
    try {
      const absolute = new URL(trimmed, base)
      if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') return undefined
      return guestPath(absolute.href)
    } catch {
      return undefined
    }
  }
  return html.replace(
    // 三种引号形式都要改写，因为真实页面三种都在用：`src="/a.js"`、`src='/a.js'`，以及压缩过/服务端渲染
    // 的 HTML 更偏爱的无引号写法 `src=/a.js`。只处理带引号的两个，会让所有无引号资源指向 DSH 宿主而不是
    // 站点——实测 example.com 唯一的脚本就是 `<script src=/s.js>`：文档看着正常，脚本和样式全部 404。
    /(\s(?:href|src|poster|data-src|action)\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/giu,
    (match, prefix: string, doubleQuoted?: string, singleQuoted?: string, bare?: string) => {
      const value = doubleQuoted ?? singleQuoted ?? bare
      if (value === undefined) return match
      const next = proxied(decodeAttribute(value))
      if (next === undefined) return match
      const quote = singleQuoted !== undefined ? "'" : '"'
      return `${prefix}${quote}${escapeAttribute(next, quote)}${quote}`
    },
  ).replace(
    // `target="_blank"` 让点击**新开窗口**，代理改写就白做：实测百度新闻 107 个链接里 49 个带
    // `_blank`，点一下仍跳出侧栏（用户报的「在侧栏点链接却跳到 Edge」）。把目标改成 `_self`，
    // 导航就落回同一个 iframe——「页内导航不外跳」是这一步的结果，不靠额外拦截。
    /(\s)target\s*=\s*(["'])_(?:blank|new|top|parent)\2/giu,
    (match, space: string) => `${space}target="_self"`,
  ).replace(
    /(\ssrcset\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/giu,
    (match, prefix: string, doubleQuoted?: string, singleQuoted?: string, bare?: string) => {
      const value = doubleQuoted ?? singleQuoted ?? bare ?? ''
      const quote = singleQuoted !== undefined ? "'" : '"'
      const rewritten = decodeAttribute(value).split(',').map(part => {
        const [url, descriptor] = part.trim().split(/\s+/u)
        const next = url === undefined ? undefined : proxied(url)
        if (next === undefined) return part.trim()
        return descriptor === undefined ? next : `${next} ${descriptor}`
      }).join(', ')
      return `${prefix}${quote}${escapeAttribute(rewritten, quote)}${quote}`
    },
  ).replace(
    /url\((\s*['"]?)([^'")]+)\1\)/giu,
    (match, quote: string, value: string) => {
      const next = proxied(value)
      return next === undefined ? match : `url(${quote}${next}${quote})`
    },
  )
}

/**
 * The last mile for a proxied guest: hand the reference intent to the plugin.
 *
 * The desktop guest exposes a preload bridge; a proxied document does not, so the bar leaves its intent
 * in the queue. This relay drains that queue into the plugin's own capture route, which is same-origin
 * here and therefore carries the session cookie. Without it the bar appears and confirming looks like it
 * did nothing at all.
 * @param sessionId - the conversation the tab belongs to.
 * @returns the inline script element.
 */
export function relayTag(sessionId: string): string {
  const seeded = JSON.stringify(sessionId).replace(/</gu, '\\u003c')
  const body = [
    "(function(){",
    `  var session = ${seeded}`,
    "  var queue = window.__dshRefIntents || (window.__dshRefIntents = [])",
    "  var log = window.__relayLog || (window.__relayLog = [])",
    // The panel knows which conversation it belongs to, the document does not. Ask the parent (same
    // origin) once, and use the answer for every intent. Seeded value wins when it is present.
    "  try {",
    "    if (typeof session !== 'string' || session === '') top.postMessage({ type: 'dsh.sidebar.session.request' }, location.origin)",
    "  } catch (error) { /* top-level document: nothing to ask */ }",
    "  window.addEventListener('message', function (event) {",
    "    if (!event || event.origin !== location.origin) return",
    "    var data = event.data || {}",
    "    if (data.type === 'dsh.sidebar.session' && typeof data.sessionId === 'string') { session = data.sessionId; console.log('[relay] got session', session) }",
    "    if (data && (data.type === 'dsh-browser-ref:intent' || data.type === 'dsh.browser-reference.intent')) post(data)",
    "  })",
    "  log.push('relay:loaded')",
    "  var post = function (intent) {",
    "    log.push('relay:post session=' + session)",
    "    console.log('[relay] post intent, session=', session)",
    "    if (typeof session !== 'string' || session === '') return",
    "    try {",
    "      (window.__dshGuestFetch || window.fetch)('/dsh-builtin-browser/reference/capture', {",
    "        method: 'POST',",
    "        headers: { 'content-type': 'application/json' },",
    "        credentials: 'same-origin',",
    "        body: JSON.stringify(Object.assign({}, intent, { sessionId: session })),",
    "      }).then(function (r) { return r.text().then(function (b) { log.push('relay:status=' + r.status + ' ' + String(b).slice(0, 90)) }) }).catch(function (e) { log.push('relay:err=' + e) })",
    "    } catch (error) { /* the reader can retry; nothing is lost */ }",
    "  }",
    "  log.push('relay:queue len=' + queue.length)",
    "  var push = queue.push",
    "  queue.push = function (item) { post(item); return push.call(queue, item) }",
    "})()",
  ].join('\n')
  return `<script data-dsh-ref-guest-relay="1">${body}</script>`
}

/** Forward a document or sub-request, keeping upstream cookies off the DSH origin. */
export async function handleGuest(
  request: IncomingMessage,
  response: ServerResponse,
  overlayScript: string,
  sessionId: string,
): Promise<void> {
  const method = request.method ?? 'GET'
  const query = new URLSearchParams((request.url ?? '').split('?')[1] ?? '')
  const session = query.get('s') ?? sessionId
  const target = guestTarget(request.url ?? '')
  if (target === undefined) {
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('guest proxy: a canonical http(s) URL is required')
    return
  }
  const blocked = (url: URL): boolean => {
    let host = ''
    try { host = new URL('http://' + (request.headers.host ?? '')).hostname.toLowerCase().replace(/\.$/u, '') } catch {}
    return !/^https?:$/u.test(url.protocol) || url.username !== '' || url.password !== ''
      || isSelfTarget(url) || url.hostname.toLowerCase().replace(/\.$/u, '') === host
  }
  if (blocked(target)) {
    response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('guest proxy: local and DSH host targets are not allowed')
    return
  }
  const destination = request.headers['sec-fetch-dest']
  const subRequest = request.headers['x-dsh-guest-sub'] === '1'
    || (typeof destination === 'string' && destination !== 'document' && destination !== 'iframe')
  const headers = new Headers()
  for (const [name, value] of Object.entries(request.headers)) {
    if (!SAFE_REQUEST_HEADERS.has(name.toLowerCase()) || value === undefined) continue
    headers.set(name, Array.isArray(value) ? value.join(', ') : value)
  }
  headers.set('accept-encoding', 'identity')
  headers.set('user-agent', DESKTOP_UA)
  if (!headers.has('accept-language')) headers.set('accept-language', 'zh-CN,zh;q=0.9,en;q=0.8')
  // 页面内跳转的 Referer 会是我们自己的代理地址（iframe 里的上一页），对站点毫无意义；把它还原成
  // 「上一页的真实地址」，站点才当成站内导航处理。百度对 `/s?wd=…` 直接服务端拉取一律回「安全验证」，
  // 带上正确的 Referer 与首页 Cookie 后才会给结果页。
  const referer = request.headers.referer
  if (typeof referer === 'string') {
    try {
      const previous = guestTarget(new URL(referer).pathname + new URL(referer).search)
      if (previous !== undefined && !blocked(previous)) {
        headers.set('referer', previous.href)
      }
    } catch {}
  }
  const jarCookie = cookiesFor(target.host)
  const replay = forwardableCookies(request.headers.cookie)
  const refreshCookies = (): void => {
    const cookie = [cookiesFor(target.host), replay].filter(part => typeof part === 'string' && part !== '').join('; ')
    if (cookie !== '') headers.set('cookie', cookie)
    else headers.delete('cookie')
  }
  refreshCookies()
  // 站内导航的伪装头。
  //
  // 代理发出去的是「服务端 fetch」：没有 Origin，`sec-fetch-*` 也不存在，站点一眼就能判定这不是
  // 用户在站内点出来的请求。百度对这类请求一律回「安全验证」，而验证页本身的内容要由它的接口
  // 再取一次（跨域，取不到），于是侧栏里就是白屏——用户看到的是「点搜索没反应」。
  // 这几个头全部指向目标站点自己，转发出去与「用户在该站内点了一下」没有区别。
  headers.set('sec-fetch-site', 'same-origin')
  headers.set('sec-fetch-mode', subRequest ? 'cors' : 'navigate')
  headers.set('sec-fetch-dest', subRequest ? 'empty' : 'document')
  if (!subRequest || method !== 'GET') headers.set('origin', target.origin)
  if (!subRequest) {
    headers.set('sec-fetch-user', '?1')
    headers.set('upgrade-insecure-requests', '1')
  }
  const safeNavigation = !subRequest && (method === 'GET' || method === 'HEAD')
  const warmRoot = async (): Promise<void> => {
    const origin = new URL('/', target.origin).href
    const warm = await fetch(origin, { method: 'GET', headers, redirect: 'manual' })
    rememberCookies(target.host, warm.headers.getSetCookie?.() ?? [])
    await warm.body?.cancel()
    headers.set('referer', origin)
    refreshCookies()
  }
  // 深链接预热：直接拉 `https://host/s?…` 这类页面时，站点看到的是「没有站点 Cookie 的首跳」，
  // 百度会回「安全验证」。先取一次站点根，把服务端种的 Cookie 收进自己的罐子，并把 Referer 指向它，
  // 这次跳转就变成一次正常的站内导航。只在罐子里还没有该站 Cookie 且目标不是根路径时做一次。
  if (safeNavigation && !jarCookie && target.pathname !== '/' && !headers.has('referer')) {
    try { await warmRoot() } catch { /* 预热失败就按原样请求 */ }
  }
  let upstream: Response
  try {
    let body: Buffer | undefined
    if (method !== 'GET' && method !== 'HEAD') {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      body = Buffer.concat(chunks)
    }
    upstream = await fetch(target, { method, headers, body: body as BodyInit | undefined, redirect: 'manual' })
    rememberCookies(target.host, upstream.headers.getSetCookie?.() ?? [])
    // 反爬挑战识别 + 一次重试：站点（百度 `/s?wd=…`）在没有「先访问过站点」的痕迹时回「安全验证」。
    // 罐子里可能已经带着上次挑战页的 Cookie，所以这里不看有没有 Cookie，而是看**内容**：
    // 命中挑战就先取站点根补一次 Cookie，带上根的 Referer 重试一次。仍失败就把挑战页交给上层。
    const looksLikeChallenge = /安全验证|wappass|cf-browser-verification|Just a moment/iu
    if (safeNavigation && target.pathname !== '/' && /^text\/html/iu.test(upstream.headers.get('content-type') ?? '')
      && Number(upstream.headers.get('content-length') ?? '0') <= MAX_REWRITE_BYTES) {
      const probe = await upstream.clone().text()
      if (looksLikeChallenge.test(probe)) {
        try {
          await warmRoot()
          const retried = await fetch(target, { method, headers, redirect: 'manual' })
          await upstream.body?.cancel()
          upstream = retried
        } catch { /* 重试失败就用首次响应 */ }
      }
    }
  } catch (error) {
    response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(`guest proxy: cannot reach ${target.host}: ${String((error as Error).message ?? error)}`)
    return
  }
  rememberCookies(target.host, upstream.headers.getSetCookie?.() ?? [])
  const out = new Headers()
  for (const [name, value] of upstream.headers) {
    if (!DROP_RESPONSE_HEADERS.has(name.toLowerCase())) out.set(name, value)
  }
  const location = upstream.headers.get('location')
  if (location !== null && upstream.status >= 300 && upstream.status < 400) {
    let next: URL | undefined
    try { next = new URL(location, target) } catch {}
    if (next === undefined || blocked(next)) {
      await upstream.body?.cancel()
      response.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('guest proxy: redirect target is not allowed')
      return
    }
    out.set('location', guestPath(next.href) + (session === '' ? '' : '&s=' + encodeURIComponent(session)))
  }
  const type = upstream.headers.get('content-type') ?? 'application/octet-stream'
  const length = Number(upstream.headers.get('content-length') ?? '0')
  if (method === 'HEAD' || upstream.body === null) {
    response.writeHead(upstream.status, Object.fromEntries(out))
    response.end()
    return
  }
  if (subRequest || !REWRITABLE.test(type) || !/^(text\/html|application\/xhtml\+xml)(?:;|$)/iu.test(type)
    || length > MAX_REWRITE_BYTES || (upstream.status >= 300 && upstream.status < 400)) {
    response.writeHead(upstream.status, Object.fromEntries(out))
    response.end(Buffer.from(await upstream.arrayBuffer()))
    return
  }
  const raw = await upstream.text()
  const runtime = '<script data-dsh-guest-runtime="1">' + guestRuntimeScript(target.href) + '</script>'
  let body = rewriteDocument(raw, target)
  if (/<head\b[^>]*>/iu.test(body)) body = body.replace(/<head\b[^>]*>/iu, match => match + runtime)
  else if (/<html\b[^>]*>/iu.test(body)) body = body.replace(/<html\b[^>]*>/iu, match => match + '<head>' + runtime + '</head>')
  else body = runtime + body
  const tail = '\n' + overlayScript + '\n' + relayTag(session)
  body = /<\/body\s*>/iu.test(body) ? body.replace(/<\/body\s*>/iu, match => tail + match) : body + tail
  out.delete('etag')
  out.delete('content-md5')
  out.set('content-type', type)
  response.writeHead(upstream.status, Object.fromEntries(out))
  response.end(body)
}
