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
  const events = { terminate: 0, release: 0, keyDown: 0, keyUp: 0, navigateHistory: 0, history: { entries: [], currentIndex: -1 } }
  const page = { url: 'about:blank', wait: { urlOk: true, loadedOk: true, foundOk: true } }
  const host = {
    views,
    showCalls,
    events,
    page,
    createView() {
      const id = `view${++counter}`
      let url = 'about:blank'
      const handle = {
        id,
        sendCommand: async (method, params) => {
          if (method === 'Page.navigate') { url = params.url; return {} }
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
            if (expr.includes('location.href')) return { result: { value: url } }
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
    ...(overrides.available !== undefined ? { available: overrides.available } : {}),
  }
  return host
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
