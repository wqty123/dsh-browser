// Quiet mode (`ui.quiet`, issue #35): the agent works without taking the screen over.
//
// The contract in one line: presenting a view may still make it visible — Chromium drops
// synthesized `Input.*` for a view without a display surface — but it must not activate the
// application, steal keyboard focus, or restore a window the user minimized. The carrier half of
// that lives in `host-main.ts`; these tests pin the provider half, because a switch that stops at
// the settings file is indistinguishable from no switch at all: every presentation and capture
// call has to carry the decision, and a screenshot must not present the page at all.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { DEFAULT_SETTINGS } from '../lib/browser-electron/settings-store.js'
import { ElectronBrowserProvider } from '../lib/browser-electron/provider.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SystemBrowserViewHost } from '../lib/browser-electron/system-browser.js'
import { tabWireId } from '../lib/browser/handles.js'
import { createFakeBrowser } from './fixtures/fake-cdp-browser.mjs'

/** Host stub: records how the provider asked for presentation and capture. */
function makeHost() {
  const seen = {
    showView: [],
    presentView: [],
    capture: [],
    focus: [],
    commands: [],
  }
  let loads = 0
  let current = 'about:blank'
  const view = {
    id: 'view1',
    async focus(options) { seen.focus.push(options) },
    async sendCommand(method, params) {
      seen.commands.push(method)
      if (method === 'Page.navigate') { loads += 1; current = params.url; return {} }
      if (method === 'Runtime.evaluate') {
        const expression = params.expression ?? ''
        if (expression.includes('timeOrigin')) return { result: { value: `${loads}|complete` } }
        if (expression.includes('document.title')) return { result: { value: `${current}\u0000Example` } }
        if (expression.includes('getBoundingClientRect')) {
          return { result: { value: { ok: true, x: 10, y: 20, __point: { x: 10, y: 20 } } } }
        }
        return { result: { value: { ok: true } } }
      }
      return {}
    },
    async capture(options) {
      seen.capture.push(options)
      return { base64: Buffer.from('image').toString('base64'), mime: 'image/png', width: 8, height: 8 }
    },
  }
  return {
    seen,
    createView() { return view },
    destroyView() {},
    groupView() {},
    onUserAction() {},
    showView(_handle, _label, options) { seen.showView.push(options) },
    async presentView(_handle, _label, options) { seen.presentView.push(options) },
  }
}

/**
 * A provider whose live settings the test can flip, the way the panel does.
 * @param quiet - initial value of `ui.quiet`.
 * @param host - the recording host, when a test wants a fresh one.
 */
function providerWith(quiet, host = makeHost()) {
  const settings = { ...DEFAULT_SETTINGS, ui: { ...DEFAULT_SETTINGS.ui, quiet } }
  const p = new ElectronBrowserProvider(host, { settings: () => settings })
  return {
    p,
    host,
    setQuiet(value) { settings.ui = { ...settings.ui, quiet: value } },
  }
}

test('with quiet mode off, presentation and capture keep the documented sharing behaviour', async () => {
  const { p, host } = providerWith(false)
  const sid = await p.open()
  await p.click(sid, { x: 10, y: 20 })
  await p.screenshot(sid)

  assert.deepEqual(host.seen.presentView.at(-1), { quiet: false }, 'input presents the view as before')
  assert.deepEqual(host.seen.showView.at(-1), { quiet: false }, 'showing keeps raising the window')
  assert.equal(host.seen.capture.at(-1).quiet, false, 'capture may still restore/raise the window')
})

test('quiet mode asks the carrier to present without raising', async () => {
  const { p, host } = providerWith(true)
  const sid = await p.open()
  // `open` legitimately presents the page it just created; only later operations are our subject.
  host.seen.presentView.length = 0
  host.seen.showView.length = 0

  await p.click(sid, { x: 10, y: 20 })

  assert.deepEqual(host.seen.presentView.at(-1), { quiet: true }, 'input still presents, but quietly')
  assert.deepEqual(host.seen.showView.at(-1), { quiet: true }, 'the follow-up show is quiet too')
})

