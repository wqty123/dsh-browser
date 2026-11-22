import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { setTimeout } from 'node:timers/promises'
import { handleGuest, guestPath } from '../src/browser-electron/guest-route.ts'
import { GuestStorage } from '../src/browser-electron/guest-storage.ts'
import { GuestCookieJar } from '../src/browser-electron/guest-cookie-jar.ts'
import { chromiumPage } from './fixtures/chromium-page.mjs'

test('live Baidu accepts human-style Chinese input and renders search results through the opaque guest proxy', {
  skip: 'Baidu serves an upstream slider challenge in automated browsers, including direct access',
  timeout: 120000,
}, async t => {
  const storage = new GuestStorage(), jar = new GuestCookieJar(), trace = []
  const nativeFetch = globalThis.fetch
  globalThis.fetch = async (target, init) => {
    const response = await nativeFetch(target, init)
    const url = new URL(target)
    if (url.hostname === 'www.baidu.com' && url.pathname === '/s') {
      const body = await response.clone().text()
      trace.push({ upstream: '/s', method: init?.method, status: response.status,
        type: response.headers.get('content-type'), challenge: /安全验证|ds_svcp|wappass|seccaptcha/iu.test(body),
        h3: (body.match(/<h3\b/giu) || []).length })
    }
    return response
  }
  const probe = `<script>(()=>{
    const report=()=>{
      const rect=selector=>{const el=document.querySelector(selector);if(!el)return;const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}};
      parent.postMessage({baiduProbe:true,url:new URL(location.href).searchParams.get('u'),h3:document.querySelectorAll('h3').length,
        input:rect('#chat-textarea'),button:rect('#chat-submit-button'),cookie:typeof document.cookie,caches:typeof caches},'*');
    };
    setInterval(report,250);report();
  })()</script>`
  const server = createServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html')
      res.end(`<script>window.reports=[];addEventListener('message',e=>{if(e.data?.baiduProbe)reports.push(e.data)})</script><iframe style="position:absolute;left:0;top:0;width:1200px;height:900px;border:0" sandbox="allow-scripts allow-forms" src="${guestPath('https://www.baidu.com/')}"></iframe>`)
      return
    }
    const url = new URL(req.url, 'http://proxy.invalid').searchParams.get('u')
    if (url) {
      const upstream = new URL(url)
      if (upstream.hostname === 'www.baidu.com' && ['/s', '/sugrec'].includes(upstream.pathname)) {
        res.once('finish', () => trace.push({ proxy: upstream.pathname, wd: upstream.searchParams.get('wd'), method: req.method, status: res.statusCode,
          preflight: req.headers['access-control-request-headers'] }))
      }
    }
    void handleGuest(req, res, probe, '', jar, storage).catch(error => res.destroy(error))
  }).listen(0, '127.0.0.1')
  t.after(async () => {
    globalThis.fetch = nativeFetch
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  })
  await once(server, 'listening')
  const page = await chromiumPage(t)
  await page.command('Emulation.setDeviceMetricsOverride', { width:1280, height:1000, deviceScaleFactor:1, mobile:false })
  await page.command('Page.navigate', { url:`http://127.0.0.1:${server.address().port}/` })
  let ready
  for (let attempt = 0; attempt < 120; attempt++) {
    ready = await page.evaluate('window.reports?.findLast(x=>x.input&&x.button)')
    if (ready) break
    await setTimeout(500)
  }
  assert.ok(ready, 'Baidu chat textarea and submit button must load')
  assert.equal(ready.cookie, 'string'); assert.equal(ready.caches, 'object')
  const click = async point => {
    await page.command('Input.dispatchMouseEvent', { type:'mousePressed', button:'left', clickCount:1, ...point })
    await page.command('Input.dispatchMouseEvent', { type:'mouseReleased', button:'left', clickCount:1, ...point })
  }
  await click(ready.input)
  for (const text of '数独') {
    await page.command('Input.insertText', { text })
    await setTimeout(120)
  }
  const updated = await page.evaluate('reports.findLast(x=>x.button)')
  await click(updated.button)
  let result
  for (let attempt = 0; attempt < 60; attempt++) {
    result = await page.evaluate('reports.findLast(x=>x.h3>0)||reports.at(-1)')
    if (result?.h3 > 0 && new URL(result.url).pathname === '/s') break
    await setTimeout(500)
  }
  t.diagnostic(JSON.stringify({ result, trace }))
  assert.equal(new URL(result.url).pathname, '/s', 'Baidu must reach its search results page, not a security challenge')
  assert.equal(new URL(result.url).searchParams.get('wd'), '数独')
  assert.ok(result.h3 > 0, 'Baidu results must contain h3 items; a challenge is not a pass')
})
