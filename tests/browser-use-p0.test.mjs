// Browser Use P0 on the code surface: post-action summaries, wait_for_new_tab, with_tab,
// annotated screenshots, and lookups that reach open shadow roots and same-origin iframes.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'

import { apply } from '../lib/tool-browser/index.js'
import { actionSummary } from '../lib/tool-browser/code-tool.js'
import { DEEP_DOM_SOURCE } from '../src/browser/deep-dom.ts'
import { ANNOTATE_SCRIPT, CLEAR_ANNOTATIONS_SCRIPT } from '../src/tool-browser/screenshot-annotations.ts'
import { PROBE_INSTALL_SCRIPT, probeCallScript } from '../src/tool-browser/page-probe.ts'
import { chromiumPage } from './fixtures/chromium-page.mjs'

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==', 'base64')

function mount({ surface, tabs = [{ id: 'tab-main', url: 'https://example.test/', active: true }], onClick, rows = [] } = {}) {
  const tools = new Map()
  const calls = []
  const disposers = []
  after(() => { for (const dispose of disposers) dispose?.() })
  const activate = id => { for (const tab of tabs) tab.active = tab.id === id }
  const browser = {
    open: async () => 'session-1',
    openPanel: async () => 'session-1',
    exists: () => true,
    close: async () => {},
    openUrl: async (_session, request) => { calls.push(['openUrl', request.url]); tabs.find(tab => tab.active).url = request.url },
    listTabs: async () => tabs.map(tab => ({ ...tab })),
    switchTab: async (_session, wire) => {
      calls.push(['switchTab'])
      const tab = tabs.find(t => decodeURIComponent(wire).includes(t.id))
      if (tab === undefined) throw new Error('unknown tab')
      activate(tab.id)
    },
    click: async () => { calls.push(['click']); onClick?.(tabs); return { clicked: true } },
    snapshot: async () => ({ url: 'https://example.test/', title: 'Example', truncated: false, elements: [] }),
    execute: async (_session, request) => {
      if (request.script === ANNOTATE_SCRIPT) { calls.push(['annotate']); return { ok: true, value: rows } }
      if (request.script === CLEAR_ANNOTATIONS_SCRIPT) { calls.push(['clear']); return { ok: true, value: true } }
      return { ok: true, value: JSON.stringify({}) }
    },
    screenshot: async () => { calls.push(['capture']); return { dataUrl: `data:image/png;base64,${png.toString('base64')}`, width: 1, height: 1 } },
  }
  apply({
    tools: { register: tool => { tools.set(tool.name, tool) } },
    systemPrompt: { section() {} },
    effect: fn => { disposers.push(fn()) },
    get: name => name === 'browser' ? browser : undefined,
    llm: { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) },
    attachments: { saveImage: async () => ({ attachmentId: 'image-1', mediaType: 'image/png', bytes: png.length, width: 1, height: 1 }) },
  }, surface === undefined ? {} : { surface })
  const exec = { agent: { id: 'p0-owner', model: { current: () => ({ provider: 'test', model: 'vision' }) } } }
  const run = code => tools.get('dsh_browser_code').execute({ code }, exec)
  return { tools, calls, tabs, run, exec }
}

test('actionSummary names navigation, new and closed tabs, and the active tab', () => {
  const a = { id: 'a', url: 'https://a.test/', active: true }
  assert.equal(actionSummary(undefined, [a]), '\u2192 on https://a.test/')
  assert.equal(actionSummary([a], [a]), '\u2192 still on https://a.test/')
  assert.equal(actionSummary([a], [{ ...a, url: 'https://a.test/next' }]), '\u2192 navigated to https://a.test/next')
  assert.equal(actionSummary([a], [a, { id: 'b', url: '', active: false }]), '\u2192 new tab b about:blank')
  assert.equal(actionSummary([a, { id: 'b', url: 'https://b.test/', active: false }], [{ ...a, active: false }, { id: 'b', url: 'https://b.test/', active: true }]),
    '\u2192 active tab b https://b.test/')
  assert.equal(actionSummary([a, { id: 'b', url: 'https://b.test/', active: false }], [a]), '\u2192 closed tab b')
})

