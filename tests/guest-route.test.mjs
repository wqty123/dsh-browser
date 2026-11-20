import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { promises as dns } from 'node:dns'
import { handleGuest, guestPath, rewriteDocument } from '../src/browser-electron/guest-route.ts'

const nativeFetch = globalThis.fetch
const nativeLookup = dns.lookup
const resolved = new Map()
let upstream, proxy, upstreamOrigin, proxyPort
const forwarded = []

before(async () => {
  dns.lookup = async (hostname, options) => {
    assert.equal(options.all, true)
    if (hostname === 'missing.example') throw new Error('getaddrinfo ENOTFOUND')
    return (resolved.get(hostname) ?? [hostname === 'dsh.example' ? '93.184.216.35' : '93.184.216.34'])
      .map(address => ({ address, family: address.includes(':') ? 6 : 4 }))
  }
  upstream = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (req.url === '/login') {
      res.writeHead(303, { location: '/account', 'set-cookie': ['SID=logged-in; HttpOnly; Path=/', 'theme=dark; Path=/'] })
      res.end()
    } else if (req.url === '/' && req.headers['x-fixture-host'] !== 'empty.example') {
      res.writeHead(200, { 'set-cookie': 'VISITED=root; Path=/' })
      res.end('root')
    } else if (req.url === '/challenge') {
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
    forwarded.push({ target: String(target), options: { ...options, headers: new Headers(options.headers) } })
    const url = new URL(target)
    if (!['ordinary.example', 'warm-get.example', 'warm-head.example', 'challenge.example', 'empty.example'].includes(url.hostname)) throw new Error('unexpected upstream')
    const headers = new Headers(options.headers)
    headers.set('x-fixture-host', url.hostname)
    return nativeFetch(upstreamOrigin + url.pathname + url.search, { ...options, headers })
  }
  proxy = createServer((req, res) => {
    void handleGuest(req, res, '<script>overlay()</script>', 'owner').catch(error => res.destroy(error))
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

test('stores redirect cookies and rewrites redirect location for a login round-trip', async () => {
  const login = await call(guestPath('https://ordinary.example/login'), { method: 'POST', body: 'login=1' })
  assert.equal(login.status, 303)
  assert.equal(login.headers.location, guestPath('https://ordinary.example/account') + '&s=owner')
  assert.equal(login.headers['set-cookie'], undefined)
  const account = await call(login.headers.location)
  assert.equal(JSON.parse(account.body).headers.cookie, 'SID=logged-in; theme=dark')
  assert.equal(forwarded.at(-1).options.redirect, 'manual')
})

test('replays only allowlisted inbound site cookies alongside the existing jar', async () => {
  const result = await call(guestPath('https://ordinary.example/echo'), {
    headers: { cookie: 'DSH=private; BAIDUID=baidu; SUB=weibo; XSRF=site-token; session=private' },
  })
  assert.equal(JSON.parse(result.body).headers.cookie, 'SID=logged-in; theme=dark; BAIDUID=baidu; SUB=weibo; XSRF=site-token')
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
  assert.equal(requests[2].options.headers.get('cookie'), 'CHALLENGE=seen; VISITED=root; SUB=weibo')
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
  const html = '<a href="#top">t</a><img src="data:image/gif;base64,AA">'
  assert.equal(rewriteDocument(html, base), html)
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
