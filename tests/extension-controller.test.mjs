import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { ExtensionController } from '../browser-extension/controller.mjs'
import { permissionGuard } from '../browser-extension/permission-guard.mjs'

const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn) }, async fire(...args) { for (const fn of this.listeners) await fn(...args) } })
function fake() {
  const calls = [], tabs = new Map([[1, { id: 1, url: 'https://example.test/', title: 'personal', windowId: 8 }]])
  const api = {
    windows: { onCreated: event(), get: async id => ({ id, type: id === 9 ? 'popup' : 'normal' }), getAll: async () => [{ id: 8, incognito: false }] },
    tabs: { onRemoved: event(), onCreated: event(), move: async (id, options) => { calls.push(['move', id, options]) }, get: async id => { if (!tabs.has(id)) throw Error('closed'); return tabs.get(id) },
      create: async options => { calls.push(['create', options]); const tab = { ...options, id: 2 }; tabs.set(2, tab); return tab },
      query: async () => [...tabs.values()], remove: async id => { calls.push(['remove', id]); tabs.delete(id); await api.tabs.onRemoved.fire(id) } },
    debugger: { onEvent: event(), onDetach: event(), attach: async target => calls.push(['attach', target]), detach: async target => calls.push(['detach', target]),
      sendCommand: async (target, method, params) => { calls.push([method, target, params]); return method === 'Page.captureScreenshot' ? { data: 'image' } : {} } },
  }
  const events = [], controller = new ExtensionController(api, value => events.push(value))
  return { api, controller, calls, tabs, events }
}
const create = controller => controller.request({ kind: 'create', scope: 'task/session', view: 'task/session/tab' })
const cdp = (controller, lease, method, params = {}) => controller.request({ kind: 'cdp', scope: 'task/session', view: 'task/session/tab', lease, method, params })

