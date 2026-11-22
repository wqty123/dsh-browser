import { test } from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { promises as dns } from 'node:dns'
import { guestCssRuntimeScript } from '../src/browser-electron/guest-css-runtime.ts'
import { rewriteCss } from '../src/browser-electron/guest-css.ts'
import { GUEST_ROUTE, guestPath, handleGuest } from '../src/browser-electron/guest-route.ts'
import { GuestCookieJar } from '../src/browser-electron/guest-cookie-jar.ts'
import { chromiumPage } from './fixtures/chromium-page.mjs'

test('runtime CSS shares the server scanner, preserves non-URLs and native CSSOM results/errors', async () => {
  const real = 'https://ordinary.example/dir/page', origin = 'http://dsh.example:3180'
  const calls = []
  class Sheet {
    insertRule(value) { if (value === 'invalid') throw new SyntaxError('invalid'); calls.push(value); return 3 }
    replaceSync(value) { calls.push(value) }
    async replace(value) { calls.push(value); return this }
  }
  class Declaration {
    setProperty(...args) { calls.push(args) }
    set cssText(value) { calls.push(value) }
  }
  const context = { URL, document: { baseURI: origin + guestPath(real) }, location: { origin, href: origin + guestPath(real) },
    real, route: GUEST_ROUTE, CSSStyleSheet: Sheet, CSSStyleDeclaration: Declaration,
    attempt(fn) { try { return fn() } catch {} },
    toProxy(value) { return guestPath(value) },
    realURL(value) { const url = new URL(value); return new URL(url.searchParams.get('u') || url.href) },
  }
  context.window = context
  const { proxyCss } = vm.runInNewContext(`(() => { ${guestCssRuntimeScript()}; return { proxyCss }; })()`, context)
  for (const css of ['@import "theme.css"; @font-face{src:url(../font.woff2)}',
    'background:image-set("a.png" 1x, url(b.png) 2x)', 'background:URL( image\\ name.png )',
    '', '/* url(secret) */', 'a{content:"url(secret)"}', 'src:local("a")',
    'url()', 'url(#mask)', 'url(data:image/png;base64,AA)', 'url(blob:https://ordinary.example/id)',
    'url("http://[")', 'url("unfinished', '@import "unfinished', 'url(unfinished',
  ]) {
    const expected = rewriteCss(css, raw => {
      if (!raw.trim() || raw.startsWith('#')) return undefined
      try { const url = new URL(raw, real); return /^https?:$/u.test(url.protocol) ? guestPath(url.href) : undefined } catch { return undefined }
    })
    assert.equal(proxyCss(css), expected, css)
    assert.equal(proxyCss(expected), expected, 'already proxied URLs are idempotent')
  }
  const sheet = new Sheet(); sheet.href = origin + guestPath('https://cdn.example/styles/site.css')
  const css = '@font-face{src:url(../fonts/font.woff2)}', expected = `@font-face{src:url("${guestPath('https://cdn.example/fonts/font.woff2')}")}`
  assert.equal(sheet.insertRule(css), 3); assert.equal(calls.pop(), expected)
  assert.throws(() => sheet.insertRule('invalid'), SyntaxError)
  assert.equal(sheet.replaceSync(css), undefined); assert.equal(calls.pop(), expected)
  assert.equal(await sheet.replace(css), sheet); assert.equal(calls.pop(), expected)
  const declaration = new Declaration(); declaration.parentRule = { parentStyleSheet: sheet }
  declaration.cssText = css; assert.equal(calls.pop(), expected)
  declaration.setProperty('src', 'url(../fonts/font.woff2)', 'important')
  assert.deepEqual(calls.pop(), ['src', `url("${guestPath('https://cdn.example/fonts/font.woff2')}")`, 'important'])
  declaration.setProperty('--value', null); assert.deepEqual(calls.pop(), ['--value', null, undefined])
})

