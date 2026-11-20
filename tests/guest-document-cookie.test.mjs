import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { promises as dns } from 'node:dns'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import vm from 'node:vm'
import { GuestCookieJar } from '../src/browser-electron/guest-cookie-jar.ts'
import { loadGuestCookies } from '../src/browser-electron/guest-cookie-store.ts'
import { GuestStorage } from '../src/browser-electron/guest-storage.ts'
import { guestStorageScript } from '../src/browser-electron/guest-storage-runtime.ts'
import { guestPath, handleGuest } from '../src/browser-electron/guest-route.ts'
import { chromiumPage } from './fixtures/chromium-page.mjs'

test('document cookie grammar enforces HttpOnly, expiry, prefixes, path, domains and SameSite', t => {
  const jar = new GuestCookieJar(), url = new URL('https://login.example.com/dir/page')
  jar.setCookies(url, ['secret=private; HttpOnly; Path=/', 'server=visible; Path=/'])
  assert.equal(jar.getDocumentCookie(url), 'server=visible')
  for (const value of ['secret=replace; Path=/', 'secret=delete; Path=/; Max-Age=0', 'script=private; HttpOnly',
    'foreign=no; Domain=elsewhere.com', 'suffix=no; Domain=com', 'private=no; Domain=github.io',
    '__Secure-bad=no', '__Host-bad=no; Secure', '__Host-domain=no; Secure; Path=/; Domain=login.example.com',
    '__Http-bad=no; Secure', '__Host-Http-bad=no; Secure; Path=/', '=__Http-bad=no', '__Host-invalid=no; Secure; Path=/; Path=invalid',
    'none=no; SameSite=None', 'bad\nname=no']) jar.setDocumentCookie(url, value)
  assert.equal(jar.getDocumentCookie(url), 'server=visible')
  jar.setDocumentCookie(url, 'js=one; Path=/; Secure; SameSite=None')
  assert.equal(jar.getDocumentCookie(url), 'server=visible; js=one')
  jar.setDocumentCookie(url, '__Host-good=yes; Path=/; Secure')
  jar.setDocumentCookie(url, 'scoped=yes')
  jar.setDocumentCookie(url, 'parent=yes; Domain=.example.com; Path=/')
  assert.equal(jar.getDocumentCookie(new URL('https://login.example.com/dir/next')), 'scoped=yes; server=visible; js=one; __Host-good=yes; parent=yes')
  assert.ok(!jar.getDocumentCookie(new URL('https://login.example.com/directory')).includes('scoped='))
  for (const other of ['https://other.example.com/', 'https://login.example.com:8443/', 'http://login.example.com/']) assert.equal(jar.getDocumentCookie(new URL(other)), '')
  jar.setDocumentCookie(url, 'js=; Path=/; Max-Age=0')
  assert.ok(!jar.getDocumentCookie(url).includes('js='))
  jar.setDocumentCookie(url, 'past=no; Expires=Tue, 01 Jan 2000 00:00:00 GMT')
  assert.ok(!jar.getDocumentCookie(url).includes('past='))
  let now = Date.now(); t.mock.method(Date, 'now', () => now)
  jar.setDocumentCookie(url, 'short=yes; Max-Age=1; Expires=Tue, 01 Jan 2000 00:00:00 GMT')
  assert.ok(jar.getDocumentCookie(url).includes('short=yes')); now += 1001
  assert.ok(!jar.getDocumentCookie(url).includes('short='))
  jar.setDocumentCookie(url, 'strict=yes; SameSite=Strict; Path=/')
  jar.setDocumentCookie(url, 'lax=yes; SameSite=Lax; Path=/')
  jar.setDocumentCookie(url, 'none=yes; SameSite=None; Secure; Path=/')
  const context = { site: new URL('https://other.example/'), topLevel: false, method: 'GET' }
  assert.equal(jar.getCookieHeader(url, false, context), 'none=yes')
  assert.ok(jar.getCookieHeader(url, false, { ...context, topLevel: true }).includes('lax=yes'))
  assert.ok(!jar.getCookieHeader(url, false, { ...context, topLevel: true }).includes('strict=yes'))
  assert.equal(jar.getCookieHeader(url, false, { ...context, topLevel: true, method: 'POST' }), 'none=yes')
  assert.ok(jar.getCookieHeader(url).includes('secret=private'))
})

