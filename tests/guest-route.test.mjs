import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { promises as dns } from 'node:dns'
import { handleGuest, guestPath, rewriteDocument } from '../src/browser-electron/guest-route.ts'
import { GuestCookieJar } from '../src/browser-electron/guest-cookie-jar.ts'
import { loadGuestCookies } from '../src/browser-electron/guest-cookie-store.ts'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const nativeFetch = globalThis.fetch
const nativeLookup = dns.lookup
const resolved = new Map()
let upstream, proxy, upstreamOrigin, proxyPort
const forwarded = []
let cookieJar = new GuestCookieJar()

before(async () => {
  dns.lookup = async (hostname, options) => {
    assert.equal(options.all, true)
    if (hostname === 'missing.example' || hostname === 'client-only.example') throw new Error('getaddrinfo ENOTFOUND')
    return (resolved.get(hostname) ?? [hostname === 'dsh.example' ? '93.184.216.35' : '93.184.216.34'])
      .map(address => ({ address, family: address.includes(':') ? 6 : 4 }))
  }
  upstream = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (req.url === '/authenticate' && req.method === 'POST') {
      res.writeHead(302, { location: '/secure', 'set-cookie': [
        'express:sess=eyJmaXh0dXJlIjp0cnVlfQ==; path=/; httponly',
        'express:sess.sig=fixture.signature_-; path=/; httponly',
      ] })
      res.end()
    } else if (req.url === '/secure') {
      if (req.headers.cookie !== 'express:sess=eyJmaXh0dXJlIjp0cnVlfQ==; express:sess.sig=fixture.signature_-') {
        res.writeHead(302, { location: '/login' })
        res.end()
      } else {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ cookie: req.headers.cookie }))
      }
    } else if (req.url === '/session-login') {
      res.writeHead(303, { location: '/account', 'set-cookie': ['SESSION=logged-in; Secure; HttpOnly; Path=/'] })
      res.end()
    } else if (req.url === '/quoted-login') {
      res.writeHead(303, { location: '/account', 'set-cookie': ['SID="abc"; Secure; Max-Age=3600; HttpOnly; Path=/'] })
      res.end()
    } else if (req.url === '/persistent-login') {
      res.writeHead(303, { location: '/account', 'set-cookie': ['SAVED=yes; Max-Age=3600; HttpOnly; Path=/', 'SESSION=temporary; Path=/'] })
      res.end()
    } else if (req.url === '/login') {
      res.writeHead(303, { location: '/account', 'set-cookie': ['SID=logged-in; HttpOnly; Path=/', 'theme=dark; Path=/'] })
      res.end()
    } else if (req.url === '/cookie-scopes/set') {
      res.writeHead(200, { 'content-type': 'application/json', 'set-cookie': [
        'default=directory', 'SID=root; Path=/', 'SID=area; Path=/cookie-scopes',
        'secure=https-only; Path=/; Secure', 'foreign=bad; Domain=unrelated.example; Path=/',
      ] })
      res.end('{}')
    } else if (req.url === '/' && req.headers['x-fixture-host'] !== 'empty.example') {
      res.writeHead(200, { 'set-cookie': 'VISITED=root; Path=/' })
      res.end('root')
    } else if (req.url === '/challenge' || req.url === '/cookie-scopes/challenge') {
      res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'CHALLENGE=seen; Path=/' })
      res.end('<html><body>安全验证</body></html>')
    } else if (req.url === '/large') {
      const body = '<a href="/raw">' + 'x'.repeat(4 * 1024 * 1024) + '</a>'
      res.writeHead(200, { 'content-type': 'text/html', 'content-length': Buffer.byteLength(body) })
      res.end(body)
    } else if (req.url === '/bad-redirect') {
      res.writeHead(307, { location: 'http://127.0.0.1/private' })
      res.end()
    } else if (req.url === '/dns-redirect') {
      res.writeHead(302, { location: 'https://redirect.example/private' })
      res.end()
    } else if (req.url === '/fragment') {
      res.writeHead(201, { 'content-type': 'text/html', 'x-frame-options': 'DENY',
        'content-security-policy': "frame-ancestors 'none'" })
      res.end('<a href="/raw">fragment</a>')
    } else if (req.url === '/script') {
      res.writeHead(200, { 'content-type': 'application/javascript' })
      res.end('fetch("/api"); const src="/raw";')
    } else if (req.url === '/doc') {
      res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY',
        'cache-control': 'public, max-age=86400', 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' })
      res.end('<html><head><script>original()</script></head><body><img src="pic.png"></body></html>')
    } else if (req.url === '/csp-doc' || req.url === '/large-csp-doc') {
      res.writeHead(200, { 'content-type': 'text/html',
        'content-security-policy': "default-src 'self'; font-src 'none'",
        'content-security-policy-report-only': "font-src 'none'",
        ...(req.url === '/large-csp-doc' ? { 'content-length': 5 * 1024 * 1024 } : {}),
      })
      const html = '<html><head><meta content="font-src &#39;none&#39;" http-equiv="Content-Security-Policy">'
        + '<style>@font-face{font-family:embedded;src:url(data:application/font-woff;charset=utf-8;base64,d09GRgABAAAAAA==)}</style></head><body>font</body></html>'
      res.end(req.url === '/large-csp-doc' ? html.padEnd(5 * 1024 * 1024) : html)
    } else if (req.url === '/styles/site.css') {
      res.writeHead(200, { 'content-type': 'text/css', etag: 'upstream-css', 'content-md5': 'upstream-digest',
        'content-security-policy': "font-src 'none'" })
      res.end('@import "theme/base.css"; .logo{background:url(../assets/img/logo.png)} @font-face{src:url(../fonts/font.woff2?v=4.7.0)}')
    } else if (req.url === '/styles/theme/base.css') {
      res.writeHead(200, { 'content-type': 'text/css' })
      res.end('.icon{background:url(/images/icon.png)}')
    } else if (req.url.startsWith('/fonts/') || req.url.startsWith('/assets/img/') || req.url.startsWith('/images/')) {
      res.writeHead(200, { 'content-type': req.url.startsWith('/fonts/') ? 'font/woff2' : 'image/png' })
      res.end('resource-bytes')
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() }))
    }
  }).listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`
  // Only the transport is redirected to the local fixture. Production guards still see public URLs.
  globalThis.fetch = (target, options) => {
    forwarded.push({ target: String(target), options: { ...options, headers: new Headers(options.headers) } })
    const url = new URL(target)
    if (!['ordinary.example', 'warm-get.example', 'warm-head.example', 'challenge.example', 'empty.example', 'scoped.example', 'practice.expandtesting.com'].includes(url.hostname)) throw new Error('unexpected upstream')
    const headers = new Headers(options.headers)
    headers.set('x-fixture-host', url.hostname)
    return nativeFetch(upstreamOrigin + url.pathname + url.search, { ...options, headers })
  }
  proxy = createServer((req, res) => {
    void handleGuest(req, res, '<script>overlay()</script>', 'owner', cookieJar).catch(error => res.destroy(error))
  }).listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  proxyPort = proxy.address().port
})

after(async () => {
  globalThis.fetch = nativeFetch
  dns.lookup = nativeLookup
  await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => upstream.close(resolve))])
})

function call(path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: proxyPort, path, method,
      headers: { host: 'dsh.example:3102', ...headers } }, async res => {
      const chunks = []
      for await (const chunk of res) chunks.push(chunk)
      resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() })
    })
    req.on('error', reject)
    req.end(body)
  })
}

test('rejects every unsafe DNS answer, DSH address aliases and unresolved targets before fetching', async () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '192.168.0.1', '169.254.169.254',
    '0.0.0.0', '::', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '93.184.216.35']) {
    resolved.set('alias.example', ['93.184.216.34', address])
    const count = forwarded.length
    const result = await call(guestPath('https://alias.example/'), { headers: { 'x-dsh-guest-sub': '1' } })
    assert.equal(result.status, 403, address)
    assert.equal(forwarded.length, count)
  }
  const count = forwarded.length
  assert.equal((await call(guestPath('https://missing.example/'))).status, 502)
  assert.equal(forwarded.length, count)
  resolved.delete('alias.example')
})

test('site-selected custom headers pass preflight and forwarding without forwarding DSH credentials or metadata', async () => {
  const path = guestPath('https://ordinary.example/echo')
  const preflight = await call(path, { method: 'OPTIONS', headers: {
    'access-control-request-headers': 'x-site-config, is_referer, cookie, authorization, x-dsh-secret, x-dsh-guest-headers',
  } })
  assert.equal(preflight.status, 204)
  const allowed = preflight.headers['access-control-allow-headers'].split(', ')
  assert.ok(allowed.includes('x-site-config')); assert.ok(allowed.includes('is_referer'))
  for (const name of ['cookie', 'authorization', 'x-dsh-secret']) assert.ok(!allowed.includes(name))
  assert.equal(preflight.headers['access-control-allow-credentials'], undefined)
  const result = await call(path, { headers: { 'x-dsh-guest-sub':'1',
    'x-dsh-guest-headers':'x-site-config,cookie,authorization,x-dsh-secret,host,origin',
    'x-site-config':'site-value', 'x-host-private':'host-value', cookie:'DSH=private', authorization:'Bearer host', 'x-dsh-secret':'host-secret',
  } })
  const headers = JSON.parse(result.body).headers
  assert.equal(headers['x-site-config'], 'site-value')
  for (const name of ['x-host-private', 'cookie', 'authorization', 'x-dsh-secret', 'x-dsh-guest-headers']) assert.equal(headers[name], undefined)
  const unmarked = await call(path, { headers: { 'sec-fetch-dest':'empty', 'x-dsh-guest-headers':'x-site-config', 'x-site-config':'not-from-guest' } })
  assert.equal(JSON.parse(unmarked.body).headers['x-site-config'], undefined)
})

test('validates DNS on redirect targets and again when the next hop is requested', async () => {
  const path = guestPath('https://ordinary.example/dns-redirect')
  resolved.set('redirect.example', ['::1'])
  assert.equal((await call(path, { headers: { 'x-dsh-guest-sub': '1' } })).status, 403)
  resolved.set('redirect.example', ['93.184.216.34'])
  const redirect = await call(path, { headers: { 'x-dsh-guest-sub': '1' } })
  assert.equal(redirect.status, 302)
  resolved.set('redirect.example', ['192.168.1.1'])
  const count = forwarded.length
  assert.equal((await call(redirect.headers.location)).status, 403)
  assert.equal(forwarded.length, count)
  resolved.delete('redirect.example')
})

test('unresolvable DSH host falls back to textual self comparison without relaxing target DNS validation', async () => {
  const options = { headers: { host: 'client-only.example:3102', 'x-dsh-guest-sub': '1' } }
  const count = forwarded.length
  const allowed = await call(guestPath('https://ordinary.example/echo'), options)
  assert.equal(allowed.status, 200)
  assert.equal(forwarded.length, count + 1)
  assert.equal((await call(guestPath('https://client-only.example/'), options)).status, 403)
  assert.equal((await call(guestPath('https://missing.example/'), options)).status, 502)
  resolved.set('private-alias.example', ['10.0.0.1'])
  try {
    assert.equal((await call(guestPath('https://private-alias.example/'), options)).status, 403)
    assert.equal(forwarded.length, count + 1)
  } finally { resolved.delete('private-alias.example') }
})

test('forwards POST body, content type and safe headers without app cookies or internal headers', async () => {
  const result = await call(guestPath('https://ordinary.example/echo'), { method: 'POST', body: 'q=hello&pw=secret',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json',
      'x-requested-with': 'XMLHttpRequest', authorization: 'Bearer dsh-private',
      cookie: 'DSH=private; session=app-private', 'x-dsh-private': 'private', 'x-dsh-guest-sub': '1' } })
  assert.equal(result.status, 200)
  const echo = JSON.parse(result.body)
  assert.equal(echo.method, 'POST')
  assert.equal(echo.body, 'q=hello&pw=secret')
  assert.equal(echo.headers['content-type'], 'application/x-www-form-urlencoded')
  assert.equal(echo.headers.accept, 'application/json')
  assert.equal(echo.headers['x-requested-with'], 'XMLHttpRequest')
  assert.equal(echo.headers.authorization, undefined)
  assert.equal(echo.headers.cookie, undefined)
  assert.equal(echo.headers['x-dsh-private'], undefined)
  assert.equal(echo.headers['x-dsh-guest-sub'], undefined)
})

test('caps declared and chunked request bodies at 10 MiB without reading or forwarding the remainder', async () => {
  for (const declared of [true, false]) {
    const count = forwarded.length
    let reads = 0, paused = false, status, message, responseHeaders
    const request = { method: 'POST', url: guestPath('https://ordinary.example/echo'),
      headers: { host: 'dsh.example', ...(declared ? { 'content-length': String(10 * 1024 * 1024 + 1) } : {}) },
      pause() { paused = true },
      async *iterator(options) {
        assert.equal(options.destroyOnReturn, false)
        reads++
        yield Buffer.alloc(10 * 1024 * 1024)
        reads++
        yield Buffer.alloc(1)
        assert.fail('must not read the remainder')
      } }
    await handleGuest(request, {
      setHeader() {},
      writeHead(code, headers) { status = code; responseHeaders = headers },
      end(body) { message = body },
    }, '', '')
    assert.equal(status, 413)
    assert.equal(responseHeaders.connection, 'close')
    assert.match(message, /10 MiB/)
    assert.equal(paused, true)
    assert.equal(reads, declared ? 0 : 2)
    assert.equal(forwarded.length, count)
  }
})

test('accepts empty bodies and bodies exactly at the request limit', async () => {
  for (const body of ['', 'x'.repeat(10 * 1024 * 1024)]) {
    const result = await call(guestPath('https://ordinary.example/echo'), { method: 'POST', body })
    assert.equal(result.status, 200)
    assert.equal(JSON.parse(result.body).body, body)
  }
})

test('proxy restores persistent and session login cookies after restart', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'guest-cookies-http-'))
  const previous = cookieJar
  t.after(() => { cookieJar = previous; rmSync(directory, { recursive: true, force: true }) })
  cookieJar = loadGuestCookies(directory)
  const login = await call(guestPath('https://ordinary.example/persistent-login'), { method: 'POST' })
  assert.equal(login.status, 303)
  assert.equal(login.headers['set-cookie'], undefined)
  let account = await call(login.headers.location)
  assert.equal(JSON.parse(account.body).headers.cookie, 'SAVED=yes; SESSION=temporary')
  cookieJar = loadGuestCookies(directory)
  account = await call(login.headers.location)
  assert.equal(JSON.parse(account.body).headers.cookie, 'SAVED=yes; SESSION=temporary')
})

test('Express login cookies set on a 302 reach the secure page and survive store reload', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'guest-express-'))
  const previous = cookieJar
  t.after(() => { cookieJar = previous; rmSync(directory, { recursive: true, force: true }) })
  cookieJar = loadGuestCookies(directory)
  const login = await call(guestPath('https://practice.expandtesting.com/authenticate'), {
    method: 'POST', body: 'username=fixture&password=fixture',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  })
  assert.equal(login.status, 302)
  assert.equal(login.headers['set-cookie'], undefined)
  assert.equal(login.headers.location, guestPath('https://practice.expandtesting.com/secure') + '&s=owner')
  const saved = JSON.parse(readFileSync(join(directory, 'cookies.json'), 'utf8')).cookies
  assert.deepEqual(saved.map(cookie => cookie.name), ['express:sess', 'express:sess.sig'])
  for (let request = 0; request < 2; request++) {
    const secure = await call(login.headers.location)
    assert.equal(secure.status, 200, 'the authenticated page must not redirect back to login')
    assert.equal(JSON.parse(secure.body).cookie, 'express:sess=eyJmaXh0dXJlIjp0cnVlfQ==; express:sess.sig=fixture.signature_-')
    if (request === 0) cookieJar = loadGuestCookies(directory)
  }
})

test('session-cookie login survives a real HTTP proxy round-trip and store reload', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'guest-session-'))
  const previous = cookieJar
  t.after(() => { cookieJar = previous; rmSync(directory, { recursive: true, force: true }) })
  cookieJar = loadGuestCookies(directory)
  const login = await call(guestPath('https://ordinary.example/session-login'), { method: 'POST' })
  assert.equal(login.status, 303)
  assert.equal(login.headers['set-cookie'], undefined)
  assert.equal(JSON.parse((await call(login.headers.location)).body).headers.cookie, 'SESSION=logged-in')
  const saved = JSON.parse(readFileSync(join(directory, 'cookies.json'), 'utf8')).cookies
  assert.equal(saved.length, 1)
  assert.equal(saved[0].name, 'SESSION')
  assert.equal(Object.hasOwn(saved[0], 'expiresAt'), false)
  cookieJar = loadGuestCookies(directory)
  const account = await call(login.headers.location)
  assert.equal(account.status, 200)
  assert.equal(JSON.parse(account.body).headers.cookie, 'SESSION=logged-in')
})

test('quoted login cookie survives an HTTP proxy round-trip and restart with quotes preserved', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'guest-quoted-'))
  const previous = cookieJar
  t.after(() => { cookieJar = previous; rmSync(directory, { recursive: true, force: true }) })
  cookieJar = loadGuestCookies(directory)
  const login = await call(guestPath('https://ordinary.example/quoted-login'), { method: 'POST' })
  assert.equal(login.status, 303)
  assert.equal(login.headers['set-cookie'], undefined)
  assert.equal(JSON.parse((await call(login.headers.location)).body).headers.cookie, 'SID="abc"')
  assert.equal(JSON.parse(readFileSync(join(directory, 'cookies.json'), 'utf8')).cookies[0].value, '"abc"')
  cookieJar = loadGuestCookies(directory)
  const account = await call(login.headers.location)
  assert.equal(account.status, 200)
  assert.equal(JSON.parse(account.body).headers.cookie, 'SID="abc"')
})

test('browser cookie values are validated on parse, load and use without stripping quotes', () => {
  const target = new URL('https://ordinary.example/')
  for (const value of ['', 'abc', '"abc"', '""', 'a=b', '"a=b"', '"', '"abc', 'abc"', '"a"b"', '"a b"', '"a,b"', '"a\\b"', '\u00ff']) {
    const jar = new GuestCookieJar()
    jar.setCookies(target, [`SID=${value}; Max-Age=3600`])
    assert.equal(jar.getCookieHeader(target), `SID=${value}`)
    const loaded = new GuestCookieJar(undefined, [{ origin: target.origin, name: 'SID', value,
      path: '/', secure: false, expiresAt: Date.now() + 3600000 }])
    assert.equal(loaded.getCookieHeader(target), `SID=${value}`)
  }
  for (const value of ['"a\nb"', 'abc\n', 'a\u0000b', 'a\tb', '\u007f', '\u0100']) {
    const jar = new GuestCookieJar()
    jar.setCookies(target, [`SID=${value}; Max-Age=3600`])
    assert.equal(jar.getCookieHeader(target), undefined, JSON.stringify(value))
    const loaded = new GuestCookieJar(undefined, [{ origin: target.origin, name: 'SID', value,
      path: '/', secure: false, expiresAt: Date.now() + 3600000 }])
    assert.equal(loaded.getCookieHeader(target), undefined, JSON.stringify(value))
  }
})

test('browser cookie names accept punctuation and spaces, trim only SP and HTAB, and support nameless cookies', () => {
  const target = new URL('https://ordinary.example/')
  for (const name of ['express:sess', 'express:sess.sig', 'spaced name', 'punct(<>@,":)/?[]{}', '\u00a0name\u00a0']) {
    const jar = new GuestCookieJar()
    jar.setCookies(target, [`\t ${name}\t =\t "a=b, c\\d" \t; Path\t=\t/; HttpOnly`])
    assert.equal(jar.getCookieHeader(target), `${name}="a=b, c\\d"`)
    const loaded = new GuestCookieJar(undefined, [{ origin: target.origin, name: `\t ${name}\t `,
      value: '\t "a=b, c\\d" \t', path: '/', secure: false }])
    assert.equal(loaded.getCookieHeader(target), `${name}="a=b, c\\d"`)
  }
  for (const raw of ['value-only', '=value-only']) {
    const jar = new GuestCookieJar()
    jar.setCookies(target, [raw])
    assert.equal(jar.getCookieHeader(target), 'value-only')
    assert.equal(new GuestCookieJar(undefined, [{ origin: target.origin, name: '', value: 'value-only',
      path: '/', secure: false }]).getCookieHeader(target), 'value-only')
  }
  const jar = new GuestCookieJar()
  jar.setCookies(target, ['SID=first=second; ignored=attribute', 'NBSP=\u00a0value\u00a0', 'EMPTY=\t '])
  assert.equal(jar.getCookieHeader(target), 'SID=first=second; NBSP=\u00a0value\u00a0; EMPTY=')
})

test('browser cookie parsing rejects controls, empty pairs and oversized names plus values without losing good entries', () => {
  const target = new URL('https://ordinary.example/')
  const saved = (name, value) => ({ origin: target.origin, name, value, path: '/', secure: false })
  for (const [name, value] of [['SID', 'x'.repeat(4094)], ['x'.repeat(4097), ''], ['', ''],
    ['bad\tname', 'x'], ['bad\u0000name', 'x'], ['bad\u001fname', 'x'], ['bad\u007fname', 'x'], ['\u0100', 'x']]) {
    const jar = new GuestCookieJar()
    jar.setCookies(target, ['GOOD=kept', `${name}=${value}`])
    assert.equal(jar.getCookieHeader(target), 'GOOD=kept', JSON.stringify(name))
    const loaded = new GuestCookieJar(undefined, [saved('GOOD', 'kept'), saved(name, value)])
    assert.equal(loaded.getCookieHeader(target), 'GOOD=kept', JSON.stringify(name))
  }
  for (const [name, value] of [['SID', 'x'.repeat(4093)], ['x'.repeat(4096), ''], ['', 'x'.repeat(4096)]]) {
    const expected = name === '' ? value : `${name}=${value}`
    const jar = new GuestCookieJar()
    jar.setCookies(target, [`${name}=${value}`])
    assert.equal(jar.getCookieHeader(target), expected)
    assert.equal(new GuestCookieJar(undefined, [saved(name, value)]).getCookieHeader(target), expected)
  }
  for (const [name, value] of [['bad;name', 'x'], ['bad=name', 'x'], ['SID', 'bad;value'], ['', '__Host-injected=x']]) {
    assert.equal(new GuestCookieJar(undefined, [saved(name, value)]).getCookieHeader(target), undefined)
  }
  const jar = new GuestCookieJar()
  jar.setCookies(target, ['', '\t ; HttpOnly', '=', '__Secure-invalid=x', '=__Secure-invalid=x',
    '=__Host-invalid=x; Secure', 'SID=x; ignored=internal\ttab', 'SID=x; ignored=internal\u001fcontrol'])
  assert.equal(jar.getCookieHeader(target), undefined)
})

test('http port 443 cookies survive restart without breaking any sidebar page', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'guest-http443-'))
  const previous = cookieJar
  t.after(() => { cookieJar = previous; rmSync(directory, { recursive: true, force: true }) })
  cookieJar = loadGuestCookies(directory)
  const login = await call(guestPath('http://ordinary.example:443/persistent-login'), { method: 'POST' })
  assert.equal(login.status, 303)
  assert.equal(JSON.parse((await call(login.headers.location)).body).headers.cookie, 'SAVED=yes; SESSION=temporary')
  cookieJar = loadGuestCookies(directory)
  const account = await call(login.headers.location)
  assert.equal(account.status, 200)
  assert.equal(JSON.parse(account.body).headers.cookie, 'SAVED=yes; SESSION=temporary')
  for (const url of ['http://ordinary.example/account', 'https://ordinary.example:443/account', 'http://scoped.example:443/account']) {
    const other = await call(guestPath(url))
    assert.equal(other.status, 200)
    assert.doesNotMatch(JSON.parse(other.body).headers.cookie ?? '', /SAVED=|SESSION=/u)
  }
  assert.equal(JSON.parse(readFileSync(join(directory, 'cookies.json'), 'utf8')).cookies[0].origin, 'http://ordinary.example:443')
})

for (const failure of ['corrupt', 'invalid-entry', 'unreadable']) {
  test(`proxy recovers from ${failure} cookie storage and rewrites sanitized data`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'guest-recover-'))
    const file = join(directory, 'cookies.json')
    const previous = cookieJar
    t.after(() => { cookieJar = previous; rmSync(directory, { recursive: true, force: true }) })
    if (failure === 'unreadable') mkdirSync(file)
    else if (failure === 'corrupt') writeFileSync(file, '{BROKEN_SECRET')
    else writeFileSync(file, JSON.stringify({ version: 1, cookies: [null, { origin: 'https://bad host', value: 'SECRET' },
      { origin: 'https://ORDINARY.example:443/', name: 'VALID', value: 'yes', path: '/', secure: true, expiresAt: Date.now() + 3600000 },
      { origin: 'https://ordinary.example', name: 'BAD', value: 'line\r\ninjection', path: '/', secure: false, expiresAt: Date.now() + 3600000 },
    ] }))
    cookieJar = loadGuestCookies(directory)
    const account = await call(guestPath('https://ordinary.example/account'))
    assert.equal(account.status, 200)
    assert.equal(JSON.parse(account.body).headers.cookie, failure === 'invalid-entry' ? 'VALID=yes' : 'VISITED=root')
    if (failure === 'unreadable') {
      rmSync(file, { recursive: true })
      const login = await call(guestPath('https://ordinary.example/persistent-login'), { method: 'POST' })
      assert.equal(login.status, 303)
    }
    const saved = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(saved.cookies.length, failure === 'unreadable' ? 3 : 1)
    if (failure === 'invalid-entry') assert.equal(saved.cookies[0].origin, 'https://ordinary.example')
    assert.equal(readFileSync(file, 'utf8').includes('SECRET'), false)
    cookieJar = loadGuestCookies(directory)
    assert.equal((await call(guestPath('https://scoped.example/account'))).status, 200)
  })
}

test('stores redirect cookies and rewrites redirect location for a login round-trip', async () => {
  const login = await call(guestPath('https://ordinary.example/login'), { method: 'POST', body: 'login=1' })
  assert.equal(login.status, 303)
  assert.equal(login.headers.location, guestPath('https://ordinary.example/account') + '&s=owner')
  assert.equal(login.headers['set-cookie'], undefined)
  const account = await call(login.headers.location)
  assert.equal(JSON.parse(account.body).headers.cookie, 'SID=logged-in; theme=dark')
  assert.equal(forwarded.at(-1).options.redirect, 'manual')
})

test('never replays browser cookies, including site-looking names, alongside the jar', async () => {
  const result = await call(guestPath('https://ordinary.example/echo'), {
    headers: { cookie: 'DSH=private; BAIDUID=baidu; SUB=weibo; XSRF=site-token; session=private' },
  })
  assert.equal(JSON.parse(result.body).headers.cookie, 'SID=logged-in; theme=dark')
})

test('proxy cookie round-trip honors directory paths, duplicate names and Secure without leaking Set-Cookie', async () => {
  const options = { headers: { 'x-dsh-guest-sub': '1' } }
  const result = await call(guestPath('https://scoped.example/cookie-scopes/set'), options)
  assert.equal(result.status, 200)
  assert.equal(result.headers['set-cookie'], undefined)
  const inside = await call(guestPath('https://scoped.example/cookie-scopes/echo'), options)
  assert.equal(JSON.parse(inside.body).headers.cookie, 'default=directory; SID=area; SID=root; secure=https-only')
  const outside = await call(guestPath('https://scoped.example/cookie-scopes-other'), options)
  assert.equal(JSON.parse(outside.body).headers.cookie, 'SID=root; secure=https-only')
  const insecure = await call(guestPath('http://scoped.example/echo'), options)
  assert.equal(JSON.parse(insecure.body).headers.cookie, undefined)
})

test('cookie jar validates Domain but conservatively retains exact host and port isolation', () => {
  const jar = new GuestCookieJar()
  const target = new URL('https://login.example.com/account/login')
  assert.equal(jar.getCookieHeader(target), undefined)
  jar.setCookies(target, ['host=only; Path=/', 'parent=valid; Domain=.example.com; Path=/',
    'suffix=isolated; Domain=com; Path=/', 'foreign=no; Domain=elsewhere.com', 'trailing=no; Domain=example.com.'])
  assert.equal(jar.getCookieHeader(target), 'host=only; parent=valid')
  for (const url of ['https://example.com/', 'https://other.example.com/', 'https://child.login.example.com/',
    'https://login.example.com:8443/', 'https://login.example.com.evil/']) {
    assert.equal(jar.getCookieHeader(new URL(url)), undefined, url)
  }
})

test('challenge warm-up only sends root-matching jar cookies and restores target-path cookies for retry', async () => {
  const count = forwarded.length
  await call(guestPath('https://scoped.example/cookie-scopes/challenge'), {
    headers: { referer: 'https://dsh.example' + guestPath('https://scoped.example/previous') },
  })
  const sent = forwarded.slice(count)
  assert.equal(sent.length, 3)
  assert.equal(sent[1].target, 'https://scoped.example/')
  assert.equal(sent[1].options.headers.get('cookie'), 'SID=root; secure=https-only; CHALLENGE=seen')
  assert.equal(sent[2].options.headers.get('cookie'), 'default=directory; SID=area; SID=root; secure=https-only; CHALLENGE=seen; VISITED=root')
})

test('cookie jar expires, deletes and replaces cookies with Max-Age taking precedence over Expires', t => {
  let now = Date.UTC(2030, 0, 1)
  t.mock.method(Date, 'now', () => now)
  const target = new URL('https://site.example/account/page')
  const jar = new GuestCookieJar()
  jar.setCookies(target, ['short=lived; Max-Age=2', 'expired=no; Expires=Tue, 01 Jan 2000 00:00:00 GMT',
    'precedence=yes; Max-Age=10; Expires=Tue, 01 Jan 2000 00:00:00 GMT',
    'reverse=yes; Expires=Tue, 01 Jan 2000 00:00:00 GMT; Max-Age=10', 'session=one'])
  jar.setCookies(target, ['session=two'])
  assert.equal(jar.getCookieHeader(target), 'short=lived; precedence=yes; reverse=yes; session=two')
  now += 2000
  assert.equal(jar.getCookieHeader(target), 'precedence=yes; reverse=yes; session=two')
  jar.setCookies(target, ['precedence=gone; Max-Age=-1', 'reverse=gone; Max-Age=0'])
  assert.equal(jar.getCookieHeader(target), 'session=two')
  jar.setCookies(target, ['session=gone; Expires=Tue, 01 Jan 2000 00:00:00 GMT'])
  assert.equal(jar.getCookieHeader(target), undefined)
})

test('cookie jar ignores malformed cookies and protects Secure and host-prefixed cookies', () => {
  const jar = new GuestCookieJar()
  const https = new URL('https://secure.example/')
  const http = new URL('http://secure.example/')
  jar.setCookies(https, ['', '=', 'bad\tname=x', 'control=x\r\ny',
    '__Secure-invalid=no', '__Host-domain=no; Secure; Domain=secure.example; Path=/',
    '__Host-path=no; Secure; Path=/sub', 'empty=; Path=/', 'SID=safe; Secure; Path=/',
    '__Secure-valid=yes; Secure; Path=/', '__Host-valid=yes; Secure; Path=/'])
  jar.setCookies(http, ['SID=overwrite; Path=/', 'SID=delete; Max-Age=0; Path=/', 'new=no; Secure'])
  assert.equal(jar.getCookieHeader(https), 'empty=; SID=safe; __Secure-valid=yes; __Host-valid=yes')
  assert.equal(jar.getCookieHeader(http), undefined)
  jar.setCookies(https, [])
  assert.equal(jar.getCookieHeader(https), 'empty=; SID=safe; __Secure-valid=yes; __Host-valid=yes')
})

test('restores navigation headers and defaults language without overwriting inbound language', async () => {
  const result = await call(guestPath('https://ordinary.example/echo'), {
    headers: { referer: 'https://dsh.example' + guestPath('https://other.example/previous') },
  })
  const headers = JSON.parse(result.body).headers
  assert.equal(headers.origin, 'https://ordinary.example')
  assert.equal(headers.referer, 'https://other.example/previous')
  assert.equal(headers['accept-language'], 'zh-CN,zh;q=0.9,en;q=0.8')
  const sent = forwarded.at(-1).options.headers
  for (const [name, value] of Object.entries({ 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate',
    'sec-fetch-dest': 'document', 'sec-fetch-user': '?1', 'upgrade-insecure-requests': '1' })) {
    assert.equal(sent.get(name), value)
  }
  const custom = await call(guestPath('https://ordinary.example/echo'), { headers: { 'accept-language': 'en-US' } })
  assert.equal(JSON.parse(custom.body).headers['accept-language'], 'en-US')
})

test('sub-requests use cors metadata, origin for POST, and never navigation-only headers', async () => {
  for (const method of ['GET', 'POST']) {
    const result = await call(guestPath('https://ordinary.example/echo'), { method, headers: { 'x-dsh-guest-sub': '1' } })
    const headers = JSON.parse(result.body).headers
    assert.equal(headers.origin, method === 'POST' ? 'https://ordinary.example' : undefined)
    assert.equal(headers['sec-fetch-site'], 'same-origin')
    assert.equal(headers['sec-fetch-mode'], 'cors')
    assert.equal(headers['sec-fetch-dest'], 'empty')
    assert.equal(headers['sec-fetch-user'], undefined)
    assert.equal(headers['upgrade-insecure-requests'], undefined)
  }
})

test('GET and HEAD deep links warm the root once and reuse root cookies and referer', async () => {
  for (const [host, method] of [['warm-get.example', 'GET'], ['warm-head.example', 'HEAD']]) {
    const before = forwarded.length
    await call(guestPath('https://' + host + '/echo'), { method })
    const requests = forwarded.slice(before)
    assert.deepEqual(requests.map(item => item.target), ['https://' + host + '/', 'https://' + host + '/echo'])
    assert.equal(requests[0].options.method, 'GET')
    assert.equal(requests[0].options.redirect, 'manual')
    assert.equal(requests[1].options.method, method)
    assert.equal(requests[1].options.headers.get('cookie'), 'VISITED=root')
    assert.equal(requests[1].options.headers.get('referer'), 'https://' + host + '/')
  }
})

test('GET challenge warms once and retries once, merging challenge, root and inbound cookies', async () => {
  const before = forwarded.length
  await call(guestPath('https://challenge.example/challenge'), {
    headers: { referer: 'https://dsh.example' + guestPath('https://challenge.example/previous'), cookie: 'SUB=weibo' },
  })
  const requests = forwarded.slice(before)
  assert.deepEqual(requests.map(item => item.target), [
    'https://challenge.example/challenge', 'https://challenge.example/', 'https://challenge.example/challenge',
  ])
  assert.equal(requests[2].options.headers.get('cookie'), 'CHALLENGE=seen; VISITED=root')
  assert.equal(requests[2].options.headers.get('referer'), 'https://challenge.example/')
})

test('POST and sub-request challenges are never warmed or retried', async () => {
  for (const options of [{ method: 'POST', body: 'login=1' }, { headers: { 'x-dsh-guest-sub': '1' } }]) {
    const before = forwarded.length
    const result = await call(guestPath('https://challenge.example/challenge'), options)
    assert.equal(result.status, 200)
    assert.equal(forwarded.length - before, 1)
    assert.equal(forwarded.at(-1).target, 'https://challenge.example/challenge')
  }
})

test('large HTML responses bypass rewriting and challenge probing', async () => {
  const result = await call(guestPath('https://ordinary.example/large'))
  assert.equal(result.body, '<a href="/raw">' + 'x'.repeat(4 * 1024 * 1024) + '</a>')
})

test('HTML sub-requests stay raw by explicit marker or fetch destination; framing headers are stripped', async () => {
  for (const headers of [{ 'x-dsh-guest-sub': '1' }, { 'sec-fetch-dest': 'empty' }, { 'sec-fetch-dest': 'script' }]) {
    const result = await call(guestPath('https://ordinary.example/fragment'), { headers })
    assert.equal(result.status, 201)
    assert.equal(result.headers['content-type'], 'text/html')
    assert.equal(result.body, '<a href="/raw">fragment</a>')
    assert.equal(result.headers['x-frame-options'], undefined)
    assert.match(result.headers['content-security-policy'], /sandbox allow-scripts allow-forms;/)
  }
})

test('non-HTML bodies remain byte-for-byte unchanged', async () => {
  const result = await call(guestPath('https://ordinary.example/script'))
  assert.equal(result.body, 'fetch("/api"); const src="/raw";')
  assert.equal(result.headers['content-type'], 'application/javascript')
})

test('stylesheet imports, images and fonts resolve against each original resource URL', async () => {
  const sheet = await call(guestPath('https://ordinary.example/styles/site.css'), {
    headers: { 'sec-fetch-dest': 'style', cookie: 'DSH_SESSION=private' },
  })
  assert.equal(sheet.status, 200)
  assert.equal(sheet.headers['content-type'], 'text/css; charset=utf-8')
  assert.equal(sheet.headers.etag, undefined)
  assert.equal(sheet.headers['content-md5'], undefined)
  assert.equal(sheet.headers['access-control-allow-origin'], 'null')
  const imported = guestPath('https://ordinary.example/styles/theme/base.css')
  const image = guestPath('https://ordinary.example/assets/img/logo.png')
  const font = guestPath('https://ordinary.example/fonts/font.woff2?v=4.7.0')
  assert.equal(sheet.body, `@import "${imported}"; .logo{background:url("${image}")} @font-face{src:url("${font}")}`)
  const nested = await call(imported, { headers: { 'x-dsh-guest-sub': '1' } })
  assert.equal(nested.body, `.icon{background:url("${guestPath('https://ordinary.example/images/icon.png')}")}`)
  for (const [path, destination] of [[image, 'image'], [font, 'font']]) {
    const result = await call(path, { headers: { 'sec-fetch-dest': destination, cookie: 'DSH_SESSION=private' } })
    assert.equal(result.status, 200)
    assert.equal(result.body, 'resource-bytes')
    assert.equal(result.headers['access-control-allow-origin'], 'null')
    assert.doesNotMatch(forwarded.at(-1).options.headers.get('cookie') ?? '', /DSH_SESSION/)
  }
})

test('guest CSP permits proxied and data image/font resources without admitting app APIs', async () => {
  const { headers } = await call(guestPath('https://ordinary.example/doc'))
  const csp = Object.fromEntries(headers['content-security-policy'].split(';').filter(value => value.trim()).map(value => {
    const [directive, ...sources] = value.trim().split(/\s+/u)
    return [directive, sources]
  }))
  assert.deepEqual(csp.sandbox, ['allow-scripts', 'allow-forms'])
  for (const directive of ['img-src', 'font-src']) {
    assert.ok(csp[directive].includes('data:'))
    assert.ok(csp[directive].every(value => value === 'data:' || value === 'blob:' || value.endsWith('/dsh-builtin-browser/browser-view/isolated-guest')))
  }
  assert.deepEqual(csp['base-uri'], ["'none'"])
  assert.deepEqual(csp['worker-src'], ["'none'"])
  assert.ok(!csp.sandbox.includes('allow-same-origin'))
})

test('one authoritative guest policy permits data fonts for documents, subrequests, large HTML and stylesheets', async () => {
  for (const [path, headers] of [
    ['/csp-doc', {}], ['/csp-doc', { 'x-dsh-guest-sub': '1' }], ['/large-csp-doc', {}],
    ['/styles/site.css', { 'x-dsh-guest-sub': '1' }],
  ]) {
    const result = await call(guestPath('https://ordinary.example' + path), { headers })
    assert.equal(result.status, 200)
    assert.match(result.headers['content-security-policy'], /(?:^|;)\s*font-src [^;]*\bdata:/u)
    assert.match(result.headers['content-security-policy'], /sandbox allow-scripts allow-forms;/u)
    assert.doesNotMatch(result.headers['content-security-policy'], /font-src 'none'/u)
    assert.equal(result.headers['content-security-policy-report-only'], undefined)
    if (path.endsWith('doc')) {
      assert.doesNotMatch(result.body, /<meta\b/iu)
      assert.match(result.body, /url\(data:application\/font-woff;charset=utf-8;base64,d09GRgABAAAAAA==\)/u)
    }
  }
})

test('removes upstream meta policies regardless of attribute order, case, quoting and character references', () => {
  const base = new URL('https://ordinary.example/')
  for (const tag of [
    '<meta http-equiv="Content-Security-Policy" content="font-src data:">',
    "<META content='default-src &#39;self&#39;' HTTP-EQUIV='content-security-policy'>",
    '<meta http-equiv=content-security-policy content="font-src https:">',
    '<meta http-equiv="Content-Security&#45;Policy" content="font-src &gt;">',
    '<meta http-equiv="Content-Security-Policy-Report-Only" content="font-src https:">',
  ]) assert.equal(rewriteDocument('<head>' + tag + '</head>', base), '<head></head>')
  for (const html of ['', '<meta charset="utf-8">', '<meta http-equiv="refresh" content="30">',
    '<!-- <meta http-equiv="Content-Security-Policy" content="font-src https:"> -->',
    '<script>const sample = `<meta http-equiv="Content-Security-Policy" content="font-src https:">`</script>',
    '<meta content="unterminated',
  ]) assert.equal(rewriteDocument(html, base), html)
})

test('forwards empty PUT bodies and preserves bodyless HEAD responses', async () => {
  const result = await call(guestPath('https://ordinary.example/echo'), { method: 'PUT' })
  assert.equal(JSON.parse(result.body).method, 'PUT')
  assert.equal(JSON.parse(result.body).body, '')
  const head = await call(guestPath('https://ordinary.example/doc'), { method: 'HEAD' })
  assert.equal(head.status, 200)
  assert.equal(head.body, '')
})

test('document runtime precedes site scripts, assets are rewritten, and overlay stays at body end', async () => {
  const result = await call(guestPath('https://ordinary.example/doc'), { headers: { 'sec-fetch-dest': 'iframe' } })
  assert.equal(result.status, 200)
  assert.ok(result.body.indexOf('data-dsh-guest-runtime') < result.body.indexOf('original()'))
  assert.ok(result.body.includes(guestPath('https://ordinary.example/pic.png')))
  assert.ok(result.body.indexOf('overlay()') < result.body.indexOf('</body>'))
  assert.equal(result.body.includes('<base'), false)
})

test('rejects loopback, private, DSH-host, non-http targets and unsafe redirects without contacting them', async () => {
  for (const target of ['http://127.1/', 'http://localhost./', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/',
    'http://169.254.169.254/', 'http://192.168.1.1/', 'https://dsh.example/secret', 'file:///etc/passwd']) {
    const before = forwarded.length
    const result = await call(guestPath(target))
    assert.ok([400, 403].includes(result.status), target)
    assert.equal(forwarded.length, before)
  }
  const result = await call(guestPath('https://ordinary.example/bad-redirect'))
  assert.equal(result.status, 403)
})

test('reports transport errors as 502', async () => {
  const result = await call(guestPath('https://offline.example/'))
  assert.equal(result.status, 502)
  assert.match(result.body, /cannot reach offline.example/)
})

test('static rewriting keeps supported asset forms and special URLs intact', () => {
  const base = new URL('https://ordinary.example/dir/page')
  for (const html of ['<script src="/a.js"></script>', "<script src='/a.js'></script>", '<script src=/a.js></script>']) {
    assert.ok(rewriteDocument(html, base).includes(guestPath('https://ordinary.example/a.js')))
  }
  const html = '<a href="#top">t</a><img src="data:image/gif;base64,AA">'
  assert.equal(rewriteDocument(html, base), html)
})

test('HTML rewriting does not reinterpret raw text, comments or attribute values as markup', () => {
  const base = new URL('https://ordinary.example/dir/page')
  for (const kind of ['script', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes']) {
    const text = 'href = $(this).children("a").attr("href"); <img src="/literal.png">'
    const html = `<${kind} src="/actual.js">${text}</${kind}><img src="/actual.png">`
    assert.equal(rewriteDocument(html, base),
      `<${kind} src="${guestPath('https://ordinary.example/actual.js')}">${text}</${kind}><img src="${guestPath('https://ordinary.example/actual.png')}">`)
  }
  for (const html of ['', '<!-- <img src="/literal.png"> -->', '<button onclick="href = \'/literal\'">', '<script>href = "/literal";']) {
    assert.equal(rewriteDocument(html, base), html)
  }
  const html = '<style>.x:after{content:\'src="/literal"\'} .x{background:url(/actual.png)}</style>'
  assert.equal(rewriteDocument(html, base), html.replace('url(/actual.png)', `url("${guestPath('https://ordinary.example/actual.png')}")`))
})

test('rewritten documents cannot cache an obsolete injected runtime or revalidate into a bare 304', async () => {
  const result = await call(guestPath('https://ordinary.example/doc'), { headers: {
    'if-none-match': 'old-runtime', 'if-modified-since': 'Mon, 01 Jan 2024 00:00:00 GMT',
  } })
  assert.equal(result.status, 200)
  assert.equal(result.headers['cache-control'], 'no-store')
  assert.equal(result.headers['last-modified'], undefined)
  assert.equal(forwarded.at(-1).options.headers.get('if-none-match'), null)
  assert.equal(forwarded.at(-1).options.headers.get('if-modified-since'), null)
  assert.match(result.body, /documentId/)
})

test('Bing paging decodes HTML ampersands before encoding the proxy target', () => {
  const html = '<a href="/search?q=deepseek&amp;first=10&amp;FORM=PORE">Next</a>'
  assert.equal(rewriteDocument(html, new URL('https://cn.bing.com/search?q=deepseek')),
    `<a href="${guestPath('https://cn.bing.com/search?q=deepseek&first=10&FORM=PORE')}">Next</a>`)
})

test('URL attributes decode named and numeric references once and escape each quote style', () => {
  const base = new URL('https://ordinary.example/dir/page')
  for (const attribute of ['href', 'src', 'poster', 'data-src', 'action']) {
    for (const quote of ['"', "'", '']) {
      const raw = '/path?x=1&amp;y=2&#38;z=3&#x26;v=&quot;q&quot;&#39;a&#39;&lt;b&gt;&#9731;&#x1F600;'
      const path = guestPath(new URL('/path?x=1&y=2&z=3&v="q"\'a\'<b>☃😀', base).href)
      const outputQuote = quote || '"'
      const escaped = outputQuote === '"' ? path : path.replaceAll("'", '&#39;')
      assert.equal(rewriteDocument(`<a ${attribute}=${quote}${raw}${quote}>`, base), `<a ${attribute}=${outputQuote}${escaped}${outputQuote}>`)
    }
  }
  assert.equal(rewriteDocument('<a href="/?q=&amp;amp;">', base), `<a href="${guestPath('https://ordinary.example/?q=&amp;')}">`)
  for (const value of ['', '#top', 'data:text/plain,&quot;hi&quot;', 'http://[']) {
    const html = `<a href="${value}">`
    assert.equal(rewriteDocument(html, base), html)
  }
  assert.ok(rewriteDocument('<img src="/&#0;&#xD800;&#1114112;">', base).includes(guestPath('https://ordinary.example/%EF%BF%BD%EF%BF%BD%EF%BF%BD')))
})

test('srcset candidates decode entities before resolving and safely retain literal special URLs', () => {
  const base = new URL('https://ordinary.example/dir/page')
  for (const quote of ['"', "'"]) {
    const html = `<img srcset=${quote}/image?a=1&amp;b=2 1x, /&#x69;mage?size=2&#38;v=3 2x${quote}>`
    const expected = `${guestPath('https://ordinary.example/image?a=1&b=2')} 1x, ${guestPath('https://ordinary.example/image?size=2&v=3')} 2x`
    assert.equal(rewriteDocument(html, base), `<img srcset=${quote}${expected}${quote}>`)
  }
  assert.equal(rewriteDocument('<img srcset=/image?a=1&amp;b=2>', base), `<img srcset="${guestPath('https://ordinary.example/image?a=1&b=2')}">`)
  assert.equal(rewriteDocument('<img srcset="about:&quot;blank&quot;">', base), '<img srcset="about:&#34;blank&#34;">')
})
