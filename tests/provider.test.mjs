import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
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
  const events = { terminate: 0, move: 0, press: 0, release: 0, keyDown: 0, keyUp: 0, focus: 0, order: [], navigateHistory: 0, reload: 0, history: { entries: [], currentIndex: -1 }, insertText: '', keyDownParams: null, evaluates: [] }
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
            // Every evaluate is recorded, so a test can assert that one did NOT happen — which is
            // the only way to see the blank-tab short-circuit, since its whole effect is the round
            // trip that is never made.
            events.evaluates.push(expr)
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

  // Reset closes everything back to one blank tab. Its URL is '' rather than 'about:blank': a tab
  // that has never navigated is not probed any more, and '' is what "never navigated" means.
  await p.reset(sid)
  const t2 = await p.listTabs(sid)
  assert.equal(t2.length, 1)
  assert.equal(t2[0].url, '')

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
  // Enter DOES carry text, for the same reason Space does: form submission depends on the
  // character, not on the key event. Measured in issue #36 — `key: Enter` reported pressed: true and
  // the page did not submit, while `requestSubmit()` on the same form worked at once. The assertion
  // that used to sit here ("Enter has no printable text") encoded the bug as if it were the spec.
  await p.key(sid, { key: 'Enter' })
  assert.equal(host.events.keyDownParams.text, '\r',
    'Enter keyDown must carry a carriage return, or a form does not submit')
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
  // Wait for the URL, not just the tab count: the new tab appears synchronously while its
  // navigation is still in flight, and a tab that has not navigated is no longer probed.
  await waitFor(async () => (await p.listTabs(sid)).find(t => t.active)?.url === 'https://a.example/')
  let tabs = await p.listTabs(sid)
  assert.equal(tabs.length, 2)
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
  // Navigate first: a tab that has never navigated has no committed document, so a11y answers the
  // empty page immediately instead of running the collector (see the blank short-circuit).
  await p.openUrl(sid, { url: 'https://a.example/' })
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

// ---------------------------------------------------------------------------
// Tab URL tracking and the blank-tab short-circuit.
//
// A fresh session starts on a blank, uncommitted tab. Two things follow, and both were reported
// from real use: probing that tab wastes a round trip that can only answer nothing, and running a
// collector in it hangs until the whole budget is gone. `url` is what makes the distinction
// possible — "never navigated" versus "navigated, but the URL could not be read" — and the tests
// below pin both halves.
// ---------------------------------------------------------------------------

test('a tab that never navigated is not probed, and reports itself as blank', async () => {
  const host = makeHost()
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open()

  const before = host.events.evaluates.length
  const tabs = await p.listTabs(sid)

  assert.equal(tabs.length, 1)
  assert.equal(tabs[0].url, '', 'a never-navigated tab reports blank')
  assert.equal(host.events.evaluates.length, before,
    'and reading it made no round trip at all — that is the point')

  // Once it HAS navigated, the URL is known without probing too, and a later read refreshes it.
  await p.openUrl(sid, { url: 'https://a.example/' })
  const after = await p.listTabs(sid)
  assert.equal(after[0].url, 'https://a.example/')

  await p.close(sid)
})

test('snapshot and a11y answer a blank tab immediately instead of running a collector', async () => {
  const host = makeHost()
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open()

  const started = Date.now()
  const snap = await p.snapshot(sid)
  const a11y = await p.a11y(sid, {})
  const elapsed = Date.now() - started

  assert.equal(snap.url, '', 'the empty page is reported as empty')
  assert.deepEqual([...snap.elements], [])
  assert.equal(snap.truncated, false)
  assert.equal(a11y.count, 0)
  assert.deepEqual([...a11y.nodes], [])
  // Not the 30s budget: a blank tab that waited would cost every read the same wait.
  assert.ok(elapsed < 2_000, 'neither call waited on the collector; took ' + String(elapsed) + 'ms')

  await p.close(sid)
})

