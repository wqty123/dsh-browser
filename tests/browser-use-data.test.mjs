// Data-first browsing on the code surface: data-source inspection, same-origin JSON fetches,
// deterministic waits, and the title/alert half of the post-action line.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'

import { apply } from '../lib/tool-browser/index.js'
import { actionSummary } from '../lib/tool-browser/code-tool.js'
import { formatDataSources } from '../lib/tool-browser/tools-debug.js'
import { PROBE_INSTALL_SCRIPT, probeCallScript, pageOperationScript } from '../src/tool-browser/page-probe.ts'
import { poll } from '../src/tool-browser/probe-client.ts'
import { chromiumPage } from './fixtures/chromium-page.mjs'

function mount({ onClick } = {}) {
  const tools = new Map()
  const disposers = []
  after(() => { for (const dispose of disposers) dispose?.() })
  const tab = { id: 'tab-main', url: 'https://example.test/', active: true }
  const page = { title: 'Example', alerts: [], dialogs: [], probe: 7, text: '', polls: 0, network: [] }
  const sources = { url: tab.url, embedded: [{ name: '#__NEXT_DATA__', bytes: 2048, keys: ['props'], arrays: [{ path: 'props.pageProps.stores', length: 40 }] }], apis: [], resources: [], declared: [] }
  const bodies = {
    'https://example.test/api/stores': { ok: true, status: 200, statusText: 'OK', url: 'https://example.test/api/stores', type: 'application/json', body: '{"stores":[{"id":1},{"id":2}]}' },
    'https://example.test/api/missing': { ok: false, status: 404, statusText: 'Not Found', url: 'https://example.test/api/missing', type: 'text/html', body: `<h1>no such store</h1>${'x'.repeat(400)}` },
    'https://example.test/html': { ok: true, status: 200, statusText: 'OK', url: 'https://example.test/html', type: 'text/html', body: '<!doctype html><p>hello</p>' },
  }
  const fetches = []
  const ok = value => ({ ok: true, value: JSON.stringify(value) })
  const browser = {
    open: async () => 'session-1',
    openPanel: async () => 'session-1',
    exists: () => true,
    close: async () => {},
    openUrl: async (_session, request) => { tab.url = request.url; page.title = `Title of ${request.url}` },
    listTabs: async () => [{ ...tab }],
    snapshot: async () => ({ url: tab.url, title: page.title, truncated: false, elements: [] }),
    click: async () => { onClick?.(page); return { clicked: true } },
    pageOperation: async (_session, request) => {
      if (request.operation === 'pulse') return ok({ title: page.title, alerts: page.alerts, dialogs: page.dialogs, probe: page.probe })
      if (request.operation === 'install') return ok(7)
      if (request.operation === 'text') return ok(page.text.includes(request.text))
      if (request.operation === 'fetch') { fetches.push(request); return ok(bodies[request.url]) }
      if (request.operation === 'probe' && request.method === 'dataSources') return ok(sources)
      if (request.operation === 'probe' && request.method === 'networkCursor') return ok({ startedAt: 1, sequence: page.network.length })
      if (request.operation === 'probe' && request.method === 'read') return ok(page.network.filter(row => row.url.includes(request.args[1])))
      return ok({})
    },
    execute: async (_session, request) => {
      page.polls += 1
      if (request.script.includes('READY')) return { ok: true, value: JSON.stringify(page.polls >= 3 ? { rows: page.polls } : null) }
      if (request.script.includes('THROWS')) return { ok: false, exception: 'TypeError: cannot read properties of null' }
      return { ok: true, value: JSON.stringify(0) }
    },
  }
  apply({
    tools: { register: tool => { tools.set(tool.name, tool) } },
    systemPrompt: { section() {} },
    effect: fn => { disposers.push(fn()) },
    get: name => name === 'browser' ? browser : undefined,
  }, {})
  const exec = { agent: { id: 'data-owner' } }
  const run = code => tools.get('dsh_browser_code').execute({ code }, exec)
  return { run, page, fetches }
}

