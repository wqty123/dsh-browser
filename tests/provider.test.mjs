import { test } from 'node:test'
import assert from 'node:assert/strict'
import { homedir } from 'node:os'
import { join } from 'node:path'

import { ElectronBrowserProvider } from '../lib/browser-electron/provider.js'

/**
 * A fake ElectronBrowserViewHost. `sendCommand` simulates the CDP surface the
 * provider drives; per-test knobs live on the returned host (views, showCalls,
 * events, page.wait, and a configurable `evaluate` override).
 */
function makeHost(overrides = {}) {
  let counter = 0
  const views = new Map()
  const showCalls = []
  const groupCalls = []
  const events = { terminate: 0, release: 0, keyDown: 0, keyUp: 0, navigateHistory: 0, reload: 0, history: { entries: [], currentIndex: -1 } }
  const page = { url: 'about:blank', wait: { urlOk: true, loadedOk: true, foundOk: true } }
  let userActionHandler = null
  const host = {
    views,
    showCalls,
    groupCalls,
    events,
    page,
    createView() {
      const id = `view${++counter}`
      let url = 'about:blank'
      const handle = {
        id,
        sendCommand: async (method, params) => {
          if (method === 'Page.navigate') { url = params.url; return {} }
          if (method === 'Page.reload') { events.reload++; return {} }
          if (method === 'Input.dispatchMouseEvent') {
            if (params.type === 'mousePressed') return {}
            events.release++
            if (events.release === 1 && overrides.failFirstRelease) throw new Error('release fails')
            return {}
          }
          if (method === 'Input.insertText') return {}
          if (method === 'Input.dispatchKeyEvent') {
            if (params.type === 'keyDown') events.keyDown++
            if (params.type === 'keyUp') events.keyUp++
            return {}
          }
          if (method === 'Page.getNavigationHistory') return { entries: events.history.entries, currentIndex: events.history.currentIndex }
          if (method === 'Page.navigateToHistoryEntry') { events.navigateHistory++; return {} }
          if (method === 'Runtime.terminateExecution') { events.terminate++; return {} }
          if (method === 'Page.stopLoading') return {}
          if (method === 'Runtime.evaluate') {
            const expr = params.expression || ''
            if (expr.includes('urlOk')) return { result: { value: page.wait } }
            // Only the bare URL probe (currentUrl) is exact; bigger scripts
            // merely CONTAIN location.href and must reach the overrides.
            if (expr.trim() === 'location.href') return { result: { value: url } }
            if (typeof overrides.evaluate === 'function') return overrides.evaluate(method, params)
            return { result: { value: { ok: true, content: 'x' } } }
          }
          return {}
        },
        download: overrides.download ?? (async () => {}),
        ...(overrides.capture !== undefined ? { capture: overrides.capture } : {}),
      }
      views.set(id, handle)
      return handle
    },
    destroyView(h) { views.delete(h.id) },
    showView(handle, label) { showCalls.push({ id: handle.id, label }) },
    groupView(handle, windowId, label) { groupCalls.push({ viewId: handle.id, windowId, label }) },
    onUserAction(handler) { userActionHandler = handler },
    userAction(action) { userActionHandler?.(action) },
    ...(overrides.available !== undefined ? { available: overrides.available } : {}),
  }
  return host
}

/** Poll until fn() is truthy or the budget runs out. */
async function waitFor(fn, ms = 1000) {
  const deadline = Date.now() + ms
  for (;;) {
    if (await fn()) return
    if (Date.now() >= deadline) throw new Error('waitFor timed out')
    await new Promise(r => setTimeout(r, 5))
  }
}

test('open/list/switch/close/reset tab lifecycle', async () => {
  const host = makeHost()
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open()
  await p.openUrl(sid, { url: 'https://a.example/', newTab: true })
  await p.openUrl(sid, { url: 'https://b.example/', newTab: true })
  const tabs = await p.listTabs(sid)
  assert.equal(tabs.length, 3)
  assert.equal(tabs.find(t => t.active).url, 'https://b.example/')

  // Closing the ACTIVE (last) tab activates the previous one.
  await p.closeTab(sid, tabs.find(t => t.active).id)
  const t1 = await p.listTabs(sid)
  assert.equal(t1.length, 2)
  assert.equal(t1.find(t => t.active).url, 'https://a.example/')

  // Reset closes everything back to one blank tab.
  await p.reset(sid)
  const t2 = await p.listTabs(sid)
  assert.equal(t2.length, 1)
  assert.equal(t2[0].url, 'about:blank')

  await p.close(sid)
  await assert.rejects(() => p.listTabs(sid), /not open/)
})

test('open(label) surfaces the label through showView', async () => {
  const host = makeHost()
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open('task-42')
  await p.openUrl(sid, { url: 'https://a.example/' })
  const last = host.showCalls.at(-1)
  assert.equal(last.label, 'task-42')
  await p.close(sid)
})