test('Chromium routes runtime stylesheets, imports, CSSOM, style text and attributes through the unchanged CSP', {
  skip: !process.env.DSH_TEST_CHROME && 'set DSH_TEST_CHROME to a Chromium executable',
}, async t => {
  const originalFetch = globalThis.fetch, originalLookup = dns.lookup, requests = []
  const jar = new GuestCookieJar()
  const script = String.raw`
    (async () => {
      const violations = [], snapshots = [];
      addEventListener('securitypolicyviolation', event => violations.push([event.violatedDirective, event.blockedURI]));
      const css = name => '@font-face{font-family:"' + name + '";src:url("https://fonts.example/' + name + '.woff2")}';
      const style = () => { const node = document.createElement('style'); document.head.append(node); return node; };
      const a = style(); a.textContent = css('textContent'); snapshots.push(a.textContent);
      const b = document.createElement('style'); b.appendChild(document.createTextNode(css('textNode'))); document.head.append(b); snapshots.push(b.textContent);
      const c = style(); c.append(css('append')); snapshots.push(c.textContent);
      const d = style(); d.innerHTML = css('innerHTML'); snapshots.push(d.textContent);
      const e = style(); e.insertAdjacentHTML('beforeend', css('adjacentHTML')); snapshots.push(e.textContent);
      const f = style(); f.insertAdjacentText('beforeend', css('adjacentText')); snapshots.push(f.textContent);
      const g = style(); g.sheet.insertRule(css('insertRule')); snapshots.push(g.sheet.cssRules[0].cssText);
      g.sheet.insertRule('@media all {}', 1); g.sheet.cssRules[1].insertRule('.group{background:url(https://images.example/group.png)}');
      snapshots.push(g.sheet.cssRules[1].cssText);
      const sync = new CSSStyleSheet(); sync.replaceSync(css('replaceSync'));
      const asyncSheet = new CSSStyleSheet(); await asyncSheet.replace(css('replace'));
      document.adoptedStyleSheets = [sync, asyncSheet]; snapshots.push(sync.cssRules[0].cssText, asyncSheet.cssRules[0].cssText);
      const h = style(); h.textContent = css('beforeData'); h.firstChild.data = css('data'); snapshots.push(h.textContent);
      h.firstChild.nodeValue = css('nodeValue'); snapshots.push(h.textContent);
      const container = document.createElement('div');
      container.innerHTML = '<style>' + css('parsedMarkup') + '</style><a style="background:url(https://images.example/parsed.png)">styled link</a>';
      document.body.append(container); snapshots.push(container.querySelector('style').textContent, container.querySelector('a').getAttribute('style'));
      for (const [name, write] of [
        ['attribute', node => node.setAttribute('style', 'background-image:url(https://images.example/attribute.png)')],
        ['property', node => node.style.setProperty('background-image', 'url(https://images.example/property.png)', 'important')],
        ['cssText', node => { node.style.cssText = 'background-image:url(https://images.example/cssText.png)'; }],
        ['direct', node => { node.style.backgroundImage = 'url(https://images.example/direct.png)'; }],
        ['style', node => { node.style = 'background-image:url(https://images.example/style.png)'; }],
      ]) { const node = document.createElement('div'); node.textContent = name; write(node); document.body.append(node); snapshots.push(node.getAttribute('style')); }
      const link = document.createElement('link'); link.rel = 'stylesheet'; link.crossOrigin = 'anonymous';
      const loaded = new Promise((resolve, reject) => { link.onload = resolve; link.onerror = () => reject(new Error('stylesheet failed')); });
      link.href = '/styles/runtime.css'; document.head.append(link); await loaded;
      link.sheet.insertRule(css('externalInsert').replace('https://fonts.example/externalInsert.woff2', '../fonts/externalInsert.woff2'), link.sheet.cssRules.length);
      snapshots.push(link.sheet.cssRules[link.sheet.cssRules.length - 1].cssText);
      const fetched = await (await fetch('/styles/runtime.css')).text();
      const fetchedSheet = new CSSStyleSheet(); await fetchedSheet.replace(fetched);
      snapshots.push([...fetchedSheet.cssRules].map(rule => rule.cssText).join(''));
      await Promise.allSettled(['textContent', 'textNode', 'append', 'innerHTML', 'adjacentHTML', 'adjacentText', 'insertRule', 'replaceSync', 'replace', 'nodeValue', 'parsedMarkup', 'external', 'imported', 'externalInsert'].map(name => document.fonts.load('16px "' + name + '"')));
      await new Promise(resolve => setTimeout(resolve, 50));
      parent.postMessage({ type: 'css-result', snapshots, violations }, '*');
    })().catch(error => parent.postMessage({ type: 'css-result', error: String(error) }, '*'));
  `
  dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }]
  globalThis.fetch = async target => {
    const url = new URL(target); requests.push(url.href)
    if (url.pathname === '/dir/page') return new Response(`<html><head></head><body><script>${script}</script></body></html>`, { headers: { 'content-type': 'text/html' } })
    if (url.pathname === '/styles/runtime.css') return new Response('@import "nested/import.css"; @font-face{font-family:external;src:url(../fonts/external.woff2)}', { headers: { 'content-type': 'text/css' } })
    if (url.pathname === '/styles/nested/import.css') return new Response('@font-face{font-family:imported;src:url(../../fonts/imported.woff2)}', { headers: { 'content-type': 'text/css' } })
    return new Response('fixture resource', { headers: { 'content-type': url.pathname.endsWith('.woff2') ? 'font/woff2' : 'image/png' } })
  }
  const server = createServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html'); res.end(`<script>window.result = null; addEventListener('message', event => { if (event.data?.type === 'css-result') window.result = event.data; });</script><iframe src="${guestPath('https://ordinary.example/dir/page')}"></iframe>`)
    } else void handleGuest(req, res, '', '', jar).catch(error => res.destroy(error))
  }).listen(0, '127.0.0.1')
  t.after(async () => { globalThis.fetch = originalFetch; dns.lookup = originalLookup; await new Promise(resolve => server.close(resolve)) })
  await once(server, 'listening')
  const page = await chromiumPage(t)
  await page.navigate(`http://127.0.0.1:${server.address().port}/`)
  const result = await page.evaluate(`new Promise((resolve, reject) => {
    const timer = setTimeout(() => { clearInterval(poll); reject(new Error('CSS result timed out')); }, 10000);
    const poll = setInterval(() => { if (window.result) { clearTimeout(timer); clearInterval(poll); resolve(window.result); } }, 10);
  })`)
  assert.equal(result.error, undefined)
  assert.deepEqual(result.violations, [])
  assert.equal(result.snapshots.length, 21)
  for (const snapshot of result.snapshots) { assert.ok(snapshot.includes(GUEST_ROUTE), snapshot); assert.doesNotMatch(snapshot, /url\(["']?https:\/\//u) }
  for (const name of ['textContent', 'textNode', 'append', 'innerHTML', 'adjacentHTML', 'adjacentText', 'insertRule', 'replaceSync', 'replace', 'nodeValue', 'parsedMarkup']) {
    assert.ok(requests.includes(`https://fonts.example/${name}.woff2`), name)
  }
  for (const name of ['external', 'imported', 'externalInsert']) assert.ok(requests.includes(`https://ordinary.example/fonts/${name}.woff2`), name)
  assert.ok(requests.includes('https://ordinary.example/styles/nested/import.css'))
  assert.ok(requests.every(url => !new URL(url).pathname.includes(GUEST_ROUTE)), 'already proxied CSS is never double-proxied')
})