test('actionSummary adds the title after a move or retitle, new alert regions, and dialogs answered meanwhile', () => {
  const a = { id: 'a', url: 'https://a.test/', active: true }
  const pulse = (over = {}) => ({ title: 'Home', alerts: [], dialogs: [], probe: 5, ...over })
  assert.equal(actionSummary([a], [a], { before: pulse(), after: pulse() }), '\u2192 still on https://a.test/')
  assert.equal(actionSummary([a], [{ ...a, url: 'https://a.test/next' }], { before: pulse(), after: pulse({ title: 'Next' }) }),
    '\u2192 navigated to https://a.test/next; title "Next"')
  assert.equal(actionSummary([a], [a], { before: pulse(), after: pulse({ title: 'Home (2)' }) }), '\u2192 still on https://a.test/; title "Home (2)"')
  assert.equal(actionSummary(undefined, [a], { after: pulse() }), '\u2192 on https://a.test/; title "Home"')
  assert.equal(actionSummary([a], [a], { before: pulse({ alerts: ['Old error'] }), after: pulse({ alerts: ['Old error', 'Email is required'] }) }),
    '\u2192 still on https://a.test/; alert "Email is required"')
  const old = { at: 100, kind: 'alert', message: 'earlier', answered: 'dismissed' }
  const fresh = { at: 200, kind: 'confirm', message: 'Delete it?', answered: 'accepted' }
  assert.equal(actionSummary([a], [a], { before: pulse({ dialogs: [old] }), after: pulse({ dialogs: [old, fresh] }) }),
    '\u2192 still on https://a.test/; confirm() "Delete it?" accepted')
  assert.equal(actionSummary([a], [{ ...a, url: 'https://a.test/x' }], { before: pulse({ dialogs: [old] }), after: pulse({ title: '', probe: 9, dialogs: [old] }) }),
    '\u2192 navigated to https://a.test/x; alert() "earlier" dismissed', 'a new probe means every dialog it holds is new')
  assert.equal(actionSummary([a], [a]), '\u2192 still on https://a.test/', 'without a page read the line is unchanged')
})

test('an action in a cell reports the title and alerts it caused', async () => {
  const { run } = mount({ onClick: page => {
    page.title = 'Saved'
    page.alerts = ['Profile saved']
    page.dialogs = [{ at: Date.now(), kind: 'alert', message: 'Done', answered: 'dismissed' }]
  } })
  const value = await run(`print(await goto_url('https://example.test/form'))\nprint(await click('Save'))`)
  assert.equal(value.ok, true, value.output)
  assert.match(value.output, /\u2192 on https:\/\/example\.test\/form; title "Title of https:\/\/example\.test\/form"/)
  assert.match(value.output, /\u2192 still on https:\/\/example\.test\/form; title "Saved"; alert "Profile saved"; alert\(\) "Done" dismissed/)
})

test('inspect_data_sources and fetch_json read the page data with the page cookies', async () => {
  const { run, fetches } = mount()
  const value = await run(`
await goto_url('https://example.test/')
const found = await inspect_data_sources()
print(found.embedded[0].arrays[0].path)
const data = await fetch_json('https://example.test/api/stores')
print(data.stores.length)
await fetch_json('https://example.test/api/stores', { method: 'POST', body: { page: 2 } })
let missing = ''
try { await fetch_json('https://example.test/api/missing') } catch (error) { missing = error.message }
print(missing)
let html = ''
try { await fetch_json('https://example.test/html') } catch (error) { html = error.message }
print(html)
`)
  assert.equal(value.ok, true, value.output)
  assert.match(value.output, /props\.pageProps\.stores\n2\n/)
  assert.match(value.output, /fetch_json: HTTP 404 Not Found from https:\/\/example\.test\/api\/missing: <h1>no such store<\/h1>x+\n/)
  const missingLine = value.output.split('\n').find(line => line.includes('HTTP 404'))
  assert.ok(missingLine.length < 320, 'only the start of the body is quoted')
  assert.match(value.output, /answered 200 with text\/html, not JSON: <!doctype html>/)
  assert.deepEqual(fetches[1].init, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"page":2}' })
})

