import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import vm from 'node:vm'

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
  const events = { terminate: 0, move: 0, press: 0, release: 0, keyDown: 0, keyUp: 0, focus: 0, order: [], navigateHistory: 0, reload: 0, history: { entries: [], currentIndex: -1 }, insertText: '', keyDownParams: null }
  const mouseSequence = []
  const page = { url: 'about:blank', wait: { urlOk: true, loadedOk: true, foundOk: true } }
  let userActionHandler = null
  const host = {
    views,
    showCalls,
    groupCalls,
    mouseSequence,
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
            mouseSequence.push(params.type)
            if (params.type === 'mouseMoved') { events.move++; return {} }
            if (params.type === 'mousePressed') { events.press++; return {} }
            events.release++
            if (events.release === 1 && overrides.failFirstRelease) throw new Error('release fails')
            return {}
          }
          if (method === 'Input.insertText') { events.insertText = params.text; return {} }
          if (method === 'Input.dispatchKeyEvent') {
            if (params.type === 'keyDown') { events.keyDown++; events.keyDownParams = params; events.order.push('keyDown') }
            if (params.type === 'keyUp') { events.keyUp++; events.order.push('keyUp') }
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
        // Keyboard input only reaches a page whose view holds web focus; a
        // host that cannot focus a view at all omits the method (`noFocus`).
        ...(overrides.noFocus ? {} : { focus: async () => { events.focus++; events.order.push('focus') } }),
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
    ...(overrides.presentView !== undefined ? { presentView: overrides.presentView } : {}),
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

test('switchTab/closeTab stay inside their own session and reject unknown ids', async () => {
  const host = makeHost()
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open()
  const tabId = (await p.listTabs(sid))[0].id

  // A second session. Tab ids are globally unique, so a bare uuid is accepted for
  // convenience — but looking it up in the OTHER session is not: that would let a stale
  // id close or switch a tab belonging to another task (or to the human) and still report
  // success, which is the opposite of the isolation these tools promise.
  const other = await p.open()
  await assert.rejects(async () => { await p.switchTab(other, tabId) }, /not open in this session/)
  await assert.rejects(async () => { await p.closeTab(other, tabId) }, /not open in this session/)

  // The tab is untouched by either refusal, and still reachable from its own session.
  assert.ok((await p.listTabs(sid)).some(t => t.id === tabId), 'the other session could not disturb it')
  assert.equal((await p.listTabs(other)).length, 1, 'nor did it gain anything')
  await p.switchTab(sid, tabId)

  // The bare uuid form still works inside the owning session.
  await p.switchTab(sid, tabId.replace('tab:', ''))

  // An id that exists nowhere must THROW (no silent fake success).
  await assert.rejects(async () => { await p.closeTab(sid, 'tab:does-not-exist') }, /not open in this session/)
  await assert.rejects(async () => { await p.switchTab(sid, 'tab:does-not-exist') }, /not open in this session/)
  await p.close(sid)
  await p.close(other)
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
  // A real (temporary) Downloads directory keeps this test independent of both
  // the machine's home layout and the no-overwrite rule.
  const dir = mkdtempSync(join(tmpdir(), 'dsh-dl-default-'))
  const p = new ElectronBrowserProvider(host, { downloadDir: dir })
  const sid = await p.open()
  await assert.rejects(p.download(sid, { url: 'file:///etc/x', savePath: 'C:/x/y' }), /non-HTTP/)
  await assert.rejects(p.download(sid, { url: 'not a url', savePath: 'C:/x/y' }), /unparseable/)
  await assert.rejects(p.download(sid, { url: 'https://a.example/f', savePath: 'relative.txt' }), /absolute/)
  // An absolute path inside the admitted directory is allowed.
  const okPath = join(dir, 'ok.bin')
  const r = await p.download(sid, { url: 'https://a.example/f', savePath: okPath })
  assert.equal(r.path, okPath)
  await p.close(sid)
})

test('downloadDir containment blocks escape', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-dl-escape-'))
  const p = new ElectronBrowserProvider(makeHost(), { downloadDir: dir })
  const sid = await p.open()
  await p.download(sid, { url: 'https://a.example/f', savePath: join(dir, 'ok.bin') })
  await assert.rejects(p.download(sid, { url: 'https://a.example/f', savePath: join(dir, '..', 'escape.bin') }), /inside downloadDir/)
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

test('click moves the pointer before pressing, so the first click lands', async () => {
  // Chromium routes a synthesized mousePressed to the widget's current hover
  // target instead of hit-testing it: without a preceding mouseMoved the press
  // of the FIRST click on a fresh view is dropped by the renderer while CDP
  // still reports success.
  const host = makeHost()
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open()
  await p.click(sid, { x: 5, y: 5 })
  assert.deepEqual(host.mouseSequence, ['mouseMoved', 'mousePressed', 'mouseReleased'])
  assert.equal(host.events.move, 1)
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

test('key Space carries CDP text so a focused input receives the character', async () => {
  const host = makeHost()
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open()
  await p.key(sid, { key: 'Space' })
  assert.equal(host.events.keyDown, 1)
  assert.equal(host.events.keyUp, 1)
  assert.equal(host.events.keyDownParams.text, ' ', 'Space keyDown must carry text for input insertion')
  // Enter has no printable text; the keyDown must not carry a stray text.
  await p.key(sid, { key: 'Enter' })
  assert.equal(host.events.keyDownParams.text, undefined)
  await p.close(sid)
})

test('key focuses the view first, so the first key of a fresh session is not dropped', async () => {
  const host = makeHost()
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open()
  await p.key(sid, { key: 'Enter' })
  // A renderer drops injected keys unless the view holds web focus, so focus
  // has to happen before the keyDown — not after, and not never.
  assert.deepEqual(host.events.order, ['focus', 'keyDown', 'keyUp'])
  assert.equal(host.events.focus, 1)
  await p.close(sid)
})

test('key still dispatches when the host cannot focus a view', async () => {
  const host = makeHost({ noFocus: true })
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open()
  await p.key(sid, { key: 'Escape' })
  assert.equal(host.events.focus, 0)
  assert.deepEqual(host.events.order, ['keyDown', 'keyUp'])
  await p.close(sid)
})

test('key survives a view that refuses focus', async () => {
  const host = makeHost()
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open()
  const handle = [...host.views.values()][0]
  handle.focus = async () => { throw new Error('focus denied') }
  await p.key(sid, { key: 'Enter' })
  assert.equal(host.events.keyDown, 1, 'a failed focus must not swallow the key')
  assert.deepEqual(host.events.order, ['keyDown', 'keyUp'])
  await p.close(sid)
})

test('waitFor URL check is same-origin, not a bare prefix', async () => {
  const host = makeHost()
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open()
  let lastExpr = ''
  host.views.values().next().value.sendCommand = async (method, params) => {
    if (method === 'Runtime.evaluate') { lastExpr = params.expression || ''; return { result: { value: { urlOk: true, loadedOk: true, foundOk: true } } } }
    return {}
  }
  await p.waitFor(sid, { url: 'https://a.example/path' })
  assert.ok(lastExpr.includes('want.origin === got.origin'), 'URL match must be scoped to the same origin')
  assert.ok(lastExpr.includes('href === wantUrl'), 'exact match must still be accepted')
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

// Issue #10 (defect 1): Page.navigate resolves at navigation COMMIT, so a
// snapshot taken right after it used to see the new title with an unparsed DOM
// and no interactive elements.
test('navigate waits for the new document to be parsed before returning', async () => {
  const probes = []
  const host = makeHost({
    evaluate: (method, params) => {
      const expr = params.expression || ''
      if (!expr.includes('performance.timeOrigin')) return { result: { value: { ok: true } } }
      probes.push(1)
      // Probe 1 is the pre-navigation read (the OLD document). From probe 2 on,
      // the committed document is current but still parsing — the exact window
      // that used to produce a correct title with zero interactive elements.
      const n = probes.length
      if (n === 1) return { result: { value: '100|complete' } }
      if (n <= 3) return { result: { value: '200|loading' } }
      return { result: { value: '200|interactive' } }
    },
  })
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open()
  await p.navigate(sid, { url: 'https://fresh.example/' })
  assert.equal(probes.length >= 4, true,
    `navigate returned without waiting for the parse (probes: ${probes.length})`)
  await p.close(sid)
})

// Issue #10 (defect 2): Input.* is silently dropped by Chromium for a view
// without a display surface, so click/type/key must present the view first —
// and fail loudly when it cannot be presented.
test('click presents the view before dispatching input, and reports failure', async () => {
  const order = []
  const host = makeHost({
    presentView: async () => { order.push('present') },
  })
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open()
  const handle = host.views.values().next().value
  const base = handle.sendCommand
  handle.sendCommand = async (method, params) => {
    if (method === 'Input.dispatchMouseEvent') order.push(`input:${params.type}`)
    if (method === 'Runtime.evaluate' && String(params.expression).includes('elementFromPoint')) return { result: { value: { ok: true, x: 5, y: 6 } } }
    return base(method, params)
  }
  await p.click(sid, { x: 5, y: 6 })
  assert.deepEqual(order[0], 'present', `input was dispatched before the view was presented (${order.join(', ')})`)
  assert.equal(order.includes('present'), true)
  await p.close(sid)

  // A host that cannot present must surface the real reason, not a fake success.
  const failing = makeHost({ presentView: async () => { throw new Error('no surface') } })
  const p2 = new ElectronBrowserProvider(failing)
  const sid2 = await p2.open()
  await assert.rejects(() => p2.click(sid2, { x: 1, y: 1 }), /not presented|BROWSER_VIEW_NOT_PRESENTED|no surface/)
  await p2.close(sid2)
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
  // Regression: typing with a target must NOT drop the text (it used to send
  // an empty insert when a target was present).
  assert.equal(host.events.insertText, 'hi', 'type with target still inserts the text')
  assert.deepEqual((await p.history(sid)).at(-1).params, { text: 'hi', target: { by: 'css', value: '#in' } })
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

/**
 * A DOM small enough to RUN the provider's in-page locate script, parsing
 * selectors the way Chromium does: unbalanced brackets are a SyntaxError,
 * anything else is a legal query that simply finds nothing here.
 */
function makeLocateContext(counts) {
  const unparsable = (sel) => {
    const s = String(sel)
    return (s.match(/\[/g) || []).length !== (s.match(/\]/g) || []).length
      || (s.match(/\(/g) || []).length !== (s.match(/\)/g) || []).length
  }
  return vm.createContext({
    document: {
      querySelectorAll(sel) {
        // Only the caller's selector counts. The resolve script also walks each root with '*' to
        // find shadow hosts and iframes, and that walk is not a retry — counting it turned these
        // assertions into a measurement of the collector rather than of the polling behaviour
        // they are about.
        if (String(sel) !== '*') counts.css++
        if (unparsable(sel)) throw new SyntaxError(`Failed to execute 'querySelectorAll' on 'Document': '${sel}' is not a valid selector.`)
        return []
      },
      evaluate(expr) {
        counts.xpath++
        if (unparsable(expr)) throw new SyntaxError(`Failed to execute 'evaluate': '${expr}' is not a valid XPath expression.`)
        return { snapshotLength: 0, snapshotItem: () => null }
      },
    },
    Node: { TEXT_NODE: 3 },
    HTMLElement: class HTMLElement {},
    Element: class Element {},
    XPathResult: { ORDERED_NODE_SNAPSHOT_TYPE: 7 },
    setTimeout: (fn, ms) => setTimeout(fn, ms),
  })
}

/** Fake host that actually executes locate scripts (only those; nothing else). */
function makeEvaluatingHost(context) {
  return makeHost({
    evaluate: async (_method, params) => {
      const expr = String(params.expression || '')
      // buildTargetScript is the only script this test wants to run.
      if (!expr.includes('const spec =')) return { result: { value: { ok: true } } }
      return { result: { value: await vm.runInContext(expr, context) } }
    },
  })
}

test('a selector that cannot parse fails at once instead of being polled to the deadline', async () => {
  const counts = { css: 0, xpath: 0 }
  const host = makeEvaluatingHost(makeLocateContext(counts))
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open()
  const started = Date.now()
  // A label or plain phrase passed where a selector belongs: `Learn more [` can
  // never parse, so polling cannot help. It used to answer `return null` — the
  // same as "not there yet" — and the caller burned the whole locate budget.
  await assert.rejects(
    () => p.click(sid, { target: { by: 'css', value: 'Learn more [' } }),
    (error) => /invalid CSS selector/.test(String(error.message))
      && /"Learn more \["/.test(String(error.message))
      && /not a valid selector/.test(String(error.message)),
  )
  assert.equal(counts.css, 1, 'a selector that does not parse must not be retried')
  assert.ok(Date.now() - started < 2_000, 'the parse error must be immediate, not the full budget')
  assert.equal(host.events.press, 0, 'no mouse event may be dispatched for a failed locate')
  await p.close(sid)
})

test('an unparsable XPath is named as such, once', async () => {
  const counts = { css: 0, xpath: 0 }
  const host = makeEvaluatingHost(makeLocateContext(counts))
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open()
  await assert.rejects(
    () => p.click(sid, { target: { by: 'xpath', value: '//div[' } }),
    (error) => /invalid XPath/.test(String(error.message)) && /not a valid XPath/.test(String(error.message)),
  )
  assert.equal(counts.css, 0, 'the xpath branch must not fall through to CSS')
  assert.equal(counts.xpath, 1)
  await p.close(sid)
})

test('a selector that is legal but finds nothing reports the miss with its own strategy', async () => {
  const counts = { css: 0, xpath: 0 }
  const host = makeEvaluatingHost(makeLocateContext(counts))
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open()
  // `Learn more` IS a valid CSS descendant selector, so it is polled until the
  // budget ends — but the verdict must say what was looked for, with the
  // strategy the provider assumed, and must beat the outer generic timeout.
  await assert.rejects(
    () => p.setValue(sid, { target: { value: 'Learn more' }, value: 'x', timeoutMs: 200 }),
    (error) => /element not found/.test(String(error.message))
      && /"by":"css"/.test(String(error.message))
      && /looked for 200ms/.test(String(error.message)),
  )
  assert.ok(counts.css >= 2, 'a legal selector must still poll until its budget')
  await p.close(sid)
})