test('quiet creation, background input and screenshot use no activation or OS input', async () => {
  const { controller, calls } = fake(), { lease } = await create(controller)
  assert.deepEqual(calls.find(([method]) => method === 'create')[1], { windowId: 8, active: false, url: 'about:blank' })
  await cdp(controller, lease, 'Page.navigate', { url: 'https://example.test/' })
  await cdp(controller, lease, 'Runtime.evaluate', { expression: 'document.title' })
  await cdp(controller, lease, 'Input.insertText', { text: '你好' })
  await cdp(controller, lease, 'Page.captureScreenshot', { clip: { x: 0, y: 0, width: 1280, height: 960, scale: 1 } })
  assert.deepEqual(calls.filter(([method]) => method === 'Input.dispatchKeyEvent').map(call => call[2]), [{ type: 'char', text: '你' }, { type: 'char', text: '好' }])
  assert.equal(calls.find(([method]) => method === 'Page.captureScreenshot')[2].captureBeyondViewport, false)
  assert.doesNotMatch(JSON.stringify(calls), /bringToFront|activateTarget|"active":true|"focused":true/)
  assert.equal(calls.some(([method]) => method === 'Page.setDownloadBehavior'), false)
  for (const name of ['controller.mjs', 'worker.mjs']) {
    const source = readFileSync(new URL(`../browser-extension/${name}`, import.meta.url), 'utf8')
    assert.doesNotMatch(source, /\b(?:windows|tabs)\.(?:update|highlight|createWindow)\s*\(|captureVisibleTab|chrome\.notifications|child_process/)
  }
})

test('text insertion dispatches code points in order, does nothing for empty text and never retries failed input', async () => {
  const { controller, api, calls } = fake(), { lease } = await create(controller)
  await cdp(controller, lease, 'Input.insertText', { text: '' })
  assert.equal(calls.some(([method]) => method === 'Input.dispatchKeyEvent'), false)
  await cdp(controller, lease, 'Input.insertText', { text: 'hello😀' })
  assert.deepEqual(calls.filter(([method]) => method === 'Input.dispatchKeyEvent').map(call => call[2].text), [...'hello😀'])
  let count = 0
  api.debugger.sendCommand = async () => { if (++count === 2) throw Error('input refused') }
  await assert.rejects(cdp(controller, lease, 'Input.insertText', { text: 'abcd' }), /input refused/)
  assert.equal(count, 2)
})

test('site popups are opener-scoped and moved without activation; unrelated tabs and close authority are untouched', async () => {
  const { controller, api, calls } = fake()
  await create(controller)
  await api.tabs.onCreated.fire({ id: 3, openerTabId: 1, windowId: 9, active: true })
  await controller.containPopup({ id: 4, openerTabId: 2, windowId: 9, active: true })
  await controller.containPopup({ id: 5, openerTabId: 2, windowId: 8, active: false })
  assert.deepEqual(calls.filter(([method]) => method === 'move'), [['move', 4, { windowId: 8, index: -1 }]])
  await assert.rejects(controller.request({ kind: 'close', scope: 'task/session', tabId: 4 }), /detach-only/)
  assert.equal(controller.related.has(3), false)
  await controller.release()
  await controller.containPopup({ id: 6, openerTabId: 2, windowId: 9, active: true })
  assert.equal(calls.filter(([method]) => method === 'move').length, 1)
})

test('agent-tab permission guards deny common requests without changing browser-wide permission state', async () => {
  const original = () => { throw Error('native prompt must not run') }
  const context = { navigator: { mediaDevices: { getUserMedia: original }, geolocation: { getCurrentPosition: original } },
    Notification: { requestPermission: original }, DOMException, queueMicrotask }
  runInNewContext(permissionGuard, context)
  assert.equal(await context.Notification.requestPermission(), 'denied')
  await assert.rejects(context.navigator.mediaDevices.getUserMedia(), { name: 'NotAllowedError' })
  assert.equal(await new Promise(resolve => context.navigator.geolocation.getCurrentPosition(null, error => resolve(error.code))), 1)
  const { controller, calls } = fake()
  await create(controller)
  assert.ok(calls.some(([method]) => method === 'Page.addScriptToEvaluateOnNewDocument'))
  calls.length = 0
  await controller.request({ kind: 'attach', scope: 's', view: 'personal', tabId: 1 })
  assert.equal(calls.some(([method]) => method === 'Page.addScriptToEvaluateOnNewDocument'), false)
})

test('closing is explicit, scoped and agent-only; release detaches without closing tabs', async () => {
  const { controller, calls } = fake()
  await controller.request({ kind: 'attach', scope: 'task/session', view: 'personal', tabId: 1 })
  await assert.rejects(controller.request({ kind: 'close', scope: 'task/session', tabId: 1 }), /detach-only/)
  await create(controller)
  await assert.rejects(controller.request({ kind: 'close', scope: 'other/session', tabId: 2 }), /detach-only/)
  await controller.release()
  assert.equal(calls.filter(([method]) => method === 'remove').length, 0)
  await controller.request({ kind: 'close', scope: 'task/session', tabId: 2 })
  assert.deepEqual(calls.filter(([method]) => method === 'remove'), [['remove', 2]])
})

test('missing windows, restricted pages, incognito and quiet capability failures are explicit', async () => {
  const { controller, api, tabs, calls } = fake()
  api.windows.getAll = async () => []
  await assert.rejects(create(controller), /never creates a window/)
  assert.equal(calls.length, 0)
  for (const tab of [{ id: 3, url: 'edge://settings/' }, { id: 3, url: 'https://example.test/', incognito: true }]) {
    tabs.set(3, tab)
    await assert.rejects(controller.request({ kind: 'attach', scope: 's', view: 'v', tabId: 3 }), /unavailable/)
  }
  api.debugger.sendCommand = async () => { throw Error('unsupported') }
  await assert.rejects(controller.request({ kind: 'attach', scope: 's', view: 'v', tabId: 1 }), /quiet-mode interception is unavailable/)
  assert.equal(controller.leases.size, 0)
  assert.ok(calls.some(([method]) => method === 'detach'))
})

test('CDP escape hatches, cookie export, oversized screenshot and foreign leases are rejected', async () => {
  const { controller } = fake(), { lease } = await create(controller)
  for (const method of ['Browser.close', 'Target.closeTarget', 'Target.createTarget', 'Page.close', 'Page.bringToFront', 'Input.synthesizeTapGesture', 'Network.getAllCookies', 'DOM.setFileInputFiles']) {
    await assert.rejects(cdp(controller, lease, method), /unavailable/)
  }
  await assert.rejects(cdp(controller, lease, 'Page.navigate', { url: 'file:///etc/passwd' }), /http/)
  await assert.rejects(cdp(controller, lease, 'Page.captureScreenshot', { clip: { width: 4096, height: 2000, scale: 1 } }), /dimensions/)
  await assert.rejects(controller.request({ kind: 'cdp', scope: 'foreign', view: 'task/session/tab', lease, method: 'Runtime.evaluate' }), /foreign/)
})

test('dialogs are dismissed and reported to the next operation; child-session events are routed', async () => {
  const { controller, calls, events } = fake(), { lease } = await create(controller)
  await controller.event({ tabId: 2, sessionId: 'child' }, 'Page.javascriptDialogOpening', { type: 'confirm', message: 'Confirm?' })
  assert.deepEqual(calls.find(([method]) => method === 'Page.handleJavaScriptDialog').slice(1), [{ tabId: 2, sessionId: 'child' }, { accept: false }])
  await assert.rejects(cdp(controller, lease, 'Runtime.evaluate'), /dismissed JavaScript confirm/)
  assert.equal(events[0].sessionId, 'child')
  await controller.event({ tabId: 2 }, 'Network.requestWillBeSent', { request: { headers: { Cookie: 'private', Authorization: 'private', Accept: '*/*' } } })
  assert.equal(events.at(-1).params.request.headers.Cookie, '[redacted]')
  await controller.api.debugger.onDetach.fire({ tabId: 2 }, 'canceled_by_user')
  await assert.rejects(cdp(controller, lease, 'Runtime.evaluate'), /stale/)
})

test('empty tab lists and invalid requests do not broaden authority', async () => {
  const { controller, tabs } = fake()
  tabs.clear()
  assert.deepEqual(await controller.request({ kind: 'list', scope: 's' }), [])
  await assert.rejects(controller.request({ kind: 'create' }), /scoped/)
  await assert.rejects(controller.request({ kind: 'unknown', scope: 's' }), /stale/)
})

test('new tabs with a pending blank URL are usable and disconnect during creation never attaches', async () => {
  const { api, controller, calls } = fake(), originalGet = api.tabs.get
  api.tabs.get = async id => ({ ...await originalGet(id), url: '', pendingUrl: 'about:blank' })
  assert.equal((await create(controller)).url, 'about:blank')
  await controller.release()
  api.windows.getAll = async () => { await controller.release(); return [{ id: 8 }] }
  const before = calls.filter(([method]) => method === 'attach').length
  await assert.rejects(create(controller), /released during creation/)
  assert.equal(calls.filter(([method]) => method === 'attach').length, before)
})