test('wait_until polls a page expression, returns its value, and reports the last result on timeout', async () => {
  const { run } = mount()
  const value = await run(`
await goto_url('https://example.test/')
print(JSON.stringify(await wait_until('READY', { intervalMs: 50 })))
let message = ''
try { await wait_until('NEVER', { timeoutMs: 400, intervalMs: 50 }) } catch (error) { message = error.message }
print(message)
try { await wait_until('THROWS', { timeoutMs: 200, intervalMs: 50 }) } catch (error) { message = error.message }
print(message)
`)
  assert.equal(value.ok, true, value.output)
  assert.match(value.output, /\{"rows":\d+\}/)
  assert.match(value.output, /wait_until: timed out after \d+ms waiting for the script to return a truthy value; last result: 0/)
  assert.match(value.output, /last result: page script failed: TypeError: cannot read properties of null/)
})

test('wait_for_text, wait_for_gone and wait_for_response wait on the page instead of sleeping', async () => {
  const { run, page } = mount({ onClick: current => {
    current.network.push({ kind: 'fetch', method: 'POST', url: 'https://example.test/api/save', status: 201, sequence: current.network.length + 1 })
  } })
  setTimeout(() => { page.text = 'Results ready' }, 300)
  const value = await run(`
await goto_url('https://example.test/')
print(await wait_for_text('Results ready', 5000))
let gone = ''
try { await wait_for_gone('Results ready', 1000) } catch (error) { gone = error.message }
print(gone)
const entry = await wait_for_response('/api/save', () => click('Save'), { timeoutMs: 3000 })
print(entry.status)
`)
  assert.equal(value.ok, true, value.output)
  assert.match(value.output, /true\nwait_for_gone: timed out waiting for "Results ready" to be gone\n201/)
})

test('poll never sleeps past its budget, even with a longer interval', async () => {
  let checks = 0
  const started = Date.now()
  assert.equal(await poll(async () => { checks += 1; return undefined }, 150, 5_000), undefined)
  assert.ok(Date.now() - started < 1_000, 'the last pause is cut to the time left')
  assert.equal(checks, 2, 'one check at the start and one at the deadline')
})

test('formatDataSources stays compact and says when there is nothing to use', () => {
  assert.match(formatDataSources({ url: 'https://a.test/', embedded: [], apis: [], resources: [], declared: [] }), /No embedded state.*read the DOM/)
  const text = formatDataSources({
    url: 'https://a.test/',
    embedded: [{ name: '#__NEXT_DATA__', bytes: 48_000, keys: ['props', 'page'], arrays: [{ path: 'props.pageProps.stores', length: 120 }] }],
    apis: [{ method: 'GET', url: 'https://a.test/api/stores?page=2', status: 200, type: 'application/json', calls: 3 }],
    resources: [{ url: 'https://a.test/locations.json', initiator: 'fetch', bytes: 900 }],
    declared: [{ from: 'data-api', url: '/api/v2/stores' }],
  })
  assert.equal(text, [
    'Embedded state:',
    '  #__NEXT_DATA__ 46.9 KB keys: props, page; arrays: props.pageProps.stores (120)',
    'APIs the page called:',
    '  GET 200 application/json \u00d73 https://a.test/api/stores?page=2',
    'Data-like resources (resource timing, includes requests before the probe):',
    '  fetch 900 B https://a.test/locations.json',
    'Declared endpoints:',
    '  data-api /api/v2/stores',
  ].join('\n'))
})

