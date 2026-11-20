import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Agent, createServer, request } from 'node:http'
import { once } from 'node:events'
import { promises as dns } from 'node:dns'
import { GuestCookieJar } from '../src/browser-electron/guest-cookie-jar.ts'
import { guestPath, handleGuest } from '../src/browser-electron/guest-route.ts'

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