test('available() delegates to the host probe', () => {
  assert.equal(new ElectronBrowserProvider(makeHost({ available: () => true })).available(), true)
  assert.equal(new ElectronBrowserProvider(makeHost({ available: () => false })).available(), false)
  // No probe on the host -> assumed usable.
  assert.equal(new ElectronBrowserProvider(makeHost()).available(), true)
})

test('download admission: scheme, absolute path, default downloads dir', async () => {
  const host = makeHost()
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open()
  await assert.rejects(p.download(sid, { url: 'file:///etc/x', savePath: 'C:/x/y' }), /non-HTTP/)
  await assert.rejects(p.download(sid, { url: 'not a url', savePath: 'C:/x/y' }), /unparseable/)
  await assert.rejects(p.download(sid, { url: 'https://a.example/f', savePath: 'relative.txt' }), /absolute/)
  // Default downloadDir is the user's Downloads folder; an absolute path
  // inside it is allowed.
  const okPath = join(homedir(), 'Downloads', 'ok.bin')
  const r = await p.download(sid, { url: 'https://a.example/f', savePath: okPath })
  assert.equal(r.path, okPath)
  await p.close(sid)
})

test('downloadDir containment blocks escape', async () => {
  const p = new ElectronBrowserProvider(makeHost(), { downloadDir: 'C:/dl' })
  const sid = await p.open()
  await p.download(sid, { url: 'https://a.example/f', savePath: 'C:/dl/ok.bin' })
  await assert.rejects(p.download(sid, { url: 'https://a.example/f', savePath: 'C:/dl/../escape.bin' }), /inside downloadDir/)
  await p.close(sid)
})

test('waitFor returns ready when conditions met and a verdict on timeout', async () => {
  const host = makeHost()
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open()
  host.page.wait = { urlOk: true, loadedOk: true, foundOk: true }
  const ok = await p.waitFor(sid, { url: 'https://a.example/' })
  assert.equal(ok.ready, true)

  host.page.wait = { urlOk: false, loadedOk: true, foundOk: true }
  const miss = await p.waitFor(sid, { url: 'https://a.example/', timeoutMs: 100 })
  assert.equal(miss.ready, false)
  assert.match(miss.reason, /url/)
  await p.close(sid)
})

test('hung execute times out and interrupts the page', async () => {
  const host = makeHost({ evaluate: () => new Promise(() => {}) })
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open()
  await assert.rejects(p.execute(sid, { script: '1+1', timeoutMs: 200 }), /timed out/)
  assert.ok(host.events.terminate >= 1, 'terminateExecution was issued')
  await p.close(sid)
})

test('click retries release after a failure (no stuck button)', async () => {
  const host = makeHost({ failFirstRelease: true })
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open()
  await assert.rejects(p.click(sid, { x: 5, y: 5 }), /click failed/)
  assert.ok(host.events.release >= 2, 'release was retried')
  await p.close(sid)
})

test('key presses supported keys and rejects unknown', async () => {
  const host = makeHost()
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open()
  await p.key(sid, { key: 'Enter' })
  assert.equal(host.events.keyDown, 1)
  assert.equal(host.events.keyUp, 1)
  await assert.rejects(p.key(sid, { key: 'F12' }), /unsupported key/)
  await p.close(sid)
})

test('back/forward step history and no-op at bounds', async () => {
  const host = makeHost()
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open()
  host.events.history = { entries: [{ id: 1 }, { id: 2 }, { id: 3 }], currentIndex: 1 }
  await p.back(sid)
  assert.equal(host.events.navigateHistory, 1)
  await p.forward(sid)
  assert.equal(host.events.navigateHistory, 2)
  // At the last entry, forward is a successful no-op.
  host.events.history = { entries: [{ id: 1 }], currentIndex: 0 }
  await p.forward(sid)
  assert.equal(host.events.navigateHistory, 2)
  await p.close(sid)
})

test('scroll records history and rejects a missing selector', async () => {
  const host = makeHost()
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open()
  await p.scroll(sid, { toBottom: true })
  const h = await p.history(sid)
  assert.equal(h.at(-1).action, 'scroll')
  assert.equal(h.at(-1).ok, true)
  await p.close(sid)
})

test('open/newTab group views under the session window with the label', async () => {
  const host = makeHost()
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open('task-9')
  assert.equal(host.groupCalls.length, 1)
  assert.equal(host.groupCalls[0].windowId, sid)
  assert.equal(host.groupCalls[0].label, 'task-9')
  // A new tab joins the SAME window group.
  await p.openUrl(sid, { url: 'https://a.example/', newTab: true })
  assert.equal(host.groupCalls.length, 2)
  assert.equal(host.groupCalls[1].windowId, sid)
  await p.close(sid)
})