test('Document prototype cookie accessors handle empty jars, writes, snapshots and explicit capability failures', () => {
  const jar = new GuestCookieJar(), url = new URL('https://site.example/path')
  class Document {}
  let failure
  class XHR {
    open(method, endpoint, async) { assert.equal(method, 'POST'); assert.equal(async, false); assert.ok(endpoint.includes('storage-token=capability')) }
    setRequestHeader() {}
    send(body) {
      if (failure) throw new DOMException('unavailable', failure)
      const input = JSON.parse(body)
      if (input.op === 'set') jar.setDocumentCookie(url, input.value)
      this.status = 200; this.responseText = JSON.stringify({ ok: true, value: jar.getDocumentCookie(url) })
    }
  }
  const context = { Document, document: new Document(), Storage: class {}, XMLHttpRequest: XHR, DOMException,
    location: { pathname: '/dsh-builtin-browser/browser-view/isolated-guest' } }
  context.window = context
  vm.createContext(context)
  vm.runInContext(`let real = ${JSON.stringify(url.href)};` + guestStorageScript({ token: 'capability', context: 'test-context' }), context)
  const descriptor = Object.getOwnPropertyDescriptor(Document.prototype, 'cookie')
  assert.equal(Object.hasOwn(context.document, 'cookie'), false)
  assert.equal(context.document.cookie, '')
  context.document.cookie = 'script=one; Path=/; Secure'
  assert.equal(context.document.cookie, 'script=one')
  failure = 'NetworkError'; assert.equal(context.document.cookie, 'script=one')
  for (const name of ['SecurityError', 'UnknownError']) {
    failure = name; assert.throws(() => context.document.cookie, error => error.name === name)
  }
  assert.throws(() => descriptor.get.call({}), error => error.name === 'TypeError')
  assert.throws(() => descriptor.set.call({}, 'x=y'), error => error.name === 'TypeError')
})