test('quiet mode takes a screenshot without presenting the page at all', async () => {
  const { p, host } = providerWith(true)
  const sid = await p.open()
  host.seen.presentView.length = 0
  host.seen.showView.length = 0
  host.seen.capture.length = 0

  await p.screenshot(sid)

  assert.equal(host.seen.capture.at(-1).quiet, true, 'the carrier is told to capture without presenting')
  assert.equal(host.seen.showView.length, 0, 'a screenshot is not a reason to show or raise the window')
  assert.equal(host.seen.presentView.length, 0, 'nor to present it')
})

test('flipping the switch applies to the next operation, without a restart', async () => {
  const { p, host, setQuiet } = providerWith(false)
  const sid = await p.open()

  await p.click(sid, { x: 10, y: 20 })
  assert.deepEqual(host.seen.presentView.at(-1), { quiet: false })

  setQuiet(true)
  await p.click(sid, { x: 10, y: 20 })
  assert.deepEqual(host.seen.presentView.at(-1), { quiet: true }, 'the next call reads the live document')

  setQuiet(false)
  await p.screenshot(sid)
  assert.equal(host.seen.capture.at(-1).quiet, false, 'turning it back off restores the default path')
})

test('quiet keyboard automation propagates its focus policy to the same view', async () => {
  const { p, host } = providerWith(true)
  const sid = await p.open()
  await p.key(sid, { key: 'Enter' })
  assert.deepEqual(host.seen.presentView.at(-1), { quiet: true })
  assert.deepEqual(host.seen.focus, [{ quiet: true }])
  assert.deepEqual(host.seen.commands.filter(method => method.startsWith('Input.')), [
    'Input.dispatchKeyEvent', 'Input.dispatchKeyEvent',
  ])
})

test('an undisplayed sidebar refuses quiet input instead of focusing or dispatching it', async () => {
  const { p, host } = providerWith(true)
  const sid = await p.open()
  host.presentView = async () => { throw Object.assign(new Error('select this conversation first'), { code: 'panel-not-displayed' }) }
  await assert.rejects(p.key(sid, { key: 'Enter' }), error => {
    assert.equal(error.code, 'BROWSER_VIEW_NOT_PRESENTED')
    assert.equal(error.cause.code, 'panel-not-displayed')
    return true
  })
  assert.deepEqual(host.seen.focus, [])
  assert.deepEqual(host.seen.commands.filter(method => method.startsWith('Input.')), [])
})

/**
 * The page parameters an Installed Chrome/Edge carrier sends when the agent opens its first page.
 * @param quiet - the live `ui.quiet` value.
 */
async function quietHost(t, quiet, options) {
  const browser = createFakeBrowser(options)
  await browser.listen()
  t.after(() => browser.kill())
  const profile = mkdtempSync(join(tmpdir(), 'dsh-quiet-first-page-'))
  const child = { pid: process.pid, exitCode: null, signalCode: null, kill() {}, once() {}, on() {} }
  const host = new SystemBrowserViewHost({ kind: 'chrome', path: process.execPath }, profile, [], undefined,
    () => { writeFileSync(join(profile, 'DevToolsActivePort'), `${browser.port}
`); return child }, 'auto', () => quiet)
  t.after(() => { child.exitCode = 0; host.dispose(); rmSync(profile, { recursive: true, force: true }) })
  const view = host.createView(tabWireId({ owner: 'task-a', session: 'main', tab: 'view' }))
  await view.sendCommand('Runtime.evaluate', { expression: '1' })
  return { browser, host, view }
}

async function firstPageParams(t, quiet, options) {
  const { browser } = await quietHost(t, quiet, options)
  return browser.commands.filter(command => command.method === 'Target.createTarget').map(command => command.params)
}

