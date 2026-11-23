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

const minimizedWindow = message => message.method === 'Browser.getWindowForTarget'
  ? { result: { windowId: 7, bounds: { windowState: 'minimized' } } }
  : message.method === 'Browser.setWindowBounds' ? { result: {} } : undefined

test('quiet mode opens the first Installed Chrome page without focusing its new window', async t => {
  // The launch has no startup window, so this page creates the window. `background` alone left
  // Chromium free to activate that window; `focus: false` is what keeps window focus where it was.
  const [params] = await firstPageParams(t, true)
  assert.equal(params.focus, false)
  assert.equal(params.background, true)
})

test('quiet mode opens the first Installed Chrome window minimized, so it does not cover the screen', async t => {
  const [params] = await firstPageParams(t, true)
  assert.equal(params.windowState, 'minimized')
})

test('a Chromium that rejects windowState still gets its quiet first page, unfocused', async t => {
  const calls = await firstPageParams(t, true, {
    respond: message => message.method === 'Target.createTarget' && message.params?.windowState !== undefined
      ? { error: { message: 'Invalid parameters' } }
      : undefined,
  })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].windowState, 'minimized')
  assert.deepEqual(calls[1], { url: 'about:blank', background: true, focus: false })
})

test('only a person selecting the tab restores the window quiet mode minimized, once, showing the selected tab', async t => {
  const { browser, host, view } = await quietHost(t, true, { respond: minimizedWindow })
  await host.presentView(view, 'view', { quiet: true })
  host.showView(view, 'view', { quiet: true })
  host.showView(view, 'view', { quiet: true, select: true })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(browser.commands.some(c => c.method === 'Browser.setWindowBounds'), false, 'a quiet operation or an agent selection leaves it minimized')
  assert.equal(host.windowMinimizedByQuiet(), true, 'a takeover notice must point the person at the taskbar')
  host.showView(view, 'view', { quiet: true, select: true, user: true })
  await new Promise(resolve => setTimeout(resolve, 50))
  const restores = browser.commands.filter(c => c.method === 'Browser.setWindowBounds')
  assert.deepEqual(restores.map(c => c.params), [{ windowId: 7, bounds: { windowState: 'normal' } }])
  const restoreAt = browser.commands.findIndex(c => c.method === 'Browser.setWindowBounds')
  assert.deepEqual(browser.commands.slice(restoreAt + 1).filter(c => c.method === 'Page.bringToFront').length, 1,
    'the selected tab, created in the background, becomes the visible one')
  assert.equal(host.windowMinimizedByQuiet(), false)
  host.showView(view, 'view', { quiet: true, select: true, user: true })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(browser.commands.filter(c => c.method === 'Browser.setWindowBounds').length, 1,
    'once restored, the window belongs to the user: minimizing it again keeps it minimized')
})

test('with quiet mode off, the first page keeps the default foreground creation', async t => {
  const [params] = await firstPageParams(t, false)
  assert.equal('focus' in params, false)
  assert.equal('background' in params, false)
  assert.equal('windowState' in params, false)
})

test('selecting a later tab in the window quiet mode minimized restores that window', async t => {
  const { browser, host } = await quietHost(t, true, { respond: minimizedWindow })
  const second = host.createView(tabWireId({ owner: 'task-a', session: 'main', tab: 'second' }))
  await second.sendCommand('Runtime.evaluate', { expression: '1' })
  const created = browser.commands.filter(c => c.method === 'Target.createTarget').map(c => c.params)
  assert.equal('windowState' in created[1], false, 'a tab joining the window does not minimize it again')
  host.showView(second, 'second', { quiet: true, select: true, user: true })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.deepEqual(browser.commands.filter(c => c.method === 'Browser.setWindowBounds').map(c => c.params),
    [{ windowId: 7, bounds: { windowState: 'normal' } }])
})

test('a window quiet mode did not minimize stays minimized when a quiet tab in it is selected', async t => {
  const { browser, host } = await quietHost(t, true, {
    respond: message => message.method === 'Target.createTarget' && message.params?.windowState !== undefined
      ? { error: { message: 'Invalid parameters' } }
      : minimizedWindow(message),
  })
  const second = host.createView(tabWireId({ owner: 'task-a', session: 'main', tab: 'second' }))
  await second.sendCommand('Runtime.evaluate', { expression: '1' })
  const created = browser.commands.filter(c => c.method === 'Target.createTarget').map(c => c.params)
  assert.equal(created.length, 3, 'the first page fell back once; the second joined its window')
  host.showView(second, 'second', { quiet: true, select: true, user: true })
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(browser.commands.some(c => c.method === 'Browser.setWindowBounds'), false,
    'the user may have minimized that window; selecting its tab leaves it minimized')
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
