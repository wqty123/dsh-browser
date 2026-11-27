import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request } from 'node:http'
import { once } from 'node:events'
import { promises as dns } from 'node:dns'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GuestCookieJar } from '../src/browser-electron/guest-cookie-jar.ts'
import { loadGuestCookies } from '../src/browser-electron/guest-cookie-store.ts'
import { guestPath, handleGuest } from '../src/browser-electron/guest-route.ts'
import { chromiumPage } from './fixtures/chromium-page.mjs'

const target = 'https://practice.expandtesting.com/login'
const browserHeaders = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9', 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'same-origin', 'upgrade-insecure-requests': '1',
}

async function fixture(t, upstream, cookieJar = new GuestCookieJar()) {
  const originalFetch = globalThis.fetch, originalLookup = dns.lookup, errors = []
  globalThis.fetch = upstream
  dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }]
  let jar = cookieJar, bodyReads = 0
  const server = createServer((req, res) => {
    req.iterator = () => { bodyReads++; throw new Error('GET request body must not be consumed') }
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(`<iframe id="guest" style="width:100%;height:550px;border:0" sandbox="allow-scripts allow-forms" src="${guestPath(target)}"></iframe>
        <script>const frame=document.getElementById('guest');window.reports=[];
        addEventListener('message',event=>{if(event.source===frame.contentWindow&&event.origin==='null')reports.push(event.data)});
        frame.onload=()=>frame.contentWindow.postMessage({type:'dsh.browser.guest.navigation.request',loadId:71},'*');</script>`)
      return
    }
    void handleGuest(req, res, '', '', jar).catch(error => { errors.push(error); res.destroy(error) })
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(async () => {
    globalThis.fetch = originalFetch; dns.lookup = originalLookup
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  })
  return {
    errors, origin: `http://127.0.0.1:${server.address().port}`, bodyReads: () => bodyReads,
    setJar(value) { jar = value },
    call() {
      return new Promise((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port: server.address().port, path: guestPath(target),
          headers: { ...browserHeaders, cookie: 'DSH_AUTH=app-secret', authorization: 'Bearer app-secret',
            'if-none-match': 'app-cache-tag', 'if-modified-since': 'Wed, 21 Oct 2015 07:28:00 GMT',
            'x-dsh-guest-headers': 'cookie,authorization,x-app-secret', 'x-app-secret': 'app-secret' },
        }, async res => {
          try {
            let body = ''; for await (const chunk of res) body += chunk
            resolve({ status: res.statusCode, headers: res.headers, body, complete: res.complete })
          } catch (error) { reject(error) }
        })
        req.on('error', reject); req.end()
      })
    },
  }
}

for (const legacy of [false, true]) test(`browser-like login GET preserves the upstream request shape with a ${legacy ? 'legacy' : 'fresh'} persisted jar`, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-login-shape-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  if (legacy) await writeFile(join(directory, 'cookies.json'), JSON.stringify({ version: 1, cookies: [{
    origin: 'https://practice.expandtesting.com', name: 'express:sess', value: 'legacy-session', path: '/', secure: true, httpOnly: true,
  }] }))
  const forwarded = []
  const app = await fixture(t, async (url, options) => {
    forwarded.push({ url: String(url), ...options, headers: new Headers(options.headers) })
    const root = new URL(url).pathname === '/'
    const html = root ? '<html><body>Home</body></html>' : '<html><head><title>Test Login Page</title></head><body><form method="post" action="/authenticate"><input id="username"></form></body></html>'
    return new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8',
      'content-length': String(Buffer.byteLength(html)), 'set-cookie': 'express:sess=server-session; Path=/; HttpOnly; Secure; SameSite=Lax',
      'alt-svc': 'h3=":443"; ma=86400', upgrade: 'h2c',
    } })
  }, loadGuestCookies(directory))
  for (let restart = 0; restart < 2; restart++) {
    const result = await app.call()
    assert.equal(result.status, 200); assert.equal(result.complete, true)
    assert.match(result.body, /<input id="username">/u)
    assert.match(result.body, /data-dsh-guest-runtime/u)
    assert.equal(result.headers['alt-svc'], undefined); assert.equal(result.headers.upgrade, undefined)
    app.setJar(loadGuestCookies(directory))
  }
  assert.equal(forwarded.length, legacy ? 2 : 3)
  assert.equal(app.bodyReads(), 0)
  assert.deepEqual(app.errors, [])
  for (const call of forwarded) {
    assert.equal(call.method, 'GET'); assert.equal(call.body, undefined); assert.equal(call.redirect, 'manual')
    assert.equal(call.headers.get('accept'), browserHeaders.accept)
    assert.equal(call.headers.get('accept-encoding'), 'identity')
    assert.equal(call.headers.get('accept-language'), browserHeaders['accept-language'])
    assert.equal(call.headers.get('sec-fetch-mode'), 'navigate')
    assert.equal(call.headers.get('sec-fetch-dest'), 'document')
    assert.equal(call.headers.get('origin'), 'https://practice.expandtesting.com')
    for (const name of ['authorization', 'if-none-match', 'if-modified-since', 'x-app-secret', 'x-dsh-guest-headers']) assert.equal(call.headers.get(name), null)
    assert.doesNotMatch(call.headers.get('cookie') ?? '', /DSH_AUTH|app-secret/u)
  }
  const logins = forwarded.filter(call => call.url === target)
  assert.equal(logins[0].headers.get('cookie'), legacy ? 'express:sess=legacy-session' : 'express:sess=server-session')
  assert.equal(logins[1].headers.get('cookie'), 'express:sess=server-session')
})