const PARK_LEFT = 30000
/** A fake Chromium whose quiet window sits where it was created, on a display of 1600x1160 at the origin. */
const parkedBrowser = (overrides = {}) => {
  const state = { left: PARK_LEFT, top: 0, width: 1280, height: 800, hidden: false, ...overrides }
  return {
    state,
    respond: message => {
      if (message.method === 'Browser.getWindowForTarget') return { result: { windowId: 7, bounds: { left: state.left, top: state.top, width: state.width, height: state.height, windowState: 'normal' } } }
      if (message.method === 'Browser.setWindowBounds') { Object.assign(state, message.params.bounds); return { result: {} } }
      if (message.method === 'Runtime.evaluate' && String(message.params?.expression).includes('screen.availLeft')) {
        return { result: { result: { type: 'object', value: { sl: 0, st: 0, sw: 1600, sh: 1160, x: state.left, y: state.top, ow: state.width, oh: state.height, hidden: state.hidden } } } }
      }
      return undefined
    },
  }
}
const moves = browser => browser.commands.filter(c => c.method === 'Browser.setWindowBounds').map(c => c.params)
const settle = () => new Promise(resolve => setTimeout(resolve, 50))

test('quiet mode opens the first Installed Chrome page without focusing its new window', async t => {
  // The launch has no startup window, so this page creates the window. `background` alone left
  // Chromium free to activate that window; `focus: false` is what keeps window focus where it was.
  const [params] = await firstPageParams(t, true, parkedBrowser())
  assert.equal(params.focus, false)
  assert.equal(params.background, true)
})

test('quiet mode creates the first Installed Chrome window off-screen in the normal state, so rAF keeps running', async t => {
  const fake = parkedBrowser()
  const { browser } = await quietHost(t, true, fake)
  const [params] = browser.commands.filter(c => c.method === 'Target.createTarget').map(c => c.params)
  assert.equal(params.newWindow, true)
  assert.equal(params.left, PARK_LEFT)
  assert.equal('windowState' in params, false, 'a minimized window is hidden to its pages and stops rAF')
  assert.deepEqual(moves(browser), [], 'created where it belongs, it never flashes on-screen')
})

test('a Chromium that rejects window bounds gets its quiet first page, then the window moves off-screen', async t => {
  const fake = parkedBrowser({ left: 10, top: 10 })
  const respond = message => message.method === 'Target.createTarget' && message.params?.left !== undefined
    ? { error: { message: 'Invalid parameters' } } : fake.respond(message)
  const { browser } = await quietHost(t, true, { respond })
  const created = browser.commands.filter(c => c.method === 'Target.createTarget').map(c => c.params)
  assert.deepEqual(created[1], { url: 'about:blank', background: true, focus: false })
  assert.deepEqual(moves(browser)[0], { windowId: 7, bounds: { left: PARK_LEFT, top: 0, width: 1280, height: 800 } })
})

test('a parked window a display still overlaps is moved past that display', async t => {
  const fake = parkedBrowser({ left: 1000 })
  const respond = message => message.method === 'Browser.getWindowForTarget' && fake.state.left === 1000
    ? { result: { windowId: 7, bounds: { left: PARK_LEFT, top: 0, windowState: 'normal' } } } : fake.respond(message)
  const { browser } = await quietHost(t, true, { respond })
  assert.deepEqual(moves(browser), [{ windowId: 7, bounds: { left: 1800, top: 0 } }])
})

test('only a person selecting the tab reveals the parked window, once, without moving it again', async t => {
  const fake = parkedBrowser()
  const { browser, host, view } = await quietHost(t, true, fake)
  await host.presentView(view, 'view', { quiet: true })
  host.showView(view, 'view', { quiet: true })
  host.showView(view, 'view', { quiet: true, select: true })
  await settle()
  assert.deepEqual(moves(browser), [], 'a quiet operation or an agent selection leaves it off-screen')
  host.showView(view, 'view', { quiet: true, select: true, user: true })
  await settle()
  assert.deepEqual(moves(browser), [{ windowId: 7, bounds: { left: 40, top: 40 } }])
  const revealAt = browser.commands.findIndex(c => c.method === 'Browser.setWindowBounds')
  assert.equal(browser.commands.slice(revealAt + 1).filter(c => c.method === 'Page.bringToFront').length, 1,
    'the selected tab, created in the background, becomes the visible one')
  host.showView(view, 'view', { quiet: true, select: true, user: true })
  await settle()
  assert.equal(moves(browser).length, 1, 'once revealed, the window is the person\'s')
})