test('Chromium: data sources, the page pulse and same-origin fetches on a real page', {
  skip: !process.env.DSH_TEST_CHROME && 'set DSH_TEST_CHROME to a Chromium executable',
}, async t => {
  const stores = Array.from({ length: 30 }, (_, i) => ({ id: i, name: `Store ${i}`, city: 'Springfield' }))
  const page = `<!doctype html><html><head><title>Store finder</title>
    <link rel="preload" as="fetch" href="/api/regions.json" crossorigin>
    <script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { stores, total: 30 } }, page: '/stores' })}</script>
    <script type="application/ld+json">${JSON.stringify({ '@type': 'Organization', name: 'Shop' })}</script>
    <script>window.__INITIAL_STATE__ = { cart: { items: [1, 2, 3, 4] }, user: null }; fetch('/api/stores.json').then(r => r.json()).then(() => { window.firstScreen = true })</script>
    </head><body><div data-api="/api/v2/stores"></div><p role="alert">Location access denied</p><p role="alert" style="display:none">hidden alert</p></body></html>`
  const server = createServer((request, response) => {
    if (request.url === '/api/stores.json') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(stores)); return }
    if (request.url.startsWith('/api/search')) { response.setHeader('content-type', 'application/json; charset=utf-8'); response.end('{"hits":[]}'); return }
    if (request.url === '/api/regions.json') { response.setHeader('content-type', 'application/json'); response.end('[]'); return }
    if (request.url === '/api/private') { response.statusCode = 403; response.end(request.headers.cookie === 'sid=abc' ? 'forbidden for sid' : 'no cookie'); return }
    if (request.url === '/v2/me') { response.setHeader('content-type', 'application/json'); response.end('{"base":true}'); return }
    if (request.url === '/api/me') { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ cookie: request.headers.cookie ?? null })); return }
    response.setHeader('content-type', 'text/html')
    response.end(page)
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const chrome = await chromiumPage(t)
  await chrome.navigate(`http://127.0.0.1:${server.address().port}/`)
  await chrome.evaluate(`new Promise(resolve => { const tick = () => window.firstScreen ? resolve() : setTimeout(tick, 20); tick() })`)

  const pulse = JSON.parse(await chrome.evaluate(pageOperationScript({ operation: 'pulse' })))
  assert.deepEqual(pulse, { title: 'Store finder', alerts: ['Location access denied'], dialogs: [], probe: 0 }, 'the pulse reads the page without installing the probe')
  assert.equal(await chrome.evaluate('typeof globalThis.__dshProbe'), 'undefined')

  await chrome.evaluate(PROBE_INSTALL_SCRIPT)
  const longQuery = `/api/search?q=a&filter=${'x'.repeat(200)}`
  await chrome.evaluate(`fetch('/api/search?q=a').then(r => r.text()).then(() => fetch(${JSON.stringify(longQuery)})).then(r => r.text())`)
  const found = JSON.parse(await chrome.evaluate(probeCallScript('dataSources')))
  const next = found.embedded.find(row => row.name === '#__NEXT_DATA__')
  assert.deepEqual(next.keys, ['props', 'page'])
  assert.deepEqual(next.arrays[0], { path: 'props.pageProps.stores', length: 30 })
  assert.ok(next.bytes > 1000)
  assert.ok(found.embedded.some(row => row.name === 'script[type="application/ld+json"][0]'))
  assert.deepEqual(found.embedded.find(row => row.name === 'window.__INITIAL_STATE__')?.arrays, [{ path: 'cart.items', length: 4 }])
  assert.deepEqual(found.apis.map(row => [row.method, row.status, row.type, row.json]), [['GET', 200, 'application/json', true]])
  assert.ok(found.apis[0].url.endsWith(longQuery), 'a discovered URL comes back whole, so it can be fetched as is')
  assert.equal(found.apis[0].calls, 2)
  assert.ok(found.resources.some(row => row.url.endsWith('/api/stores.json')), `first-screen JSON is found through resource timing: ${JSON.stringify(found.resources)}`)
  assert.ok(found.declared.some(row => row.from === 'data-api' && row.url === '/api/v2/stores'))
  assert.ok(found.declared.some(row => row.from.startsWith('link[rel=preload') && row.url.endsWith('/api/regions.json')))
  assert.ok(formatDataSources(found).length < 2048, formatDataSources(found))

  await chrome.evaluate(`document.cookie = 'sid=abc'`)
  const me = JSON.parse(await chrome.evaluate(pageOperationScript({ operation: 'fetch', url: '/api/me', init: {} })))
  assert.equal(me.ok, true)
  assert.deepEqual(JSON.parse(me.body), { cookie: 'sid=abc' }, 'the fetch carries the page cookies')
  const denied = JSON.parse(await chrome.evaluate(pageOperationScript({ operation: 'fetch', url: '/api/private', init: {} })))
  assert.deepEqual([denied.ok, denied.status, denied.body], [false, 403, 'forbidden for sid'])
  await chrome.evaluate(`document.head.append(Object.assign(document.createElement('base'), { href: '/v2/' }))`)
  const based = JSON.parse(await chrome.evaluate(pageOperationScript({ operation: 'fetch', url: 'me', init: {} })))
  assert.deepEqual([based.ok, based.body], [true, '{"base":true}'], 'relative URLs resolve against <base href> as the page\'s own fetch does')
})
