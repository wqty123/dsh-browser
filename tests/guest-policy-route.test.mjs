import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import { promises as dns } from 'node:dns'
import { registerWebGuest } from '../src/web-guest.ts'
import { guestPath } from '../src/browser-electron/guest-route.ts'
import { RELAXED_BROWSER_SANDBOX, WEB_BROWSER_SANDBOX } from '../assets/browser-policy.mjs'

test('registered guest route commits the same data-font policy on HTML navigations and every response branch', async t => {
  const originalFetch = globalThis.fetch
  const originalLookup = dns.lookup
  const routes = []
  registerWebGuest({ inject(names, install) {
    assert.deepEqual(names, ['webServer'])
    install({ effect: callback => callback(), webServer: { register(route) { routes.push(route); return () => {} } } })
  } })
  assert.equal(routes.length, 1)
  const route = routes[0]
  assert.equal(route.kind, 'exact')
  assert.equal(route.auth, 'anonymous')
  dns.lookup = async hostname => [{ address: hostname === 'dsh.example' ? '93.184.216.35' : '93.184.216.34', family: 4 }]
  const font = 'data:application/font-woff;charset=utf-8;base64,d09GRgABAAAAAA=='
  const html = `<html><head><meta http-equiv="Content-Security-Policy" content="font-src 'none'"><style>@font-face{font-family:embedded;src:url(${font})}</style></head><body>font</body></html>`
  globalThis.fetch = async (target, options) => {
    assert.equal(new URL(target).hostname, 'ordinary.example')
    const path = new URL(target).pathname
    if (path === '/failed') throw new Error('fixture transport failure')
    if (path === '/redirect') return new Response(null, { status: 302, headers: { location: '/document' } })
    if (path === '/empty') return new Response(null, { status: 204 })
    const type = path === '/style.css' ? 'text/css' : path === '/script.js' ? 'application/javascript'
      : path === '/image.gif' ? 'image/gif' : 'text/html; charset=UTF-8'
    const headers = { 'content-type': type, 'content-security-policy': "default-src 'none'; font-src 'none'",
      'content-security-policy-report-only': "font-src 'none'" }
    if (path === '/large') headers['content-length'] = String(5 * 1024 * 1024)
    return new Response(options.method === 'HEAD' ? null : type.startsWith('text/html') ? html : 'resource', { headers })
  }
  const server = createServer((req, res) => {
    assert.equal(new URL(req.url, 'http://dsh.example').pathname, route.path)
    Promise.resolve(route.handler(req, res)).catch(error => res.destroy(error))
  })
  t.after(async () => {
    globalThis.fetch = originalFetch
    dns.lookup = originalLookup
    await new Promise(resolve => server.close(resolve))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const call = (path, { method = 'GET', headers = {} } = {}) => new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port: server.address().port, path, method,
      headers: { host: 'dsh.example:3180', ...headers } }, async res => {
      const chunks = []
      for await (const chunk of res) chunks.push(chunk)
      resolve({ status: res.statusCode, headers: res.headers, rawHeaders: res.rawHeaders, body: Buffer.concat(chunks).toString() })
    })
    req.on('error', reject)
    req.end()
  })
  const navigation = { headers: { accept: 'text/html,application/xhtml+xml', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' } }
  const document = await call(guestPath('https://ordinary.example/document'), navigation)
  assert.equal(document.status, 200)
  assert.match(document.headers['content-type'], /^text\/html; charset=UTF-8$/u)
  assert.ok(document.body.includes(font))
  assert.ok(document.body.includes('data-dsh-guest-runtime'))
  assert.doesNotMatch(document.body, /<meta\b/iu)
  const policy = document.headers['content-security-policy']
  assert.match(policy, /(?:^|;)\s*font-src [^;]*\bdata:/u)
  assert.match(policy, /^sandbox allow-scripts allow-forms allow-same-origin allow-downloads [^;]*;/u)
  const sandbox = policy.split(';')[0].split(' ').slice(1)
  assert.deepEqual(sandbox, RELAXED_BROWSER_SANDBOX.split(' '))
  // allow-same-origin is granted on purpose (a page's own storage must work); the popup and
  // navigation grants are the ones that must stay off.
  for (const token of ['allow-popups', 'allow-popups-to-escape-sandbox', 'allow-top-navigation'])
    assert.ok(!sandbox.includes(token), token)
  const unframed = policy.replace(RELAXED_BROWSER_SANDBOX, WEB_BROWSER_SANDBOX)
  for (const destination of ['document', undefined]) {
    const headers = { accept: 'text/html', 'sec-fetch-mode': 'navigate', ...destination === undefined ? {} : { 'sec-fetch-dest': destination } }
    const direct = await call(guestPath('https://ordinary.example/document'), { headers })
    assert.equal(direct.headers['content-security-policy'], unframed, String(destination))
  }
  for (const [path, options, status] of [
    ['/document', { method: 'POST', ...navigation }, 200],
    ['/document', { method: 'HEAD', ...navigation }, 200],
    ['/document', { headers: { 'x-dsh-guest-sub': '1' } }, 200],
    ['/style.css', { headers: { 'x-dsh-guest-sub': '1' } }, 200],
    ['/script.js', { headers: { 'x-dsh-guest-sub': '1' } }, 200],
    ['/image.gif', { headers: { 'x-dsh-guest-sub': '1' } }, 200],
    ['/large', navigation, 200], ['/redirect', navigation, 302], ['/empty', navigation, 204],
    ['/failed', navigation, 502], ['/document', { method: 'OPTIONS' }, 204],
  ]) {
    const result = await call(guestPath('https://ordinary.example' + path), options)
    assert.equal(result.status, status, path)
    assert.equal(result.headers['content-security-policy'], options.headers?.['sec-fetch-dest'] === 'iframe' ? policy : unframed, path)
    assert.equal(result.headers['content-security-policy-report-only'], undefined, path)
    assert.equal(result.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'content-security-policy').length, 1, path)
  }
  for (const [path, status] of [[route.path, 400], [guestPath('http://127.0.0.1/private'), 403]]) {
    const result = await call(path, navigation)
    assert.equal(result.status, status)
    assert.equal(result.headers['content-security-policy'], policy)
  }
})