test('a takeover reveals the parked window without bringing a visible page to the front', async t => {
  const fake = parkedBrowser({ height: 1400 })
  const { browser, host, view } = await quietHost(t, true, fake)
  assert.equal(await host.revealQuietWindow(view), true)
  assert.deepEqual(moves(browser), [{ windowId: 7, bounds: { left: 40, top: 40 } }, { windowId: 7, bounds: { width: 1280, height: 1120 } }],
    'moved onto the primary display and fitted to it')
  assert.equal(browser.commands.some(c => c.method === 'Page.bringToFront'), false, 'nothing activates the window')
  assert.equal(await host.revealQuietWindow(view), false, 'only once')
})

test('a takeover on a page hidden behind another tab brings that page to the front', async t => {
  const fake = parkedBrowser({ hidden: true })
  const { browser, host, view } = await quietHost(t, true, fake)
  assert.equal(await host.revealQuietWindow(view), true)
  assert.equal(browser.commands.filter(c => c.method === 'Page.bringToFront').length, 1)
})

test('with quiet mode off, the first page keeps the default foreground creation', async t => {
  const [params] = await firstPageParams(t, false)
  assert.equal('focus' in params, false)
  assert.equal('background' in params, false)
  assert.equal('newWindow' in params, false)
  assert.equal('left' in params, false)
})

test('selecting a later tab in the parked window reveals that window', async t => {
  const fake = parkedBrowser()
  const { browser, host } = await quietHost(t, true, fake)
  const second = host.createView(tabWireId({ owner: 'task-a', session: 'main', tab: 'second' }))
  await second.sendCommand('Runtime.evaluate', { expression: '1' })
  const created = browser.commands.filter(c => c.method === 'Target.createTarget').map(c => c.params)
  assert.equal('left' in created[1], false, 'a tab joining the window does not park it again')
  host.showView(second, 'second', { quiet: true, select: true, user: true })
  await settle()
  assert.deepEqual(moves(browser), [{ windowId: 7, bounds: { left: 40, top: 40 } }])
})

test('a quiet tab in a window quiet mode did not park is never moved', async t => {
  const fake = parkedBrowser()
  const { browser, host, view } = await quietHost(t, true, {
    respond: message => message.method === 'Target.getTargets' ? { result: { targetInfos: [{ type: 'page', targetId: 'mine' }] } } : fake.respond(message),
  })
  host.showView(view, 'view', { quiet: true, select: true, user: true })
  assert.equal(await host.revealQuietWindow(view), false)
  await settle()
  assert.deepEqual(moves(browser), [], 'the person\'s own window stays where they put it')
})

test('in quiet mode an agent tab switch never asks to restore the window; a person selecting the tab does', async () => {
  const { p, host } = providerWith(true)
  const sid = await p.open()
  host.seen.showView.length = 0
  const [tab] = await p.listTabs(sid)
  await p.switchTab(sid, tab.id)
  assert.ok(host.seen.showView.length > 0)
  assert.equal(host.seen.showView.some(options => options.user === true), false, 'the agent never restores the quiet window')
  host.seen.showView.length = 0
  await p.handleUserAction({ type: 'activateTab', windowId: sid, viewId: 'view1' }, true)
  assert.deepEqual(host.seen.showView.at(-1), { quiet: true, select: true, user: true }, 'a tab click in the panel is the person selecting it')
})

test('revealing a closed quiet tab never opens a replacement page', async t => {
  const { browser, host, view } = await quietHost(t, true, parkedBrowser())
  host.destroyView(view)
  const before = browser.commands.length
  assert.equal(await host.revealQuietWindow(view), false)
  assert.deepEqual(browser.commands.slice(before).filter(c => /^Target.(createTarget|attachToTarget)$/u.test(c.method)), [])
})
