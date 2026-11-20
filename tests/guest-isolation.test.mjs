import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { promises as dns } from 'node:dns'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerWebGuest } from '../src/web-guest.ts'
import { GUEST_ROUTE, guestPath, handleGuest } from '../src/browser-electron/guest-route.ts'

test('the root registers only the isolated endpoint, never the old DSH-origin guest route', () => {
  const routes = []
  registerWebGuest({ inject(names, install) {
    assert.deepEqual(names, ['webServer'])
    install({ effect: callback => callback(), webServer: { register: route => { routes.push(route); return () => {} } } })
  } })
  assert.deepEqual(routes.map(route => route.path), ['/dsh-builtin-browser/browser-view/isolated-guest'])
  assert.notEqual(GUEST_ROUTE, '/dsh-builtin-browser/browser-view/guest')
})

test('Chromium enforces opaque storage, API isolation, site networking and reference relay', {
  skip: !process.env.DSH_TEST_CHROME && 'set DSH_TEST_CHROME to a Chromium executable',
}, async t => {
  const originalFetch = globalThis.fetch
  const originalLookup = dns.lookup
  const profile = mkdtempSync(join(tmpdir(), 'dsh-guest-isolation-'))
  let origin, apiCalls = 0
  const upstreamCookies = []
  dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }]
  globalThis.fetch = async (target, options) => {
    assert.equal(new URL(target).hostname, 'ordinary.example')
    upstreamCookies.push(new Headers(options.headers).get('cookie'))
    if (new URL(target).pathname === '/site-api') return new Response('{"site":true}', { headers: { 'content-type': 'application/json' } })
    return new Response(`<html><head></head><body><p>Quoted <strong>content</strong></p><script>
      (async () => {
        const result = {};
        try { localStorage.getItem('DSH_TOKEN'); result.storage = false; } catch { result.storage = true; }
        try { parent.localStorage.getItem('DSH_TOKEN'); result.parent = false; } catch { result.parent = true; }
        try { result.cookie = !document.cookie.includes('DSH_TOKEN'); } catch { result.cookie = true; }
        try { await window.__dshGuestFetch(${JSON.stringify(origin + '/api/private')}, { credentials: 'include' }); result.api = false; } catch { result.api = true; }
        result.site = (await (await fetch('/site-api')).json()).site;
        parent.postMessage({ type: 'security-report', result }, '*');
        window.postMessage({ type: 'dsh-browser-ref:intent', comment: 'quote', capture: { ok: true } }, '*');
      })();
    </script></body></html>`, { headers: { 'content-type': 'text/html' } })
  }
  const server = createServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html')
      res.end(`<html><body><pre id="result">waiting</pre><script>
        localStorage.setItem('DSH_TOKEN', 'private-app-token'); document.cookie = 'DSH_TOKEN=private-app-cookie';
        let report, intent;
        addEventListener('message', event => {
          if (event.source !== frame.contentWindow || event.origin !== 'null') return;
          if (event.data.type === 'security-report') report = event.data.result;
          if (event.data.type === 'dsh-browser-ref:intent') intent = event.data.comment === 'quote';
          if (report && intent) document.getElementById('result').textContent = JSON.stringify({ ...report, intent });
        });
        const frame = document.createElement('iframe'); frame.src = ${JSON.stringify(guestPath('https://ordinary.example/document'))}; document.body.append(frame);
      </script></body></html>`)
    } else if (req.url === '/api/private') { apiCalls++; res.end('private-app-token') }
    else if (new URL(req.url, 'http://fixture').pathname === GUEST_ROUTE) void handleGuest(req, res, '', '').catch(error => res.destroy(error))
    else { res.writeHead(404); res.end('not found') }
  }).listen(0, '127.0.0.1')
  t.after(async () => {
    globalThis.fetch = originalFetch
    dns.lookup = originalLookup
    await new Promise(resolve => server.close(resolve))
    rmSync(profile, { recursive: true, force: true })
  })
  await once(server, 'listening')
  origin = `http://127.0.0.1:${server.address().port}`
  const { stdout } = await promisify(execFile)(process.env.DSH_TEST_CHROME, [
    '--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`,
    '--virtual-time-budget=5000', '--dump-dom', origin,
  ], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 })
  const json = stdout.match(/<pre id="result">([^<]+)<\/pre>/)?.[1]
  assert.deepEqual(JSON.parse(json), { storage: true, parent: true, cookie: true, api: true, site: true, intent: true })
  assert.equal(apiCalls, 0, 'CSP blocks the request, not merely reading its response')
  assert.ok(upstreamCookies.every(cookie => cookie === null), 'app cookies never leave the proxy')
})
