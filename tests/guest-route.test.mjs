import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { handleGuest, guestPath, rewriteDocument } from '../src/browser-electron/guest-route.ts'

const nativeFetch = globalThis.fetch
let upstream, proxy, upstreamOrigin, proxyPort
const forwarded = []

before(async () => {
  upstream = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (req.url === '/login') {
      res.writeHead(303, { location: '/account', 'set-cookie': ['SID=logged-in; HttpOnly; Path=/', 'theme=dark; Path=/'] })
      res.end()
    } else if (req.url === '/bad-redirect') {
      res.writeHead(307, { location: 'http://127.0.0.1/private' })
      res.end()
    } else if (req.url === '/fragment') {
      res.writeHead(201, { 'content-type': 'text/html', 'x-frame-options': 'DENY',
        'content-security-policy': "frame-ancestors 'none'" })
      res.end('<a href="/raw">fragment</a>')
    } else if (req.url === '/script') {
      res.writeHead(200, { 'content-type': 'application/javascript' })
      res.end('fetch("/api"); const src="/raw";')
    } else if (req.url === '/doc') {
      res.writeHead(200, { 'content-type': 'text/html', 'x-frame-options': 'DENY' })
      res.end('<html><head><script>original()</script></head><body><img src="pic.png"></body></html>')
    } else {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString() }))
    }
  }).listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  upstreamOrigin = `http://127.0.0.1:${upstream.address().port}`
  // Only the transport is redirected to the local fixture. Production guards still see public URLs.
  globalThis.fetch = (target, options) => {
    forwarded.push({ target: String(target), options })
    const url = new URL(target)
    if (url.hostname !== 'ordinary.example') throw new Error('unexpected upstream')
    return nativeFetch(upstreamOrigin + url.pathname + url.search, options)
  }
  proxy = createServer((req, res) => {
    void handleGuest(req, res, '<script>overlay()</script>', 'owner').catch(error => res.destroy(error))
  }).listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  proxyPort = proxy.address().port
})

after(async () => {
  globalThis.fetch = nativeFetch
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

test('forwards POST body, content type and safe headers without app cookies or internal headers', async () => {
  const result = await call(guestPath('https://ordinary.example/echo'), { method: 'POST', body: 'q=hello&pw=secret',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json',
      'x-requested-with': 'XMLHttpRequest', authorization: 'Bearer site-token',
      cookie: 'DSH=private; XSRF=app-private', 'x-dsh-private': 'private', 'x-dsh-guest-sub': '1' } })
  assert.equal(result.status, 200)
  const echo = JSON.parse(result.body)
  assert.equal(echo.method, 'POST')
  assert.equal(echo.body, 'q=hello&pw=secret')
  assert.equal(echo.headers['content-type'], 'application/x-www-form-urlencoded')
  assert.equal(echo.headers.accept, 'application/json')
  assert.equal(echo.headers['x-requested-with'], 'XMLHttpRequest')
  assert.equal(echo.headers.authorization, 'Bearer site-token')
  assert.equal(echo.headers.cookie, undefined)
  assert.equal(echo.headers['x-dsh-private'], undefined)
  assert.equal(echo.headers['x-dsh-guest-sub'], undefined)
})

test('stores redirect cookies and rewrites redirect location for a login round-trip', async () => {
  const login = await call(guestPath('https://ordinary.example/login'), { method: 'POST', body: 'login=1' })
  assert.equal(login.status, 303)
  assert.equal(login.headers.location, guestPath('https://ordinary.example/account') + '&s=owner')
  assert.equal(login.headers['set-cookie'], undefined)
  const account = await call(login.headers.location)
  assert.equal(JSON.parse(account.body).headers.cookie, 'SID=logged-in; theme=dark')
  assert.equal(forwarded.at(-1).options.redirect, 'manual')
})

test('HTML sub-requests stay raw by explicit marker or fetch destination; framing headers are stripped', async () => {
  for (const headers of [{ 'x-dsh-guest-sub': '1' }, { 'sec-fetch-dest': 'empty' }, { 'sec-fetch-dest': 'script' }]) {
    const result = await call(guestPath('https://ordinary.example/fragment'), { headers })
    assert.equal(result.status, 201)
    assert.equal(result.headers['content-type'], 'text/html')
    assert.equal(result.body, '<a href="/raw">fragment</a>')
    assert.equal(result.headers['x-frame-options'], undefined)
    assert.equal(result.headers['content-security-policy'], undefined)
  }
})

test('non-HTML bodies remain byte-for-byte unchanged', async () => {
  const result = await call(guestPath('https://ordinary.example/script'))
  assert.equal(result.body, 'fetch("/api"); const src="/raw";')
  assert.equal(result.headers['content-type'], 'application/javascript')
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
  const html = '<a href="#top">t</a><img src="data:image/gif;base64,AA"><form action="/search"></form>'
  assert.equal(rewriteDocument(html, base), html)
})
