import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Agent, createServer, request } from 'node:http'
import { once } from 'node:events'
import { connect } from 'node:net'
import { promises as dns } from 'node:dns'
import { GuestCookieJar } from '../src/browser-electron/guest-cookie-jar.ts'
import { guestPath, handleGuest } from '../src/browser-electron/guest-route.ts'

test('opaque-origin bidder POST and OPTIONS have valid HTTP/1 framing without upstream h2/h3 hints or HTTPS redirects', async t => {
  const originalFetch = globalThis.fetch, originalLookup = dns.lookup
  dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }]
  const upstream = createServer(async (req, res) => {
    for await (const _ of req) {}
    if (req.url === '/failure') { res.destroy(); return }
    res.writeHead(req.url === '/redirect' ? 307 : 200, {
      'content-type': 'application/json', 'content-length': '2', 'alt-svc': 'h3=":443"; ma=86400',
      'alternate-protocol': '443:quic', upgrade: 'h2c', 'http2-settings': 'upstream-only',
      'access-control-allow-origin': 'https://show.websudoku.com',
      ...req.url === '/redirect' ? { location: 'https://bidder.example/next' } : {},
    })
    res.end('{}')
  }).listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  globalThis.fetch = (target, options) => originalFetch(`http://127.0.0.1:${upstream.address().port}${new URL(target).pathname}`, options)
  const errors = []
  const proxy = createServer((req, res) => {
    void handleGuest(req, res, '', '', new GuestCookieJar()).catch(error => { errors.push(error); res.destroy(error) })
  }).listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  t.after(async () => {
    globalThis.fetch = originalFetch; dns.lookup = originalLookup
    await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => upstream.close(resolve))])
  })
  const raw = (method, path) => new Promise((resolve, reject) => {
    const socket = connect(proxy.address().port, '127.0.0.1')
    let bytes = ''
    socket.on('data', chunk => { bytes += chunk.toString('latin1') })
    socket.on('error', reject)
    socket.on('end', () => { resolve(bytes) })
    socket.on('connect', () => { socket.write(`${method} ${guestPath('https://bidder.example' + path)} HTTP/1.1\r\nHost: 127.0.0.1:${proxy.address().port}\r\nOrigin: null\r\nConnection: close\r\nContent-Type: application/json\r\nX-DSH-Guest-Sub: 1\r\nAccess-Control-Request-Method: POST\r\nAccess-Control-Request-Headers: content-type,x-dsh-guest-sub\r\nContent-Length: ${method === 'POST' ? 2 : 0}\r\n\r\n${method === 'POST' ? '{}' : ''}`) })
  })
  await new Promise((resolve, reject) => {
    const client = request({ hostname: '127.0.0.1', port: proxy.address().port,
      path: guestPath('https://bidder.example/bid'), method: 'POST',
      headers: { origin: 'null', 'x-dsh-guest-sub': '1', 'content-type': 'application/json' },
    }, async response => {
      try {
        const chunks = []
        for await (const chunk of response) chunks.push(chunk)
        assert.equal(response.statusCode, 200)
        assert.equal(response.complete, true)
        assert.equal(Buffer.concat(chunks).toString(), '{}')
        resolve()
      } catch (error) { reject(error) }
    })
    client.on('error', reject)
    client.end('{}')
  })
  for (const [method, path, status] of [['OPTIONS', '/bid', 204], ['POST', '/bid', 200], ['POST', '/redirect', 307], ['POST', '/failure', 502]]) {
    const bytes = await raw(method, path), split = bytes.indexOf('\r\n\r\n')
    const headers = bytes.slice(0, split), body = bytes.slice(split + 4)
    assert.match(headers, new RegExp(`^HTTP/1\\.1 ${status} `))
    assert.doesNotMatch(headers, /\r\n(?:alt-svc|alternate-protocol|upgrade|http2-settings|content-encoding):/iu)
    assert.equal(/\r\ncontent-length:/iu.test(headers) && /\r\ntransfer-encoding:/iu.test(headers), false)
    assert.match(headers, /\r\naccess-control-allow-origin: null\r\n/iu)
    if (method === 'OPTIONS') { assert.equal(body, ''); assert.doesNotMatch(headers, /\r\n(?:content-length|transfer-encoding):/iu) }
    else {
      const expected = status === 502 ? 'guest proxy: upstream request failed' : '{}'
      assert.equal(body, /\r\ntransfer-encoding: chunked/iu.test(headers) ? `${Buffer.byteLength(expected).toString(16)}\r\n${expected}\r\n0\r\n\r\n` : expected)
    }
    if (status === 307) {
      assert.match(headers, /\r\nlocation: \/dsh-builtin-browser\/browser-view\/isolated-guest\?u=https%3A%2F%2Fbidder.example%2Fnext/iu)
      assert.doesNotMatch(headers, /\r\nlocation: https:/iu)
    }
    console.log(`RAW bidder ${method} ${path}: ${JSON.stringify(bytes)}`)
  }
  assert.deepEqual(errors, [])
})