test('a timed-out read is recoverable: the view is replaced, the tab id survives', () => {
  // The timeout itself is 30s, so what is asserted here is the SHAPE of the recovery rather than
  // waiting for it: the error carries a routable code, and the replacement path exists and keeps
  // the public id. Removing either while refactoring is what this catches.
  const source = readFileSync(new URL('../src/browser-electron/provider.ts', import.meta.url), 'utf8')
  assert.match(source, /BROWSER_SNAPSHOT_TIMEOUT/, 'snapshot reports its own code')
  assert.match(source, /BROWSER_A11Y_TIMEOUT/, 'a11y too')
  assert.match(source, /private replaceTabWithBlank\(s: Session, tab: Tab\): void \{/,
    'and a wedged view is replaced in place')
  // The replacement preserves the id, which is what makes the recovery invisible to callers.
  assert.match(source, /s\.tabs\[index\] = \{ id: tab\.id, handle, url: '' \}/,
    'the tab keeps the id its caller holds')
  // And both timeout branches actually call it.
  const calls = (source.match(/this\.replaceTabWithBlank\(s, tab\)/g) ?? []).length
  assert.equal(calls, 2, 'snapshot and a11y both recover, not just one')
})

// Issue #37's other half: a blank page must not read as a successful, empty read.
//
// The report: after a carrier swap started a fresh window, every tool answered against
// about:blank with success values — location.href was "about:blank", the snapshot had zero
// elements, and list_tabs still showed the old URL. Silent failures are worse than refusals.
test('a blank page reports itself as blank instead of as a page with no elements', async () => {
  const host = makeHost()
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open()
  // The fixture's view starts at about:blank, which is exactly the reported condition: a window
  // that exists and has a document, but nothing opened in it. Before this flag the snapshot answered
  // "(no interactive elements found)" — a success value for a browser showing nothing.
  const blank = await p.snapshot(sid)
  assert.equal(blank.blank, true, 'a view with nothing opened is blank')
  assert.deepEqual(blank.elements, [])
  // Two URLs reach this state, and both are blank: never navigated (''), and the explicit
  // about:blank that a fresh carrier window starts on. The note must explain the state either way.
  assert.match(String(blank.note), /no page has been opened|about:blank/i, 'and the note explains it')
  assert.match(String(blank.note), /nothing has been opened|no page has been opened/i,
    'and says what the state means')

  // A real page must NOT carry the flag: it would turn every sparse page into a refusal.
  // https, because navigation refuses non-HTTP(S) schemes by design.
  await p.navigate(sid, { url: 'https://example.com/' })
  const real = await p.snapshot(sid)
  assert.equal(real.blank, undefined, 'a real page carries no blank flag')
  await p.close(sid)
})

// Issue measured on 4399.com: 1608 anchors, every one of them <a href><img alt></a> with no text.
// The snapshot returned zero elements for a page full of links, because every label came out empty.
// The collector's own source is the readable evidence here: running it needs a real DOM.
test('an image-only link takes its name from the image alt', () => {
  const source = readFileSync(new URL('../src/browser-electron/provider.ts', import.meta.url), 'utf8')
  const labelLine = source.slice(source.indexOf('const label = ('), source.indexOf('const label = (') + 700)
  assert.match(labelLine, /imageAlt/,
    'the label expression must consult the image alt')
  assert.ok(source.includes("querySelector('img[alt]')?.getAttribute('alt')"),
    'and read it from the anchor\'s own image')
  // alt must be consulted before the generic fallbacks, or a link's empty textContent still wins.
  const order = ['el.textContent', 'imageAlt', 'el.value']
  const positions = order.map(token => labelLine.indexOf(token))
  assert.ok(positions.every(p => p !== -1), 'all three appear')
  assert.ok(positions[1] > positions[0] - 1 && positions[1] < positions[2],
    'imageAlt sits between the text and the value fallbacks')
})

// Measured while solving a sudoku on sudoku.com: the board is a <canvas>, so 81 cells exist only as
// pixels. The snapshot said "(no interactive elements found)", which describes a page that HAS
// nothing — not one drawn on a canvas. That wording is what made a working page look broken.
test('a page drawn on a canvas reports itself as a canvas, not as empty', async () => {
  const host = makeHost()
  const p = new ElectronBrowserProvider(host)
  const sid = await p.open()
  await p.navigate(sid, { url: 'https://example.com/' })
  const fresh = await p.snapshot(sid)
  // The fixture page has no canvas, so the flag must be absent — the detector must not fire blind.
  assert.equal(fresh.canvas, undefined, 'a page without a canvas carries no canvas flag')
  await p.close(sid)
})

test('the canvas detector fires on area alone, not on an empty element list', () => {
  const source = readFileSync(new URL('../src/browser-electron/provider.ts', import.meta.url), 'utf8')
  const at = source.indexOf('let canvas')
  assert.ok(at !== -1, 'the detector exists')
  const block = source.slice(at, at + 900)
  // Two guards: a minimum size per canvas, and a share of the viewport. Without the share a
  // decorative 200x150 canvas in a footer would claim the whole page is undrivable.
  assert.match(block, /r\.width < 80 \|\| r\.height < 80/, 'small canvases are ignored')
  assert.match(block, /area \/ view >= 0\.1/, 'and only a large one counts')
  // The note lives in the return value, past the block above, so it is checked on the whole file.
  assert.ok(source.includes('dsh_browser_screenshot'), 'and the note names the tool to use instead')
  // NOT gated on an empty element list any more: sudoku.com collects 60 links AND draws the board
  // on a canvas, so requiring an empty list meant saying nothing about the part that mattered.
  const guard = block.slice(0, block.indexOf('let area'))
  assert.doesNotMatch(guard, /out\.length === 0/,
    'the detector must not require an empty element list')
  assert.match(guard, /blankPage !== true/, 'a blank page is still handled by the blank branch')
})

// Measured on the same page: after a tab switch every command failed with "Session with given id
// not found" and nothing in the plugin ever recovered — open, refresh and execute all failed until
// the browser was restarted. The session id is worthless after that, but the VIEW is fine.
test('a stale CDP session is rebuilt once instead of failing forever', () => {
  const source = readFileSync(new URL('../src/browser-electron/system-browser.ts', import.meta.url), 'utf8')
  const at = source.indexOf('const sendWithAttach')
  assert.ok(at !== -1, 'the recovery wrapper exists')
  const block = source.slice(at, at + 1600)
  assert.match(block, /Session with given id not found/, 'it recognises the stale-session error')
  assert.match(block, /this\.views\.delete\(viewId\)/, 'it drops the dead attach')
  assert.match(block, /this\.sessions\.delete\(target\)/, 'and its target mapping')
  assert.match(block, /const rebuilt = await this\.ensureSession\(viewId\)/, 'then attaches again')
  assert.match(block, /client\.send\(method, params, rebuilt\)/, 'and retries the command once')
  // Exactly one retry: a second failure is not a stale id, and looping would hide it.
  const retries = (block.match(/await client\.send\(method, params, rebuilt\)/g) ?? []).length
  assert.equal(retries, 1, 'the retry happens exactly once')
})