test('opaque Chromium documents synchronously share script and server cookies with the persistent proxy jar', {
  skip: !process.env.DSH_TEST_CHROME && 'set DSH_TEST_CHROME to a Chromium executable',
}, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-document-cookies-'))
  const oldFetch = globalThis.fetch, oldLookup = dns.lookup
  const storage = new GuestStorage(), jar = loadGuestCookies(directory)
  const markup = `<!doctype html><script>
    window.errors=[]; addEventListener('error',e=>errors.push(e.error?.name));
    (async()=>{
      const descriptor=Object.getOwnPropertyDescriptor(Document.prototype,'cookie');
      const initial=document.cookie;
      document.cookie='script=immediate; Path=/; Secure; Max-Age=3600';
      const immediate=document.cookie;
      const cache=await caches.open('site'); await cache.put('/x',new Response('x'));
      const cacheState=[await caches.keys(),await caches.has('site'),await caches.match('/x'),await cache.delete('site')];
      const network=await (await fetch('/echo',{headers:{'X-Site-Config':'fetch-value'}})).json();
      const xhrNetwork=await new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();xhr.open('GET','/echo');xhr.withCredentials=true;
        xhr.setRequestHeader('X-Site-Config','xhr-value');xhr.onload=()=>resolve(JSON.parse(xhr.responseText));xhr.onerror=()=>reject(new Error('XHR failed'));xhr.send()});
      const current=document.cookie;
      const token=document.querySelector('[data-dsh-guest-runtime]').textContent.match(/"token":"([^"]+)"/)[1];
      const forged=await fetch(${JSON.stringify(guestPath('https://other.example/'))}+'&storage-token='+encodeURIComponent(token),{
        method:'POST',headers:{'content-type':'text/plain'},body:JSON.stringify({area:'cookies',op:'get'})});
      let hostAccess;try { hostAccess=parent.document.cookie } catch(e) { hostAccess=e.name }
      parent.postMessage({done:true,initial,immediate,current,network,xhrNetwork,cacheState,hostAccess,
        forged:forged.status,errors,integrity:typeof descriptor.get==='function'&&typeof descriptor.set==='function'&&!Object.hasOwn(document,'cookie')},'*');
    })().catch(e=>parent.postMessage({failed:e.name+': '+e.message},'*'));
  </script>`
  dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }]
  globalThis.fetch = async (target, init) => {
    const url = new URL(target)
    if (url.pathname === '/echo') {
      const headers = new Headers({ 'content-type': 'application/json' })
      headers.append('set-cookie', 'server=received; Path=/; Secure; Max-Age=3600')
      headers.append('set-cookie', 'secret=private; HttpOnly; Secure; Path=/')
      return new Response(JSON.stringify({ cookie: init.headers.get('cookie'), config: init.headers.get('x-site-config'),
        metadata: init.headers.get('x-dsh-guest-headers'), authorization: init.headers.get('authorization') }), { headers })
    }
    return new Response(markup, { headers: { 'content-type': 'text/html', 'set-cookie': 'hidden=initial; HttpOnly; Path=/' } })
  }
  const server = createServer((req, res) => {
    if (req.url === '/') { res.setHeader('content-type','text/html'); res.end(`<!doctype html><script>document.cookie='DSH=private';window.results=[];addEventListener('message',e=>results.push(e.data))</script><iframe sandbox="allow-scripts allow-forms" src="${guestPath('https://site.example/start')}"></iframe>`); return }
    void handleGuest(req, res, '', '', jar, storage).catch(error => res.destroy(error))
  }).listen(0, '127.0.0.1')
  t.after(async () => {
    globalThis.fetch = oldFetch; dns.lookup = oldLookup
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    rmSync(directory, { recursive:true, force:true })
  })
  await once(server,'listening')
  const page = await chromiumPage(t)
  await page.navigate(`http://127.0.0.1:${server.address().port}/`)
  const result = await page.evaluate(`new Promise((resolve,reject)=>{const start=Date.now();const poll=setInterval(()=>{const value=results.find(x=>x.done||x.failed);if(value){clearInterval(poll);resolve(value)}else if(Date.now()-start>10000){clearInterval(poll);reject(new Error('cookie fixture timed out'))}},20)})`)
  assert.equal(result.failed, undefined, JSON.stringify(result))
  assert.equal(result.initial, '')
  assert.equal(result.integrity, true)
  assert.equal(result.immediate, 'script=immediate')
  assert.equal(result.network.cookie, 'hidden=initial; script=immediate')
  assert.equal(result.network.config, 'fetch-value'); assert.equal(result.xhrNetwork.config, 'xhr-value')
  assert.equal(result.network.metadata, null); assert.equal(result.network.authorization, null)
  assert.equal(result.current, 'script=immediate; server=received')
  assert.deepEqual(result.cacheState, [[], false, null, false])
  assert.equal(result.hostAccess, 'SecurityError'); assert.equal(result.forged, 403)
  assert.deepEqual(result.errors, [])
  const endpoint = `http://127.0.0.1:${server.address().port}` + guestPath('https://site.example/')
  const token = storage.issue('https://site.example', 'cookie-test-context')
  for (const [credential, operation, status] of [['invalid', {area:'cookies',op:'get'}, 403],
    [token, {area:'cookies',op:'invalid'}, 400], [token, {area:'cookies',op:'set',value:42}, 400]]) {
    const response = await oldFetch(endpoint + '&storage-token=' + encodeURIComponent(credential), {
      method:'POST', body:JSON.stringify(operation), headers:{'content-type':'text/plain'} })
    assert.equal(response.status, status)
  }
  const module = new URL('../lib/browser-electron/guest-cookie-store.js', import.meta.url).href
  const restart = spawnSync(process.execPath,['--input-type=module','-e',`import assert from 'node:assert/strict';import {loadGuestCookies} from ${JSON.stringify(module)};const jar=loadGuestCookies(${JSON.stringify(directory)});assert.equal(jar.getDocumentCookie(new URL('https://site.example/')),'script=immediate; server=received');assert.equal(jar.getDocumentCookie(new URL('https://other.example/')),'');`],{encoding:'utf8'})
  assert.equal(restart.status, 0, restart.stderr)
})
