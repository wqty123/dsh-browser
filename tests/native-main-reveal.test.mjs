import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { nativeMainReveal } from './fixtures/native-main-reveal.mjs'
import { chromiumPage } from './fixtures/chromium-page.mjs'
import { captureScript } from '../lib/browser-reference/page-script.js'

test('a protocol-3 native bridge returns an explicit reveal error through the HTTP binding path', async t => {
  const snapshot = {
    version: 1, provider: 'dsh-browser', referenceId: 'old-bridge',
    owner: { sessionId: 'owner' },
    provenance: { origin: 'user-selection', entry: 'page-overlay' },
    source: { pageUrl: 'https://example.com/', title: 'Source', carrier: 'sidebar', capturedAt: new Date().toISOString() },
    parts: [{ partId: 'text', type: 'text', text: 'selected words', anchor: { exact: 'selected words', prefix: '', suffix: '' } }],
  }
  const backend = await nativeMainReveal(snapshot, { url: snapshot.source.pageUrl, ready: true, highlighted: false })
  t.after(() => backend.close())
  await backend.start(3)
  const outcome = await backend.post({ referenceId: snapshot.referenceId, sourcePageId: '2' })
  assert.equal(outcome.status, 'unavailable')
  assert.equal(outcome.note, '桥接版本过旧，请点击 卸载并重装')
  assert.equal(backend.commands.length, 0)
})

test('the shipped Desktop main entry starts the bridge needed for source-bound reveal after restart', async t => {
  const snapshot = {
    version: 1, provider: 'dsh-browser', referenceId: 'native-reveal',
    owner: { sessionId: 'owner', browserSessionId: 'closed-session' },
    provenance: { origin: 'user-selection', entry: 'page-overlay' },
    source: { pageUrl: 'https://www.runoob.com/html/html-lists.html', title: 'Lists', carrier: 'sidebar', capturedAt: new Date().toISOString() },
    parts: [{ partId: 'text', type: 'text', text: 'selected words', anchor: { exact: 'selected words', prefix: 'before ', suffix: ' after' } }],
  }
  const live = { url: snapshot.source.pageUrl, ready: true, highlighted: false }
  const backend = await nativeMainReveal(snapshot, live)
  t.after(() => backend.close())
  const initial = await backend.post({ referenceId: snapshot.referenceId })
  assert.equal(initial.status, 'session-unavailable')
  const request = { referenceId: snapshot.referenceId, sourcePageId: '2' }
  const missing = await backend.post(request)
  assert.equal(missing.status, 'unavailable')
  assert.equal(missing.note, 'sidebar page binding unavailable')
  assert.equal(live.highlighted, false)
  await backend.start()
  const outcome = await backend.post(request)
  assert.equal(outcome.status, 'revealed', JSON.stringify(outcome))
  assert.equal(live.highlighted, true)
  assert.equal(backend.commands.length, 3)
  assert.equal((await backend.post({ referenceId: 'unknown', sourcePageId: '2' })).status, 'not-found')
})

test('Desktop source binding reveals real Runoob cells and structured math through native CDP after navigation back', {
  skip: !process.env.DSH_TEST_CHROME && 'set DSH_TEST_CHROME to a Chromium executable',
}, async t => {
  const markup = readFileSync(new URL('./fixtures/runoob-html-tables.html', import.meta.url), 'utf8')
  const server = createServer((req, res) => {
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.setHeader('content-security-policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'")
    res.end(req.url === '/source' ? markup.replace('</body>', '<p>Before <span class="katex"><math><semantics><mroot><mi>x</mi><mn>3</mn></mroot><annotation encoding="application/x-tex">\\sqrt[3]{x}</annotation></semantics></math></span> after</p></body>') : '<p>Away</p>')
  }).listen(0, '127.0.0.1')
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
  await once(server, 'listening')
  const page = await chromiumPage(t)
  const url = `http://127.0.0.1:${server.address().port}/source`
  const away = `http://127.0.0.1:${server.address().port}/away`
  for (const kind of ['table', 'formula']) {
    await page.navigate(url)
    const frozen = await page.evaluate(`(() => {
      const target = ${kind === 'table' ? "[...document.querySelectorAll('table')].find(table => table.querySelector('th'))" : "document.querySelector('.katex')"};
      const range = document.createRange(); range.selectNodeContents(target);
      if (target.tagName === 'TABLE') {
        const last = target.rows[target.rows.length - 1].cells;
        range.setStart(target.rows[0].cells[0], 0);
        range.setEnd(last[last.length - 1], last[last.length - 1].childNodes.length);
      }
      getSelection().removeAllRanges(); getSelection().addRange(range);
      const expected = getSelection().toString();
      const raw = JSON.parse((function() { return ${captureScript()} })());
      return { raw, expected };
    })()`)
    const live = { url, ready: true }
    const owner = `fresh-${kind}`
    const backend = await nativeMainReveal({ owner: { sessionId: owner }, parts: [] }, live, 2, page.command)
    try {
      await backend.start()
      const stored = await backend.post({ sessionId: owner, origin: 'user-selection', entry: 'page-overlay', capture: frozen.raw }, true)
      assert.equal(stored.ok, true, JSON.stringify(stored))
      const referenceId = stored.reference.referenceId
      assert.equal(backend.get(referenceId).owner.browserSessionId, undefined, 'a frozen overlay capture never registered a native session')
      assert.equal((await backend.post({ referenceId })).note, 'reference has no live source binding')
      await page.navigate(away); live.url = away
      const request = { referenceId, sourcePageId: '2' }
      assert.equal((await backend.post(request)).status, 'page-mismatch')
      await page.navigate(url); live.url = url
      const outcome = await backend.post(request)
      assert.equal(outcome.status, 'revealed', JSON.stringify(outcome))
      const selected = await page.evaluate('({ text: getSelection().toString(), rects: document.getElementById("__dsh-ref-highlight")?.children.length })')
      assert.equal(selected.text, frozen.expected, kind)
      assert.ok(selected.rects >= (kind === 'table' ? 4 : 1), JSON.stringify(selected))
      assert.equal((await backend.post({ ...request, partId: 'missing' })).status, 'not-found')
    } finally { await backend.close() }
  }
})