for (const mode of ['connect', 'probe', 'body', 'unknown']) test(`top-level ${mode} failures return a complete identity-bearing error document without sensitive details`, async t => {
  const app = await fixture(t, async () => {
    const error = new TypeError('secret-token; sensitive upstream endpoint', { cause: { code: mode === 'unknown' ? 'SECRET_TOKEN' : 'ECONNRESET' } })
    if (mode === 'connect' || mode === 'unknown') throw error
    return new Response(new ReadableStream({ start(controller) { controller.error(error) } }), {
      headers: { 'content-type': 'text/html', ...mode === 'body' ? { 'content-length': String(5 * 1024 * 1024) } : {} },
    })
  })
  const result = await app.call()
  assert.equal(result.status, 502); assert.equal(result.complete, true)
  assert.equal(result.headers['content-type'], 'text/html; charset=utf-8')
  assert.equal(result.headers['cache-control'], 'no-store')
  assert.match(result.headers['content-security-policy'], /^sandbox allow-scripts allow-forms allow-downloads [^;]*;/u)
  assert.match(result.body, /Page unavailable/u); assert.match(result.body, /data-dsh-guest-runtime/u)
  assert.match(result.body, /dsh\.browser\.guest\.navigation/u)
  assert.match(result.body, mode === 'body' ? /upstream response failed/u : /upstream request failed/u)
  if (mode !== 'unknown') assert.match(result.body, /ECONNRESET/u)
  assert.doesNotMatch(result.body, /secret-token|sensitive upstream endpoint|SECRET_TOKEN|DSH_AUTH|app-secret/u)
  assert.equal(app.bodyReads(), 0); assert.deepEqual(app.errors, [])
})

test('Chromium accepts the failed opaque document identity and renders the error instead of an identity timeout', {
  skip: !process.env.DSH_TEST_CHROME, timeout: 30000,
}, async t => {
  const app = await fixture(t, async () => { throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } }) })
  const page = await chromiumPage(t)
  await page.navigate(app.origin + '/')
  const report = await page.evaluate(`new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>{clearInterval(poll);reject(new Error('matching document identity unavailable'))},5000);
    const poll=setInterval(()=>{const item=reports.find(item=>item.type==='dsh.browser.guest.navigation'&&item.loadId===71&&item.ready===true&&typeof item.documentId==='string'&&item.documentId.length>0);
    if(item){clearInterval(poll);clearTimeout(timer);resolve(item)}},10);
  })`)
  assert.equal(report.url, target); assert.equal(report.loadId, 71)
  const { targetInfos } = await page.command('Target.getTargets')
  const guest = targetInfos.find(info => info.type === 'iframe' && info.url.startsWith(app.origin + guestPath(target)))
  const session = guest === undefined ? undefined : await page.command('Target.attachToTarget', { targetId: guest.targetId, flatten: true })
  const { strings } = await page.command('DOMSnapshot.captureSnapshot', { computedStyles: [] }, session?.sessionId)
  assert.ok(strings.some(text => text.includes('Page unavailable')))
  assert.ok(strings.some(text => text.includes('upstream request failed (ECONNREFUSED)')))
  assert.deepEqual(app.errors, [])
  if (process.env.DSH_TEST_GUEST_ERROR_SCREENSHOT) {
    const { data } = await page.command('Page.captureScreenshot', { format: 'png' })
    await writeFile(process.env.DSH_TEST_GUEST_ERROR_SCREENSHOT, Buffer.from(data, 'base64'))
  }
  console.log('Chromium failed document: matching loadId/documentId + ready; readable error; no identity timeout')
})