test('every action in a cell ends with where the browser is now; reads do not', async () => {
  const { run } = mount()
  const value = await run(`
print(await goto_url('https://example.test/'))
print(await goto_url('https://example.test/next'))
print(await click('Nothing'))
print(JSON.stringify(await list_tabs()))
`)
  assert.equal(value.ok, true, value.output)
  assert.match(value.output, /\u2192 on https:\/\/example\.test\/\n/, 'the first open has no before-state yet')
  assert.match(value.output, /\u2192 navigated to https:\/\/example\.test\/next/)
  assert.match(value.output, /\u2192 still on https:\/\/example\.test\/next/)
  assert.equal(value.output.match(/\u2192/g).length, 3)
})

test('wait_for_new_tab runs its trigger and returns the tab it opened; with_tab switches there and back', async () => {
  const { run, tabs } = mount({ onClick: tabs => tabs.push({ id: 'tab-report', url: 'https://example.test/report', active: false }) })
  const value = await run(`
await goto_url('https://example.test/')
const tab = await wait_for_new_tab(() => click('Open report'), 2000)
print(tab.url)
print(await with_tab(tab.id, async () => (await list_tabs()).tabs.find(t => t.active).url))
print((await list_tabs()).tabs.find(t => t.active).url)
`)
  assert.equal(value.ok, true, value.output)
  assert.deepEqual(value.output.trim().split('\n'), ['https://example.test/report', 'https://example.test/report', 'https://example.test/'])
  assert.equal(tabs.find(t => t.active).id, 'tab-main')
  assert.ok(value.trace.every(entry => entry.tool !== '__tabs'), 'tab polling stays out of the trace')
})

test('wait_for_new_tab without a trigger catches a tab opened while it waits, and times out otherwise', async () => {
  const { run } = mount({ onClick: tabs => setTimeout(() => tabs.push({ id: 'tab-late', url: 'https://example.test/late', active: false }), 200) })
  const value = await run(`
await goto_url('https://example.test/')
const pending = wait_for_new_tab(3000)
await click('Open later')
print((await pending).url)
let failed
try { await wait_for_new_tab(300) } catch (error) { failed = error.message }
failed
`)
  assert.equal(value.ok, true, value.output)
  assert.match(value.output, /https:\/\/example\.test\/late/)
  assert.match(value.output, /no new tab opened within 300ms/)
})

test('with_tab on the active tab still restores it when fn switches away', async () => {
  const { run, tabs } = mount({ tabs: [{ id: 'tab-main', url: 'https://example.test/', active: true }, { id: 'tab-other', url: 'https://example.test/other', active: false }] })
  const value = await run(`
await goto_url('https://example.test/')
const list = (await list_tabs()).tabs
await with_tab(list.find(t => t.active).id, () => switch_tab(list.find(t => !t.active).id))
`)
  assert.equal(value.ok, true, value.output)
  assert.equal(tabs.find(t => t.active).id, 'tab-main')
})

test('with_tab switches back even when the function throws', async () => {
  const { run, tabs } = mount({ tabs: [{ id: 'tab-main', url: 'https://example.test/', active: true }, { id: 'tab-other', url: 'https://example.test/other', active: false }] })
  const value = await run(`
await goto_url('https://example.test/')
const other = (await list_tabs()).tabs.find(t => !t.active).id
let failed
try { await with_tab(other, async () => { throw new Error('boom') }) } catch (error) { failed = error.message }
failed
`)
  assert.equal(value.ok, true, value.output)
  assert.match(value.output, /boom/)
  assert.equal(tabs.find(t => t.active).id, 'tab-main')
})

