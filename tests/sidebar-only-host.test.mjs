import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SidebarOnlyHost } from '../lib/browser-electron/sidebar-only-host.js'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function sidebar() {
  const calls = []
  let count = 0
  let lost
  const host = {
    createView(owner) {
      const id = 'guest-' + ++count
      calls.push({ action: 'create', id, owner })
      return { id, async sendCommand(method, params, options) { calls.push({ action: 'send', id, method, params, options }); return { id, method } } }
    },
    destroyView(view) { calls.push({ action: 'destroy', id: view.id }) },
    showView(view, label, options) { calls.push({ action: 'show', id: view.id, label, options }) },
    async listPages(owner) { calls.push({ action: 'list', owner }); return [{ id: 'extra', title: owner, url: 'https://example.com' }] },
    async closePage(id, owner) { calls.push({ action: 'close', id, owner }) },
    async releasePage(owner) { calls.push({ action: 'release', owner }) },
    async collapse() { calls.push({ action: 'collapse' }) },
    dispose() { calls.push({ action: 'dispose' }) },
    onLost(listener) { lost = listener },
  }
  return { host, calls, lose: (reason = 'shell-exited') => lost?.(reason) }
}

test('selection stays available and presentation does not discover or open a blank page', async () => {
  const inner = sidebar()
  let loads = 0
  const host = new SidebarOnlyHost(async () => { loads++; return inner.host })
  const view = host.createView('owner-a')
  assert.equal(host.available(), true)
  assert.deepEqual(Object.keys(view).sort(), ['download', 'id', 'sendCommand'])
  host.showView(view, 'task', { quiet: true })
  await host.collapse()
  assert.equal(loads, 0)
  assert.deepEqual(inner.calls, [])
  await view.sendCommand('Page.navigate', { url: 'https://example.com' })
  host.showView(view, 'task', { quiet: true })
  assert.equal(loads, 1)
  assert.deepEqual(inner.calls.at(-1), { action: 'show', id: 'guest-1', label: 'task', options: { quiet: true } })
})

test('concurrent first commands share discovery and materialize each owner once', async () => {
  const ready = deferred()
  const inner = sidebar()
  let loads = 0
  const host = new SidebarOnlyHost(() => { loads++; return ready.promise })
  const first = host.createView('owner-a')
  const second = host.createView('owner-b')
  const options = { timeoutMs: 450 }
  const pending = Promise.all([
    first.sendCommand('Page.navigate', { url: 'https://a.example' }, options),
    first.sendCommand('Runtime.evaluate', { expression: '1' }),
    second.sendCommand('Page.navigate', { url: 'https://b.example' }),
  ])
  await Promise.resolve()
  assert.equal(loads, 1)
  ready.resolve(inner.host)
  await pending
  assert.deepEqual(inner.calls.filter(call => call.action === 'create').map(call => call.owner), ['owner-a', 'owner-b'])
  assert.equal(inner.calls.find(call => call.method === 'Page.navigate').options, options)
  assert.equal(new Set(inner.calls.filter(call => call.action === 'send' && call.method === 'Runtime.evaluate').map(call => call.id)).size, 1)
})

test('discovery failure preserves the same handle and retries only the requested sidebar loader', async () => {
  const inner = sidebar()
  const unavailable = new Error('desktop bridge is not installed')
  let loads = 0
  const host = new SidebarOnlyHost(async () => { if (++loads === 1) throw unavailable; return inner.host })
  const view = host.createView('owner-a')
  const id = view.id
  await assert.rejects(view.sendCommand('Page.navigate'), error => error === unavailable)
  assert.equal(host.available(), true)
  await view.sendCommand('Page.navigate')
  assert.equal(view.id, id)
  assert.equal(loads, 2)
  assert.equal(inner.calls.filter(call => call.action === 'create').length, 1)
})

test('a destroyed handle waiting for discovery never creates an inner view', async () => {
  const ready = deferred()
  const inner = sidebar()
  const host = new SidebarOnlyHost(() => ready.promise)
  const view = host.createView('owner-a')
  const pending = view.sendCommand('Page.navigate')
  host.destroyView(view)
  ready.resolve(inner.host)
  await assert.rejects(pending, /view is destroyed/)
  assert.equal(inner.calls.filter(call => call.action === 'create').length, 0)
  await assert.rejects(view.sendCommand('Runtime.evaluate'), /view is destroyed/)
})

test('disposing during discovery disposes its late host and cannot resurrect views', async () => {
  const ready = deferred()
  const inner = sidebar()
  const host = new SidebarOnlyHost(() => ready.promise)
  const view = host.createView('owner-a')
  const pending = view.sendCommand('Page.navigate')
  host.dispose()
  ready.resolve(inner.host)
  await assert.rejects(pending, /host is disposed/)
  assert.deepEqual(inner.calls, [{ action: 'dispose' }])
  host.showView(view)
  assert.throws(() => host.createView('owner-b'), /host is disposed/)
})

test('releasing an owner cancels its pending views without disturbing another owner', async () => {
  const ready = deferred()
  const inner = sidebar()
  const host = new SidebarOnlyHost(() => ready.promise)
  const first = host.createView('owner-a')
  const second = host.createView('owner-b')
  const pendingFirst = first.sendCommand('Page.navigate')
  const firstFailure = assert.rejects(pendingFirst, /view is destroyed/)
  const pendingSecond = second.sendCommand('Page.navigate')
  const release = host.releasePage('owner-a')
  ready.resolve(inner.host)
  await Promise.all([firstFailure, pendingSecond, release])
  assert.deepEqual(inner.calls.filter(call => call.action === 'create').map(call => call.owner), ['owner-b'])
  assert.deepEqual(inner.calls.filter(call => call.action === 'release'), [{ action: 'release', owner: 'owner-a' }])
  await second.sendCommand('Runtime.evaluate')
  host.destroyView(second)
  await host.releasePage('owner-b')
  assert.deepEqual(inner.calls.slice(-2), [{ action: 'destroy', id: 'guest-1' }, { action: 'release', owner: 'owner-b' }])
})

