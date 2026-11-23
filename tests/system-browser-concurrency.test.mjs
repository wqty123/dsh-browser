import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SystemBrowserViewHost } from '../lib/browser-electron/system-browser.js'
import { ElectronBrowserProvider } from '../lib/browser-electron/provider.js'
import { createFakeBrowser } from './fixtures/fake-cdp-browser.mjs'
import { tabWireId } from '../lib/browser/handles.js'

test('closing an unmaterialized blank tab does not launch a browser', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'dsh-close-blank-'))
  let launches = 0
  const host = new SystemBrowserViewHost({ kind: 'chrome', path: 'unused' }, folder, [], undefined,
    () => { launches++; throw new Error('unexpected launch') })
  const views = []
  const createView = host.createView.bind(host)
  host.createView = identity => {
    const view = createView(identity)
    views.push(view)
    return view
  }
  const provider = new ElectronBrowserProvider(host, { history: { enabled: false } })
  try {
    const session = await provider.open('blank-owner')
    await provider.closeTab(session, views[0].id)
    assert.equal(launches, 0)
    assert.equal(views.length, 2, 'the session receives a replacement blank tab')
    assert.notEqual(views[0].id, views[1].id)
    await assert.rejects(host.closePage(tabWireId({ owner: 'other', session: 'other', tab: 'blank' }), session), /not open in this owner\/session/)
  } finally {
    host.dispose()
    rmSync(folder, { recursive: true, force: true })
  }
})

test('different tasks concurrently claim different browser targets', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'dsh-concurrent-targets-'))
  const browser = createFakeBrowser({ browserName: 'Chrome/156', blanks: ['startup-blank'] })
  await browser.listen()
  writeFileSync(join(folder, 'DevToolsActivePort'), String(browser.port) + '\n')
  const host = new SystemBrowserViewHost({ kind: 'chrome', path: 'never-spawned' }, folder)
  const provider = new ElectronBrowserProvider(host, { history: { enabled: false } })
  try {
    await host.listPages()
    const a = await provider.open('task-A')
    const b = await provider.open('task-B')
    const c = await provider.open('task-C')
    await Promise.all([a, b, c].map(session => provider.execute(session, { script: '1' })))
    assert.equal(browser.attached.length, 3)
    assert.equal(new Set(browser.attached).size, 3, 'no page belongs to two tasks')
    assert.equal(browser.created.length, 2, 'the one startup page is adopted exactly once')
  } finally {
    host.dispose()
    await browser.kill()
    rmSync(folder, { recursive: true, force: true })
  }
})

test('an ephemeral profile with unverified process ownership is retained even after its launcher exits', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'dsh-ephemeral-exit-'))
  writeFileSync(join(folder, 'Cookies'), 'sample')
  const child = Object.assign(new EventEmitter(), {
    exitCode: null, signalCode: null, kill() { return true },
  })
  const host = new SystemBrowserViewHost({ kind: 'chrome', path: 'unused' }, folder, [], folder)
  // Inject only the process seam; no real browser or user profile is opened.
  host.child = child
  try {
    host.dispose()
    assert.equal(existsSync(folder), true, 'a live browser retains its profile during graceful shutdown')
    child.exitCode = 0
    child.emit('exit', 0, null)
    await new Promise(setImmediate)
    assert.equal(existsSync(folder), true, 'launcher exit alone does not prove its profile is unused')
  } finally {
    child.exitCode = 0
    child.emit('exit', 0, null)
    rmSync(folder, { recursive: true, force: true })
  }
})

test('a refused attach does not block the next task or permanently claim the blank page', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'dsh-refused-attach-'))
  const browser = createFakeBrowser({ browserName: 'Chrome/156', blanks: ['startup-blank'], failAttaches: 1 })
  await browser.listen()
  writeFileSync(join(folder, 'DevToolsActivePort'), String(browser.port) + '\n')
  const host = new SystemBrowserViewHost({ kind: 'chrome', path: 'never-spawned' }, folder)
  try {
    await host.listPages()
    const results = await Promise.allSettled([
      host.createView().sendCommand('Runtime.evaluate', { expression: '1' }),
      host.createView().sendCommand('Runtime.evaluate', { expression: '2' }),
    ])
    assert.equal(results[0].status, 'rejected')
    assert.match(results[0].reason.message, /attach refused/)
    assert.equal(results[1].status, 'fulfilled')
    assert.deepEqual(browser.attached, ['startup-blank', 'startup-blank'])
    assert.deepEqual(browser.created, [])
  } finally {
    host.dispose()
    await browser.kill()
    rmSync(folder, { recursive: true, force: true })
  }
})

test("takeover offers the agent's own tab before a page the reference scanner adopted for the same conversation", () => {
  const folder = mkdtempSync(join(tmpdir(), 'dsh-takeover-reference-'))
  const host = new SystemBrowserViewHost({ kind: 'chrome', path: 'unused' }, folder, [], undefined, () => { throw new Error('unexpected launch') })
  const provider = new ElectronBrowserProvider(host, { history: { enabled: false } })
  const session = (id, tab) => ({ id, label: 'owner', tabs: [{ id: tab, url: `https://${tab}.test/` }], activeIndex: 0, history: [], nextSeq: 1 })
  try {
    provider.sessions.set('agent', session('agent', 'agent-tab'))
    provider.sessions.set('reference', session('reference', 'reference-tab'))
    provider.referenceSession = 'reference'
    assert.deepEqual(provider.takeoverTargets('owner').map(target => target.tabId), ['agent-tab'])
    provider.sessions.delete('agent')
    assert.deepEqual(provider.takeoverTargets('owner').map(target => target.tabId), ['reference-tab'])
  } finally {
    host.dispose()
    rmSync(folder, { recursive: true, force: true })
  }
})

for (const browserName of ['Chrome/156', 'HeadlessChrome/156']) {
  test(`a managed tab counts as connected for takeover only while ${browserName} shows it`, async () => {
    const folder = mkdtempSync(join(tmpdir(), 'dsh-connected-view-'))
    const browser = createFakeBrowser({ browserName, blanks: ['startup-blank'] })
    await browser.listen()
    writeFileSync(join(folder, 'DevToolsActivePort'), String(browser.port) + '\n')
    const host = new SystemBrowserViewHost({ kind: 'chrome', path: 'never-spawned' }, folder)
    const views = []
    const createView = host.createView.bind(host)
    host.createView = identity => { const view = createView(identity); views.push(view); return view }
    const provider = new ElectronBrowserProvider(host, { history: { enabled: false } })
    try {
      const session = await provider.open('owner')
      await provider.execute(session, { script: '1' })
      const id = views.at(-1).id
      if (browserName.startsWith('Headless')) { assert.equal(host.connectedView(id), false); return }
      assert.equal(host.connectedView(id), true)
      browser.destroyTarget(browser.attached.at(-1))
      for (let i = 0; i < 50 && host.connectedView(id); i++) await new Promise(resolve => setTimeout(resolve, 20))
      assert.equal(host.connectedView(id), false)
    } finally {
      host.dispose()
      await browser.kill()
      rmSync(folder, { recursive: true, force: true })
    }
  })
}