test('annotated screenshots draw, capture, clear, and list { id, x, y, role, label }', async () => {
  const rows = [{ id: 1, x: 40, y: 20, role: 'button', label: 'Sign in' }, { id: 2, x: 90, y: 60, role: 'textbox', label: '' }]
  const { tools, calls, exec } = mount({ surface: 'tools', rows })
  const tool = tools.get('dsh_browser_screenshot')
  await tools.get('dsh_browser_open').execute({ url: 'https://example.test/' }, exec)
  const value = await tool.execute({ annotate: true }, exec)
  assert.deepEqual(value.elements, rows)
  assert.deepEqual(calls.filter(([name]) => ['annotate', 'capture', 'clear'].includes(name)).map(([name]) => name), ['annotate', 'capture', 'clear'])
  const text = tool.output.render({ annotate: true }, value)[0].text
  assert.match(text, /\[1\] button "Sign in" @ 40,20/)
  assert.match(text, /\[2\] textbox @ 90,60/)
  const plain = await tool.execute({}, exec)
  assert.equal(plain.elements, undefined)
  await assert.rejects(tool.execute({ annotate: true, fullPage: true }, exec), /annotate marks the viewport/)
})

test('Chromium: lookups, find and annotations reach open shadow roots and same-origin iframes', {
  skip: !process.env.DSH_TEST_CHROME && 'set DSH_TEST_CHROME to a Chromium executable',
}, async t => {
  const frame = '<!doctype html><body style="margin:0"><label for="q">Frame query</label><input id="q" placeholder="search here"><p>needle in the frame</p><button style="margin-top:600px">Clipped below</button></body>'
  const page = `<!doctype html><body style="margin:0">
    <div id="host"></div>
    <input id="pw" type="password" value="hunter2-secret" style="position:absolute;left:600px;top:10px">
    <iframe id="f" style="position:absolute;left:100px;top:200px;width:400px;height:200px;border:0" src="/frame"></iframe>
    <script>
      const root = document.getElementById('host').attachShadow({ mode: 'open' })
      root.innerHTML = '<button id="deep" style="width:120px;height:30px">Shadow save</button><p>needle in the shadow</p>'
    </script></body>`
  const server = createServer((request, response) => {
    response.setHeader('content-type', 'text/html')
    response.end(request.url === '/frame' ? frame : page)
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  const chrome = await chromiumPage(t)
  await chrome.navigate(`http://127.0.0.1:${server.address().port}/`)
  await chrome.evaluate(`new Promise(resolve => { const f = document.getElementById('f'); if (f.contentDocument && f.contentDocument.readyState === 'complete' && f.contentDocument.getElementById('q')) resolve(); else f.addEventListener('load', () => resolve()) })`)

  const found = await chrome.evaluate(`(() => {${DEEP_DOM_SOURCE}; return [__dshQuery('#deep')?.id, __dshQuery('#q')?.id, __dshQueryAll('button, input').length] })()`)
  assert.deepEqual(found, ['deep', 'q', 4])

  await chrome.evaluate(PROBE_INSTALL_SCRIPT)
  const hits = JSON.parse(await chrome.evaluate(probeCallScript('findText', ['needle', true])))
  assert.equal(hits.length, 2)
  const inFrame = JSON.parse(await chrome.evaluate(probeCallScript('find', [{ css: '#q' }])))
  assert.ok(inFrame.x > 100 && inFrame.y > 200, `iframe offsets are added: ${JSON.stringify(inFrame)}`)

  const rows = await chrome.evaluate(ANNOTATE_SCRIPT)
  const save = rows.find(row => row.label === 'Shadow save')
  const query = rows.find(row => row.label === 'Frame query')
  assert.equal(save?.role, 'button')
  assert.equal(query?.role, 'textbox')
  assert.ok(query.x > 100 && query.y > 200)
  assert.deepEqual(Object.keys(save).sort(), ['id', 'label', 'role', 'x', 'y'])
  assert.ok(!JSON.stringify(rows).includes('hunter2-secret'), 'typed values never become labels')
  assert.equal(rows.find(row => row.label === 'Clipped below'), undefined, 'controls clipped by their iframe are not annotated')
  assert.equal(await chrome.evaluate(`!!document.getElementById('__dsh_annotations__')`), true)
  await chrome.evaluate(CLEAR_ANNOTATIONS_SCRIPT)
  assert.equal(await chrome.evaluate(`!!document.getElementById('__dsh_annotations__')`), false)
})