test('listing and closing forward the requested owner; collapse and release do not load an unused host', async () => {
  const inner = sidebar()
  let loads = 0
  const host = new SidebarOnlyHost(async () => { loads++; return inner.host })
  await host.releasePage('owner-a')
  await host.collapse()
  assert.equal(loads, 0)
  assert.equal((await host.listPages('owner-b'))[0].title, 'owner-b')
  await host.closePage('extra', 'owner-b')
  await host.collapse()
  assert.deepEqual(inner.calls, [{ action: 'list', owner: 'owner-b' }, { action: 'close', id: 'extra', owner: 'owner-b' }, { action: 'collapse' }])
})

test('carrier loss reconnects existing wrappers to the sidebar with stable identities and owners', async () => {
  const first = sidebar()
  const second = sidebar()
  let loads = 0
  const host = new SidebarOnlyHost(async () => (++loads === 1 ? first : second).host)
  const a = host.createView('owner-a')
  const b = host.createView('owner-b')
  const ids = [a.id, b.id]
  await Promise.all([a.sendCommand('Page.navigate'), b.sendCommand('Page.navigate')])
  const reasons = []
  host.onLost(reason => { reasons.push(reason); throw new Error('listener failed') })
  first.lose()
  host.showView(a)
  await Promise.all([a.sendCommand('Runtime.evaluate'), b.sendCommand('Runtime.evaluate')])
  assert.equal(loads, 2)
  assert.deepEqual([a.id, b.id], ids)
  assert.deepEqual(second.calls.filter(call => call.action === 'create').map(call => call.owner), ['owner-a', 'owner-b'])
  assert.deepEqual(reasons, ['shell-exited'])
  assert.equal(first.calls.filter(call => call.action === 'dispose').length, 1)
  first.lose()
  await a.sendCommand('Runtime.evaluate')
  assert.equal(loads, 2)
})

test('page command failures keep the current sidebar and are never replayed', async () => {
  const inner = sidebar()
  let loads = 0
  let commands = 0
  inner.host.createView = owner => ({ id: owner, async sendCommand() { commands++; throw new Error('bad selector') } })
  const host = new SidebarOnlyHost(async () => { loads++; return inner.host })
  const view = host.createView('owner-a')
  await assert.rejects(view.sendCommand('Input.dispatchMouseEvent'), /bad selector/)
  await assert.rejects(view.sendCommand('Input.dispatchMouseEvent'), /bad selector/)
  assert.equal(commands, 2)
  assert.equal(loads, 1)
})

test('concurrent failed discovery is shared and the following commands share one retry', async () => {
  const ready = deferred()
  const inner = sidebar()
  let loads = 0
  const host = new SidebarOnlyHost(() => ++loads === 1 ? ready.promise : Promise.resolve(inner.host))
  const a = host.createView('owner-a')
  const b = host.createView('owner-b')
  const first = Promise.allSettled([a.sendCommand('Page.navigate'), b.sendCommand('Page.navigate')])
  await Promise.resolve()
  ready.reject(new Error('bridge not ready'))
  assert.deepEqual((await first).map(result => result.status), ['rejected', 'rejected'])
  assert.equal(loads, 1)
  await Promise.all([a.sendCommand('Page.navigate'), b.sendCommand('Page.navigate')])
  assert.equal(loads, 2)
})

test('a carrier lost while creating a view cannot install a stale binding', async () => {
  const first = sidebar()
  const second = sidebar()
  let loads = 0
  const originalCreate = first.host.createView
  first.host.createView = owner => {
    const inner = originalCreate(owner)
    first.lose()
    return inner
  }
  const host = new SidebarOnlyHost(async () => (++loads === 1 ? first : second).host)
  const view = host.createView('owner-a')
  await assert.rejects(view.sendCommand('Page.navigate'), /bridge changed while binding/)
  assert.equal(first.calls.some(call => call.action === 'send'), false)
  assert.deepEqual(first.calls.slice(-2), [{ action: 'dispose' }, { action: 'destroy', id: 'guest-1' }])
  await view.sendCommand('Page.navigate')
  assert.equal(loads, 2)
  assert.equal(second.calls.filter(call => call.action === 'send').length, 1)
})

test('downloads bind lazily to the same owner and propagate transfer failures without replay', async () => {
  const inner = sidebar()
  const create = inner.host.createView
  const transfers = []
  inner.host.createView = owner => ({ ...create(owner), async download(url, savePath) {
    transfers.push({ owner, url, savePath })
    throw new Error('transfer interrupted')
  } })
  const host = new SidebarOnlyHost(async () => inner.host)
  const view = host.createView('download-owner')
  await assert.rejects(view.download('https://example.com/file', '/downloads/file'), /transfer interrupted/)
  assert.deepEqual(transfers, [{ owner: 'download-owner', url: 'https://example.com/file', savePath: '/downloads/file' }])
  assert.equal(inner.calls.filter(call => call.action === 'create').length, 1)
  await view.sendCommand('Runtime.evaluate')
  assert.equal(inner.calls.filter(call => call.action === 'create').length, 1)
  host.destroyView(view)
  await assert.rejects(view.download('https://example.com/file', '/downloads/file'), /destroyed/)
  assert.equal(transfers.length, 1)
})
