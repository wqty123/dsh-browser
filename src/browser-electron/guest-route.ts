/**
 * Web guests execute in CSP-sandboxed opaque origins, including direct document loads.
 * Only this proxy prefix is available to guest network requests. App storage, APIs,
 * cookies and authenticated reference submission remain in the owning app frame.
 * @module dsh-builtin-browser/browser-electron/guest-route
 */
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { promises as dns } from 'node:dns'
import { guestRuntimeScript } from './guest-runtime.ts'
import { GuestCookieJar } from './guest-cookie-jar.ts'
import { rewriteCss } from './guest-css.ts'

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

export const GUEST_ROUTE = '/dsh-builtin-browser/browser-view/isolated-guest'

class UnsafeGuestTargetError extends Error {}

const cookieJar = new GuestCookieJar()

/** HTML responses larger than this pass through without rewriting. */
const MAX_REWRITE_BYTES = 4 * 1024 * 1024
const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024

/** Document content types eligible for rewriting. */
const REWRITABLE = /^(text\/|application\/(json|javascript|xhtml\+xml|xml|rss\+xml|atom\+xml))/iu

/** A desktop Chrome identity; several sites refuse a request without one. */
const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** Only site request metadata may leave the app; never forward DSH cookies or internal headers. */
const SAFE_REQUEST_HEADERS = new Set([
  'accept', 'accept-language', 'content-type', 'content-language', 'x-requested-with',
  'x-csrf-token', 'x-xsrf-token', 'range', 'if-range',
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

function proxyReference(raw: string, base: URL): string | undefined {
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed.startsWith('#')) return undefined
  try {
    const absolute = new URL(trimmed, base)
    if (absolute.protocol !== 'http:' && absolute.protocol !== 'https:') return undefined
    return guestPath(absolute.href)
  } catch {
    return undefined
  }
}

function stripDocumentPolicies(html: string): string {
  return html.replace(
    /<!--[\s\S]*?-->|<(script|style|textarea|title)\b(?:[^>"']|"[^"]*"|'[^']*')*>[\s\S]*?<\/\1\s*>|<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/giu,
    tag => {
      if (!/^<meta\s/iu.test(tag)) return tag
      for (const attribute of tag.matchAll(/\s+([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu)) {
        if (attribute[1]?.toLowerCase() !== 'http-equiv') continue
        const policy = decodeAttribute(attribute[2] ?? attribute[3] ?? attribute[4] ?? '').trim().toLowerCase()
        return policy === 'content-security-policy' || policy === 'content-security-policy-report-only' ? '' : tag
      }
      return tag
    },
  )
}

/**
 * Rewrite one document so its own links and assets stay inside the proxy.
 * @param html - the fetched document.
 * @param base - the original document URL used for relative references.
 * @returns the rewritten document.
 */
export function rewriteDocument(html: string, base: URL): string {
  const proxied = (raw: string): string | undefined => proxyReference(raw, base)
  return stripDocumentPolicies(html).replace(
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
    /(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/giu,
    (_match, open: string, css: string, close: string) => open + rewriteCss(css, proxied) + close,
  ).replace(
    /(\sstyle\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'<>`]+))/giu,
    (_match, prefix: string, doubleQuoted?: string, singleQuoted?: string, bare?: string) => {
      const quote = singleQuoted === undefined ? '"' : "'"
      return prefix + quote + escapeAttribute(rewriteCss(decodeAttribute(doubleQuoted ?? singleQuoted ?? bare ?? ''), proxied), quote) + quote
    },
  )
}

/** Relay reference data to the owning app frame, never authenticated API requests. */
export function relayTag(_sessionId: string): string {
  return `<script data-dsh-ref-guest-relay="1">
  window.addEventListener('message', function (event) {
    if (event.source !== window || !event.data || event.data.type !== 'dsh-browser-ref:intent') return;
    if (parent !== window) parent.postMessage(event.data, '*');
  });
  </script>`
}

function guestPolicy(authority: string): string {
  const sources = ['http:', 'https:'].map(protocol => new URL(protocol + '//' + authority).origin + GUEST_ROUTE).join(' ')
  return "sandbox allow-scripts allow-forms; default-src " + sources
    + "; script-src " + sources + " 'unsafe-inline' 'unsafe-eval'; style-src " + sources
    + " 'unsafe-inline'; img-src " + sources + " data: blob:; font-src " + sources + " data:; connect-src " + sources
    + "; frame-src " + sources + "; form-action " + sources
    + "; object-src 'none'; worker-src 'none'; base-uri 'none'"
}

/** Forward a document or sub-request, keeping upstream cookies off the DSH origin. */
export async function handleGuest(
  request: IncomingMessage,
  response: ServerResponse,
  overlayScript: string,
  sessionId: string,
): Promise<void> {
  const method = request.method ?? 'GET'
  const authority = request.headers.host ?? ''
  if (!/^(?:\[[\da-f:]+\]|[a-z\d.-]+)(?::\d+)?$/iu.test(authority)) {
    response.writeHead(400)
    response.end('guest proxy: invalid host')
    return
  }
  const policy = guestPolicy(authority)
  const writeHead = (status: number, headers: OutgoingHttpHeaders = {}): void => {
    response.writeHead(status, { ...headers, 'content-security-policy': policy })
  }
  response.setHeader('referrer-policy', 'no-referrer')
  response.setHeader('x-content-type-options', 'nosniff')
  response.setHeader('access-control-allow-origin', 'null')
  if (method === 'OPTIONS') {
    writeHead(204, {
      'access-control-allow-methods': 'GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS',
      'access-control-allow-headers': [...SAFE_REQUEST_HEADERS, 'x-dsh-guest-sub'].join(', '),
    })
    response.end()
    return
  }
  const query = new URLSearchParams((request.url ?? '').split('?')[1] ?? '')
  const session = query.get('s') ?? sessionId
  const target = guestTarget(request.url ?? '')
  if (target === undefined) {
    writeHead(400, { 'content-type': 'text/plain; charset=utf-8' })
    response.end('guest proxy: a canonical http(s) URL is required')
    return
  }
  let host = ''
  try { host = new URL('http://' + (request.headers.host ?? '')).hostname.toLowerCase().replace(/\.$/u, '') } catch {}
  const blocked = (url: URL): boolean => {
    return !/^https?:$/u.test(url.protocol) || url.username !== '' || url.password !== ''
      || isSelfTarget(url) || url.hostname.toLowerCase().replace(/\.$/u, '') === host
  }
  const addressesFor = async (hostname: string): Promise<string[]> =>
    (await dns.lookup(hostname.replace(/^\[|\]$/gu, ''), { all: true })).map(record => record.address)
  const blockedResolved = async (url: URL): Promise<boolean> => {
    if (blocked(url)) return true
    const addresses = await addressesFor(url.hostname)
    const hostUrl = host === '' ? undefined : new URL('http://' + host)
    const hostAddresses = hostUrl === undefined || isSelfTarget(hostUrl) ? [] : await addressesFor(host).catch(() => [])
    return addresses.length === 0 || addresses.some(address => {
      const literal = new URL('http://' + (address.includes(':') ? '[' + address + ']' : address))
      return isSelfTarget(literal) || hostAddresses.includes(address) || address === request.socket.localAddress
    })
  }
  const fetchTarget = async (url: URL, options: RequestInit): Promise<Response> => {
    if (await blockedResolved(url)) throw new UnsafeGuestTargetError('local and DSH host targets are not allowed')
    return fetch(url, options)
  }
  if (blocked(target)) {
    writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
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
  const jarCookie = cookieJar.getCookieHeader(target)
  const refreshCookies = (url = target): void => {
    const cookie = cookieJar.getCookieHeader(url)
    if (cookie) headers.set('cookie', cookie)
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
    const root = new URL('/', target.origin)
    refreshCookies(root)
    try {
      const warm = await fetchTarget(root, { method: 'GET', headers, redirect: 'manual' })
      cookieJar.setCookies(root, warm.headers.getSetCookie?.() ?? [])
      await warm.body?.cancel()
      headers.set('referer', root.href)
    } finally { refreshCookies() }
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
      let size = 0
      const tooLarge = (): void => {
        request.pause()
        writeHead(413, { 'content-type': 'text/plain; charset=utf-8', connection: 'close' })
        response.end('guest proxy: request body exceeds 10 MiB')
      }
      if (Number(request.headers['content-length']) > MAX_REQUEST_BODY_BYTES) {
        tooLarge()
        return
      }
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        size += buffer.length
        if (size > MAX_REQUEST_BODY_BYTES) {
          tooLarge()
          return
        }
        chunks.push(buffer)
      }
      body = Buffer.concat(chunks)
    }
    upstream = await fetchTarget(target, { method, headers, body: body as BodyInit | undefined, redirect: 'manual' })
    cookieJar.setCookies(target, upstream.headers.getSetCookie?.() ?? [])
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
          const retried = await fetchTarget(target, { method, headers, redirect: 'manual' })
          await upstream.body?.cancel()
          upstream = retried
        } catch { /* 重试失败就用首次响应 */ }
      }
    }
  } catch (error) {
    writeHead(error instanceof UnsafeGuestTargetError ? 403 : 502, { 'content-type': 'text/plain; charset=utf-8' })
    response.end(`guest proxy: cannot reach ${target.host}: ${String((error as Error).message ?? error)}`)
    return
  }
  cookieJar.setCookies(target, upstream.headers.getSetCookie?.() ?? [])
  const out = new Headers()
  for (const [name, value] of upstream.headers) {
    if (!DROP_RESPONSE_HEADERS.has(name.toLowerCase()) && !name.toLowerCase().startsWith('access-control-')) out.set(name, value)
  }
  const location = upstream.headers.get('location')
  if (location !== null && upstream.status >= 300 && upstream.status < 400) {
    let next: URL | undefined
    try {
      const candidate = new URL(location, target)
      if (!await blockedResolved(candidate)) next = candidate
    } catch {}
    if (next === undefined) {
      await upstream.body?.cancel()
      writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
      response.end('guest proxy: redirect target is not allowed')
      return
    }
    out.set('location', guestPath(next.href) + (session === '' ? '' : '&s=' + encodeURIComponent(session)))
  }
  const type = upstream.headers.get('content-type') ?? 'application/octet-stream'
  const length = Number(upstream.headers.get('content-length') ?? '0')
  if (method === 'HEAD' || upstream.body === null) {
    writeHead(upstream.status, Object.fromEntries(out))
    response.end()
    return
  }
  if (/^text\/css(?:;|$)/iu.test(type) && !(upstream.status >= 300 && upstream.status < 400)) {
    const css = rewriteCss(await upstream.text(), value => proxyReference(value, target))
    out.delete('etag')
    out.delete('content-md5')
    out.set('content-type', 'text/css; charset=utf-8')
    writeHead(upstream.status, Object.fromEntries(out))
    response.end(css)
    return
  }
  if (subRequest || !REWRITABLE.test(type) || !/^(text\/html|application\/xhtml\+xml)(?:;|$)/iu.test(type)
    || length > MAX_REWRITE_BYTES || (upstream.status >= 300 && upstream.status < 400)) {
    writeHead(upstream.status, Object.fromEntries(out))
    const body = Buffer.from(await upstream.arrayBuffer())
    response.end(/^(text\/html|application\/xhtml\+xml)(?:;|$)/iu.test(type)
      ? Buffer.from(stripDocumentPolicies(body.toString('latin1')), 'latin1') : body)
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
  writeHead(upstream.status, Object.fromEntries(out))
  response.end(body)
}
