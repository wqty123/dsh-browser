/**
 * The desktop sidebar's bridge gives each CDP command 15 s and then refuses the guest until its page is
 * reopened, because a renderer command cannot be cancelled. scrape and the target tools used to poll their
 * whole caller budget inside ONE Runtime.evaluate, so `dsh_browser_scrape {timeoutMs: 15000}` on a Baidu
 * results page that never matched held the evaluate past the limit on a healthy page and wedged the guest.
 * These tests run the provider's real in-page scripts on a virtual clock and measure how long each
 * evaluate holds the page.
 */
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { ElectronBrowserProvider } from '../lib/browser-electron/provider.js'
import { PAGE_POLL_SLICE_MS, TARGET_SCRIPT_GRACE_MS } from '../lib/browser-electron/provider-core.js'

const bridgeLimit = Number(/const CDP_COMMAND_TIMEOUT_MS = ([\d_]+)/
  .exec(readFileSync(new URL('../desktop-bridge/plugin-browser-bridge.js', import.meta.url), 'utf8'))[1].replaceAll('_', ''))

/** A sidebar view whose page answers in-page scripts on the mocked clock; `items(now)` is what it lists. */
function sidebar(items) {
  const held = []
  const later = []
  const context = vm.createContext({
    Date,
    // Sleeping in the page moves the virtual clock; the host's own budgets keep real time.
    setTimeout: (fn, ms) => { mock.timers.tick(ms); setImmediate(fn) },
    URL,
    Node: { TEXT_NODE: 3 },
    HTMLElement: class HTMLElement {},
    Element: class Element {},
    document: { querySelector: () => null, querySelectorAll: selector => selector === '*' ? [] : items(Date.now()) },
  })
  let counter = 0
  const host = {
    createView(identity) {
      const id = identity ?? `view${++counter}`
      return {
        id,
        sendCommand: async (method, params) => {
          if (method === 'Page.getFrameTree') return { frameTree: { frame: { id, loaderId: '1', url: 'https://www.baidu.com/s?wd=x' } } }
          if (method === 'Page.createIsolatedWorld') return { executionContextId: 1 }
          if (method !== 'Runtime.evaluate') return {}
          const expression = String(params.expression ?? '')
          if (!expression.includes('const itemSel') && !expression.includes('const spec =')) { later.push(expression); return { result: { value: { ok: true, url: 'https://www.baidu.com/s?wd=x', title: 'x' } } } }
          const started = Date.now()
          const value = await vm.runInContext(expression, context)
          held.push(Date.now() - started)
          return { result: { value } }
        },
      }
    },
    destroyView() {},
    showView() {},
    onUserAction() {},
  }
  return { host, held, later }
}

const row = title => ({ querySelector: selector => selector === 'h3 a' ? { textContent: title, getAttribute: () => null, tagName: 'A' } : null })

test('a 15 s scrape that never matches is polled in slices that each answer inside the bridge command limit', async t => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  t.after(() => mock.timers.reset())
  assert.ok(PAGE_POLL_SLICE_MS + TARGET_SCRIPT_GRACE_MS < bridgeLimit, 'a slice and its grace must fit the bridge limit')
  const { host, held } = sidebar(() => [])
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open()
  const started = Date.now()
  await assert.rejects(
    () => p.scrape(sid, { item: '#content_left .no-such-result', fields: [{ name: 'title', selector: 'h3 a' }], timeoutMs: 15_000 }),
    /no elements matched: #content_left \.no-such-result/,
  )
  assert.ok(Date.now() - started >= 15_000, 'the whole caller budget is still polled')
  assert.ok(held.length >= 5, `polled in slices, got ${held.length}`)
  for (const ms of held) assert.ok(ms < bridgeLimit - TARGET_SCRIPT_GRACE_MS, `one evaluate held the page ${ms}ms`)
  await p.close(sid)
})

test('a scrape whose results arrive late in a long budget still returns them', async t => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  t.after(() => mock.timers.reset())
  const ready = Date.now() + 9_000
  const { host, held } = sidebar(now => now >= ready ? [row('DeepSeek Harness')] : [])
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open()
  const result = await p.scrape(sid, { item: '.result', fields: [{ name: 'title', selector: 'h3 a' }], timeoutMs: 20_000 })
  assert.deepEqual(JSON.parse(JSON.stringify(result.items)), [{ title: 'DeepSeek Harness' }])
  assert.ok(held.length > 1 && held.every(ms => ms <= PAGE_POLL_SLICE_MS + 100))
  await p.close(sid)
})

test('a target tool with a long budget locates in slices and reports the miss with the caller budget', async t => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  t.after(() => mock.timers.reset())
  const { host, held } = sidebar(() => [])
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open()
  await assert.rejects(
    () => p.getValue(sid, { target: { by: 'css', value: '#chat-textarea' }, timeoutMs: 16_000 }),
    error => /element not found/.test(error.message) && /looked for 16000ms/.test(error.message),
  )
  assert.ok(held.length >= 5)
  for (const ms of held) assert.ok(ms < bridgeLimit - TARGET_SCRIPT_GRACE_MS, `one evaluate held the page ${ms}ms`)
  await p.close(sid)
})

test('a slice queued behind other commands on the same page is not timed out before the caller budget', async t => {
  mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  t.after(() => mock.timers.reset())
  const { host } = sidebar(() => [row('DeepSeek Harness')])
  const createView = host.createView
  host.createView = identity => {
    const view = createView(identity)
    const send = view.sendCommand
    let queued = true
    view.sendCommand = async (method, params) => {
      if (method === 'Runtime.evaluate' && String(params.expression ?? '').includes('const itemSel') && queued) {
        queued = false
        await new Promise(resolve => setTimeout(resolve, PAGE_POLL_SLICE_MS + TARGET_SCRIPT_GRACE_MS + 500))
      }
      return await send(method, params)
    }
    return view
  }
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open()
  const result = await p.scrape(sid, { item: '.result', fields: [{ name: 'title', selector: 'h3 a' }], timeoutMs: 15_000 })
  assert.equal(result.count, 1)
  await p.close(sid)
})
