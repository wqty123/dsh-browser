import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { promises as dns } from 'node:dns'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Script } from 'node:vm'
import { guestPath, handleGuest, rewriteDocument } from '../src/browser-electron/guest-route.ts'
import { GuestCookieJar } from '../src/browser-electron/guest-cookie-jar.ts'
import { GuestStorage } from '../src/browser-electron/guest-storage.ts'
import { captureEntrySource } from '../src/browser-reference/page-script.ts'

const source = 'https://www.runoob.com/html/html-tables.html'
const markup = readFileSync(new URL('./fixtures/runoob-html-tables.html', import.meta.url), 'utf8')
const scripts = html => [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/giu)].map(match => match[1])

test('the public Runoob fixture keeps every inline script byte-for-byte through rewriting', () => {
  const original = scripts(markup)
  assert.ok(original.some(script => script.includes('href = $(this).children("a").attr("href");')))
  const served = scripts(rewriteDocument(markup, new URL(source)))
  assert.deepEqual(served, original)
  for (const script of served) assert.doesNotThrow(() => new Script(script))
})

test('real Chromium restores Runoob theme storage without weakening isolation, and selects the table after navigation back', {
  skip: !process.env.DSH_TEST_CHROME && 'set DSH_TEST_CHROME to a Chromium executable',
}, async t => {
  const originalFetch = globalThis.fetch, originalLookup = dns.lookup
  const profile = mkdtempSync(join(tmpdir(), 'dsh-runoob-'))
  let chrome, socket, exited
  const jar = new GuestCookieJar()
  const storage = new GuestStorage()
  const observer = `<script>
    if (location.search.includes('capture=1')) {
      localStorage.setItem('runoob-theme', 'dark');
      sessionStorage.setItem('roundtrip', 'retained');
    }
    addEventListener('error', event => parent.postMessage({ type: 'fixture-error', name: event.error?.name }, '*'));
    addEventListener('message', event => {
      if (event.source === parent && event.data?.type === 'dsh.browser.guest.reference.request') {
        parent.postMessage({ type: 'fixture-selection', selected: getSelection().toString(),
          highlights: document.getElementById('__dsh-ref-highlight')?.children.length || 0 }, '*');
      }
    });
    addEventListener('DOMContentLoaded', async () => {
      localStorage.named = 42;
      const named = [localStorage.named, localStorage.getItem('named'), 'named' in localStorage];
      delete localStorage.named;
      let parentStorage;
      try { parent.localStorage.getItem('dsh-private'); parentStorage = 'accessible'; } catch (error) { parentStorage = error.name; }
      parent.postMessage({ type: 'fixture-storage', theme: document.documentElement.getAttribute('data-theme'),
        darkCss: !!document.getElementById('dark-theme-css'), session: sessionStorage.getItem('roundtrip'),
        missing: localStorage.getItem('named'), parentStorage, keys: Object.keys(localStorage),
        length: localStorage.length, key: localStorage.key(0), outOfRange: localStorage.key(999), named }, '*');
      if (location.search.includes('capture=1')) {
        const runtime = document.querySelector('[data-dsh-guest-runtime]').textContent;
        const token = runtime.match(/"token":"([^"]+)"/)[1];
        const other = ${JSON.stringify(guestPath('https://other.example/away'))};
        const read = await window.__dshGuestFetch(other, { mode: 'cors', credentials: 'omit',
          headers: { 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate' } });
        const fetched = await read.text();
        const forged = await window.__dshGuestFetch(other + '&storage-token=' + encodeURIComponent(token), {
          method: 'POST', mode: 'cors', credentials: 'omit', headers: { 'content-type': 'text/plain' },
          body: JSON.stringify({ area: 'local', op: 'get', key: 'runoob-theme' }) });
        const denied = await forged.json();
        parent.postMessage({ type: 'fixture-security', fetchHasRuntime: fetched.includes('data-dsh-guest-runtime'),
          status: forged.status, name: denied.name }, '*');
        const table = [...document.querySelectorAll('table')].find(table => table.querySelector('th'));
        const range = document.createRange();
        range.setStart(table.rows[0].cells[0], 0);
        const last = table.rows[table.rows.length - 1].cells[1];
        range.setEnd(last, last.childNodes.length);
        getSelection().removeAllRanges(); getSelection().addRange(range);
        const frozen = (${captureEntrySource()})({ context: 32 });
        parent.postMessage({ type: 'fixture-capture', frozen, selected: getSelection().toString() }, '*');
        getSelection().removeAllRanges();
      }
    });
  </script>`
  dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }]
  globalThis.fetch = async target => {
    const url = new URL(target)
    if (url.href === source) return new Response(markup.replace(/<head\b[^>]*>/iu, open => open + observer), {
      headers: { 'content-type': 'text/html', 'cache-control': 'public, max-age=86400' },
    })
    if (/\.js$/iu.test(url.pathname)) return new Response('', { headers: { 'content-type': 'text/javascript' } })
    if (/\.css$/iu.test(url.pathname)) return new Response('', { headers: { 'content-type': 'text/css' } })
    if (/\.(?:png|jpg|gif|jpeg)$/iu.test(url.pathname)) return new Response(null, { status: 204 })
    if (url.pathname === '/away') return new Response(`<!doctype html><script>
      const before = [localStorage.getItem('runoob-theme'), sessionStorage.getItem('roundtrip')];
      localStorage.setItem('runoob-theme', 'other-site'); sessionStorage.setItem('roundtrip', 'other-site');
      parent.postMessage({ type: 'fixture-away-storage', before }, '*');
    </script><p>Away</p>`, { headers: { 'content-type': 'text/html' } })
    return new Response('', { headers: { 'content-type': 'text/javascript' } })
  }
  const html = `<!doctype html><meta charset="utf-8"><pre id="result">waiting</pre><pre id="trace"></pre><script>
    const frame = document.createElement('iframe'); frame.style.cssText = 'width:1000px;height:800px';
    localStorage.setItem('dsh-private', 'host-only');
    const context = '&storage-context=fixture-browser-context';
    const source = ${JSON.stringify(source)}, path = ${JSON.stringify(guestPath(source))} + context;
    let part, expected, phase = 'capture', sent = false, identity, ack, selection;
    const errors = [], trace = [], storages = []; let awayStorage, security;
    function finish() {
      if (ack && selection && storages.length === 2 && security) document.getElementById('result').textContent = JSON.stringify({
        errors, identity, ack, selection, expected, captured: part.kind, phase, storages, awayStorage, security
      });
    }
    addEventListener('message', event => {
      if (event.source !== frame.contentWindow || event.origin !== 'null') return;
      const data = event.data;
      trace.push({ type: data.type, phase, ready: data.ready, loadId: data.loadId, documentId: data.documentId });
      document.getElementById('trace').textContent = JSON.stringify(trace);
      if (data.type === 'fixture-error') errors.push(data.name);
      if (data.type === 'fixture-storage') storages.push(data);
      if (data.type === 'fixture-away-storage') awayStorage = data.before;
      if (data.type === 'fixture-security') security = data;
      if (data.type === 'fixture-capture') {
        if (!data.frozen.ok) throw new Error(data.frozen.reason);
        part = data.frozen.events.find(event => event.kind === 'table'); expected = data.selected;
        phase = 'away'; frame.src = ${JSON.stringify(guestPath('https://other.example/away'))} + context;
      }
      if (data.type === 'dsh.browser.guest.navigation' && data.ready) {
        if (phase === 'away' && data.url.endsWith('/away')) { phase = 'back'; frame.src = path; }
        else if (phase === 'back' && data.url === source) {
          if (data.loadId !== 7) frame.contentWindow.postMessage({ type: 'dsh.browser.guest.navigation.request', loadId: 7 }, '*');
          else if (!sent) {
            identity = data.documentId; sent = true;
            frame.contentWindow.postMessage({ type: 'dsh.browser.guest.reference.request', operation: 'element',
              url: source, loadId: 7, documentId: identity, requestId: 1,
              spec: { kind: 'table', anchor: { selector: part.selector },
                cells: part.table.cells.filter(cell => cell.includedAs === 'selection').map(({ row, column }) => ({ row, column })) }
            }, '*');
          }
        }
      }
      if (data.type === 'dsh.browser.guest.reference.ack') { ack = data; finish(); }
      if (data.type === 'fixture-selection') { selection = data; finish(); }
      finish();
    });
    frame.src = path + '&capture=1'; document.body.append(frame);
  </script>`
  const server = createServer((req, res) => {
    if (req.url === '/') { res.setHeader('content-type', 'text/html'); res.end(html) }
    else void handleGuest(req, res, '', '', jar, storage).catch(error => res.destroy(error))
  }).listen(0, '127.0.0.1')
  t.after(async () => {
    socket?.close()
    chrome?.kill()
    if (exited) await exited
    globalThis.fetch = originalFetch; dns.lookup = originalLookup
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
    rmSync(profile, { recursive: true, force: true })
  })
  await once(server, 'listening')
  chrome = spawn(process.env.DSH_TEST_CHROME, [
    '--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`,
    '--remote-debugging-port=0', 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] })
  exited = once(chrome, 'exit')
  const endpoint = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Chromium did not open its debugging endpoint')), 10000)
    chrome.once('error', error => { clearTimeout(timer); reject(error) })
    let output = ''
    chrome.stderr.on('data', chunk => {
      output += chunk
      const endpoint = output.match(/DevTools listening on (ws:\/\/[^\s]+)/u)?.[1]
      if (endpoint) { clearTimeout(timer); resolve(endpoint) }
    })
  })
  socket = new WebSocket(endpoint)
  await once(socket, 'open')
  let sequence = 0
  const pending = new Map()
  socket.addEventListener('message', event => {
    const data = JSON.parse(event.data)
    const request = pending.get(data.id)
    if (request) {
      pending.delete(data.id)
      if (data.error) request.reject(new Error(JSON.stringify(data.error)))
      else request.resolve(data.result)
    }
  })
  const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params, sessionId }))
  })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  const { sessionId } = await send('Target.attachToTarget', { targetId, flatten: true })
  await send('Page.enable', {}, sessionId)
  await send('Page.navigate', { url: `http://127.0.0.1:${server.address().port}/` }, sessionId)
  const evaluated = await send('Runtime.evaluate', { awaitPromise: true, returnByValue: true, expression: `new Promise((resolve, reject) => {
    const timer = setTimeout(() => { clearInterval(poll); reject(new Error(document.getElementById('trace')?.textContent || 'No trace')); }, 10000);
    const poll = setInterval(() => {
      const text = document.getElementById('result')?.textContent;
      if (text && text !== 'waiting') { clearInterval(poll); clearTimeout(timer); resolve(JSON.parse(text)); }
    }, 10);
  })` }, sessionId)
  assert.equal(evaluated.exceptionDetails, undefined, JSON.stringify(evaluated.exceptionDetails))
  const result = evaluated.result.value
  assert.ok(!result.errors.includes('SyntaxError'), JSON.stringify(result.errors))
  assert.ok(!result.errors.includes('SecurityError'), JSON.stringify(result.errors))
  assert.deepEqual(result.awayStorage, [null, null])
  assert.equal(result.security.fetchHasRuntime, false)
  assert.equal(result.security.status, 403)
  assert.equal(result.security.name, 'SecurityError')
  assert.equal(result.storages.length, 2)
  for (const state of result.storages) {
    assert.equal(state.theme, 'dark')
    assert.equal(state.darkCss, true)
    assert.equal(state.session, 'retained')
    assert.equal(state.missing, null)
    assert.equal(state.parentStorage, 'SecurityError')
    assert.deepEqual(state.keys, ['runoob-theme'])
    assert.equal(state.length, 1)
    assert.equal(state.key, 'runoob-theme')
    assert.equal(state.outOfRange, null)
    assert.deepEqual(state.named, ['42', '42', true])
  }
  assert.equal(typeof result.identity, 'string')
  assert.ok(result.identity.length > 0)
  assert.equal(result.captured, 'table')
  assert.equal(result.phase, 'back')
  assert.equal(result.ack.documentId, result.identity)
  assert.equal(result.ack.ok, true)
  assert.equal(result.ack.value.status, 'found')
  assert.equal(result.selection.selected, result.expected)
  assert.match(result.selection.selected, /定义表格/u)
  assert.ok(result.selection.highlights >= 4)
})