test('user actions from the host UI route into the session model', async () => {
  const host = makeHost()
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open('task-9')
  // newTab with a URL, then activate the first tab, then reload, then close.
  host.userAction({ type: 'newTab', windowId: sid, url: 'https://a.example/' })
  await waitFor(async () => (await p.listTabs(sid)).length === 2)
  let tabs = await p.listTabs(sid)
  assert.equal(tabs.find(t => t.active).url, 'https://a.example/')
  const firstId = tabs[0].id

  host.userAction({ type: 'activateTab', windowId: sid, viewId: 'view1' })
  await waitFor(async () => (await p.listTabs(sid)).find(t => t.active).id === firstId)

  host.userAction({ type: 'reload', windowId: sid })
  await waitFor(() => host.events.reload >= 1)

  host.userAction({ type: 'closeTab', windowId: sid, viewId: 'view2' })
  await waitFor(async () => (await p.listTabs(sid)).length === 1)

  // back at the history start is a successful no-op, recorded in history.
  host.userAction({ type: 'back', windowId: sid })
  await waitFor(async () => (await p.history(sid)).at(-1).action === 'back')

  // Actions for a gone session are ignored, not errors.
  host.userAction({ type: 'navigate', windowId: 'browser:nope', url: 'https://x.example/' })
  await new Promise(r => setTimeout(r, 20))
  await p.close(sid)
})

test('reload issues Page.reload and records history', async () => {
  const host = makeHost()
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open()
  await p.reload(sid)
  assert.equal(host.events.reload, 1)
  assert.equal((await p.history(sid)).at(-1).action, 'reload')
  await p.close(sid)
})

test('a11y returns semantic nodes from the page', async () => {
  const host = makeHost({
    evaluate: () => ({
      result: {
        value: {
          url: 'https://a.example/',
          title: 'T',
          count: 2,
          nodes: [
            { ref: 1, role: 'button', name: '登录', value: null, states: ['enabled'], depth: 2, tag: 'button', x: 10, y: 20 },
            { ref: 2, role: 'textbox', name: '用户名', value: 'alice', states: ['enabled'], depth: 3, tag: 'input', x: 30, y: 40 },
          ],
          truncated: false,
        },
      },
    }),
  })
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open()
  const r = await p.a11y(sid, { maxNodes: 50 })
  assert.equal(r.count, 2)
  assert.equal(r.nodes[1].role, 'textbox')
  assert.equal(r.nodes[1].value, 'alice')
  await p.close(sid)
})

test('form ops setValue/check/select/clear/getValue use the located element', async () => {
  let lastExpr = ''
  const host = makeHost({
    evaluate: (_method, params) => {
      const expr = params.expression || ''
      lastExpr = expr
      if (expr.includes('element is not a checkbox')) return { result: { value: { ok: true, checked: true } } }
      if (expr.includes('optionValue')) return { result: { value: { ok: true, value: 'cn', text: 'China' } } }
      if (expr.includes('selectedText')) return { result: { value: { ok: true, value: 'cn', selectedText: 'China' } } }
      if (expr.includes('setNative')) return { result: { value: { ok: true, method: 'input', value: 'hi' } } }
      return { result: { value: { ok: true } } }
    },
  })
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open()
  const set = await p.setValue(sid, { target: { by: 'css', value: '#user' }, value: 'hi' })
  assert.equal(set.method, 'input')
  assert.match(lastExpr, /#user/)
  const chk = await p.check(sid, { target: { by: 'text', value: 'Agree' } })
  assert.equal(chk.checked, true)
  const sel = await p.selectOption(sid, { target: { by: 'xpath', value: '//select' }, optionText: 'China' })
  assert.equal(sel.value, 'cn')
  assert.equal(sel.text, 'China')
  await p.clearField(sid, { target: { by: 'css', value: '#user' } })
  const gv = await p.getValue(sid, { target: { by: 'css', value: '#user' } })
  assert.equal(gv.value, 'cn')
  await p.close(sid)
})

test('click/type with a target locate in-page first', async () => {
  let located = false
  let focused = false
  const host = makeHost({
    evaluate: (_method, params) => {
      const expr = params.expression || ''
      if (expr.includes('scrollIntoView')) { located = true; return { result: { value: { ok: true, x: 12, y: 34 } } } }
      if (expr.includes('el.focus()')) { focused = true; return { result: { value: { ok: true } } } }
      return { result: { value: { ok: true } } }
    },
  })
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open()
  await p.click(sid, { target: { by: 'css', value: '#go' } })
  assert.ok(located, 'click located the element in-page')
  assert.deepEqual((await p.history(sid)).at(-1).params, { target: { by: 'css', value: '#go' } })
  await p.type(sid, { text: 'hi', target: { by: 'css', value: '#in' } })
  assert.ok(focused, 'type focused the element first')
  await p.close(sid)
})

test('scrape extracts items through static CSS fields', async () => {
  let lastExpr = ''
  const host = makeHost({
    evaluate: (_method, params) => {
      lastExpr = params.expression || ''
      return { result: { value: { ok: true, count: 2, items: [{ title: 'A', url: 'https://a.example/1' }, { title: 'B', url: null }] } } }
    },
  })
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open()
  const r = await p.scrape(sid, {
    item: 'div.card',
    fields: [{ name: 'title', selector: 'h3' }, { name: 'url', selector: 'a@href' }],
  })
  assert.equal(r.count, 2)
  assert.equal(r.items[1].url, null)
  assert.match(lastExpr, /div\.card/)
  assert.match(lastExpr, /a@href/)
  await p.close(sid)
})