test('connect/TLS/ALPN and upstream body failures return complete non-sensitive 502 responses, never socket aborts', async t => {
  const originalFetch = globalThis.fetch, originalLookup = dns.lookup
  const jar = new GuestCookieJar(), unhandled = [], agent = new Agent({ keepAlive: true })
  dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }]
  globalThis.fetch = async target => {
    const path = new URL(target).pathname
    if (path === '/healthy') return new Response('healthy', { headers: {
      'content-type': 'application/json', 'alt-svc': 'h3=":443"; ma=86400', 'alternate-protocol': '443:quic',
      upgrade: 'h2c', 'http2-settings': 'upstream-only', trailer: 'upstream-only', te: 'trailers',
    } })
    const error = Object.assign(new TypeError('sensitive endpoint/token; TLS ALPN negotiation failed'), { code: 'ERR_SSL_TLSV1_ALERT_NO_APPLICATION_PROTOCOL' })
    if (['/connect', '/tls', '/alpn'].includes(path)) throw error
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('partial')); controller.error(error) } })
    return new Response(stream, { headers: { 'content-type': path.endsWith('.css') ? 'text/css' : path.endsWith('.html') ? 'text/html' : 'application/json' } })
  }
  const server = createServer((req, res) => {
    void handleGuest(req, res, '', '', jar).catch(error => { unhandled.push(error); res.destroy(error) })
  }).listen(0, '127.0.0.1')
  t.after(async () => { globalThis.fetch = originalFetch; dns.lookup = originalLookup; agent.destroy(); await new Promise(resolve => server.close(resolve)) })
  await once(server, 'listening')
  const call = (path, method = 'GET') => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path: guestPath('https://bidder.example' + path), method, agent,
      headers: { 'content-type': 'application/json', 'x-dsh-guest-sub': '1' } }, async res => {
      try { let body = ''; for await (const chunk of res) body += chunk; resolve({ status: res.statusCode, headers: res.headers, body, complete: res.complete }) } catch (error) { reject(error) }
    })
    req.on('error', reject); req.end(method === 'POST' ? '{"bid":1}' : undefined)
  })
  for (const [path, method] of [['/connect', 'POST'], ['/tls', 'GET'], ['/alpn', 'POST'], ['/body.json', 'POST'], ['/body.css', 'GET'], ['/body.html', 'POST']]) {
    const result = await call(path, method)
    assert.equal(result.status, 502, path); assert.equal(result.complete, true)
    assert.match(result.headers['content-type'], /^text\/plain; charset=utf-8$/u)
    assert.equal(result.headers['cache-control'], 'no-store')
    assert.match(result.headers['content-security-policy'], /^sandbox allow-scripts allow-forms;/u)
    assert.match(result.body, /^guest proxy: upstream (request|response) failed$/u)
    assert.doesNotMatch(result.body, /sensitive|token|TLS|ALPN/u)
    const healthy = await call('/healthy'); assert.equal(healthy.status, 200); assert.equal(healthy.body, 'healthy')
    for (const name of ['alt-svc', 'alternate-protocol', 'upgrade', 'http2-settings', 'trailer', 'te']) assert.equal(healthy.headers[name], undefined, name)
  }
  assert.deepEqual(unhandled, [])
})
