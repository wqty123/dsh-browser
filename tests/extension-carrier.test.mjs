import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { Context } from '@deepseek-ai/cordis'
import { NativeBrowserClient } from '../native-host/client.mjs'
import { ExtensionController } from '../browser-extension/controller.mjs'
import { ExtensionBrowserViewHost } from '../src/browser-electron/extension-browser.ts'
import { ElectronBrowserProvider } from '../src/browser-electron/provider.ts'
import { BrowserRuntime } from '../src/browser/runtime.ts'
import { registerCarrierTakeover, carrierTakeoverTarget } from '../src/browser/takeover-target.ts'
import { createReferenceService } from '../src/browser-reference/service.ts'
import { ReferenceStore } from '../src/browser-reference/store.ts'
import { readRuntimeStatus } from '../src/browser-electron/runtime-status.ts'
import { testScope, tabIn } from './canonical-fixtures.mjs'
import { takeoverHost, until } from './fixtures/takeover-host.mjs'
import { BrowserTakeovers } from '../src/tool-browser/takeover.ts'
import { chromiumPage } from './fixtures/chromium-page.mjs'

function fixture(command = async () => ({})) {
  const event = () => ({ addListener() {} }), calls = [], listeners = new Set()
  const tabs = new Map([[1, { id: 1, windowId: 8, url: 'https://personal.test/', title: 'Personal' }]])
  let sequence = 1, connected = true, epoch = 'epoch-one'
  const api = {
    windows: { onCreated: event(), getAll: async () => [{ id: 8 }], get: async () => ({ type: 'normal' }) },
    tabs: { onCreated: event(), onRemoved: event(), query: async () => [...tabs.values()], get: async id => tabs.get(id),
      create: async options => { calls.push(['create', options]); const tab = { ...options, id: ++sequence }; tabs.set(tab.id, tab); return tab },
      remove: async id => { calls.push(['remove', id]); tabs.delete(id) } },
    debugger: { onEvent: event(), onDetach: event(), attach: async target => calls.push(['attach', target]),
      detach: async target => calls.push(['detach', target]), sendCommand: async (target, method, params) => { calls.push([method, target, params]); return command(method, params) } },
  }
  const controller = new ExtensionController(api, event => { for (const listener of listeners) listener(event) })
  const client = {
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener) },
    status: () => ({ connected, state: connected ? 'connected' : 'extension-missing', browser: 'edge', profile: 'Paired test profile', epoch, detail: 'Test connection' }),
    async connect() { if (!connected) throw Error('extension disconnected') },
    async request(operation) { await this.connect(); return controller.request(operation) },
    dispose() { connected = false; void controller.release() },
  }
  const host = new ExtensionBrowserViewHost('edge', client)
  return { host, api, tabs, calls, controller, client, disconnect() { connected = false; for (const listener of listeners) listener({ method: 'transport.disconnected' }) },
    reconnect() { connected = true; epoch = 'epoch-two' } }
}

test('extension carrier uses scoped inactive tabs, explicit close only, and no presentation APIs', async () => {
  const h = fixture(), scope = testScope('owner'), id = tabIn(scope, 'owned')
  const view = h.host.createView(id)
  assert.equal(h.calls.length, 0, 'blank sessions stay lazy')
  const blank = h.host.createView(tabIn(scope, 'blank'))
  await h.host.closePage(blank.id, scope)
  assert.equal(h.calls.length, 0, 'closing an untouched tab must not open the browser')
  await view.sendCommand('Runtime.evaluate', { expression: 'document.title' })
  await h.host.presentView(view); h.host.showView(view); h.host.focus()
  assert.equal(h.calls.find(([name]) => name === 'create')[1].active, false)
  const [personal] = await h.host.listPages(scope)
  const adopted = await h.host.adoptPage(personal.id, scope)
  await assert.rejects(h.host.closePage(personal.id, scope), /detach-only/)
  await assert.rejects(h.host.closePage(id, testScope('foreign')), /another owner|another session|not open in this owner\/session/)
  await h.host.closePage(id, scope)
  assert.deepEqual(h.calls.filter(([name]) => name === 'remove'), [['remove', 2]])
  h.host.destroyView(adopted)
  await new Promise(setImmediate)
  assert.equal(h.tabs.has(1), true)
  assert.doesNotMatch(JSON.stringify(h.calls), /bringToFront|activateTarget|"active":true|"focused":true/)
  h.host.dispose()
})

test('disconnect invalidates old views and epoch page handles, with no replay or fallback', async () => {
  const h = fixture(), scope = testScope('owner'), view = h.host.createView(tabIn(scope, 'tab'))
  await view.sendCommand('Runtime.evaluate', { expression: '1' })
  assert.equal(h.host.connectedView(view.id), true)
  const [personal] = await h.host.listPages(scope)
  h.disconnect(); h.reconnect()
  assert.equal(h.host.connectedView(view.id), false)
  const before = h.calls.length
  await assert.rejects(view.sendCommand('Input.dispatchMouseEvent', {}), /released/)
  await assert.rejects(h.host.adoptPage(personal.id, scope), /stale or foreign/)
  assert.equal(h.calls.length, before)
  h.host.dispose()
})

test('empty and malformed extension inventories are distinguished', async () => {
  const h = fixture(), scope = testScope('owner')
  h.api.tabs.query = async () => []
  assert.deepEqual(await h.host.listPages(scope), [])
  h.client.request = async () => ({})
  await assert.rejects(h.host.listPages(scope), /inventory is unavailable/)
  h.host.dispose()
})

test('a selected but empty or disconnected extension never adopts an older sidebar takeover', async () => {
  const browser = {}, takeovers = new BrowserTakeovers()
  const remove = registerCarrierTakeover(browser, () => [])
  takeovers.attachBrowser(browser)
  takeovers.exchange({ operation: 'register', owner: 'owner', tabId: 'old-sidebar', pageId: 'old-sidebar', url: 'https://example.test/', active: true })
  await assert.rejects(takeovers.adopt('owner', new AbortController().signal), /selected personal browser has no connected tab/)
  remove(); takeovers.dispose()
})

test('dispose waits for detach and an in-flight create; it never closes tabs or the browser', async () => {
  let release
  const paused = new Promise(resolve => { release = resolve })
  const h = fixture(async method => { if (method === 'Page.enable') await paused; return {} })
  const view = h.host.createView(tabIn(testScope('owner'), 'pending'))
  const operation = view.sendCommand('Runtime.evaluate', {})
  await new Promise(setImmediate)
  h.host.dispose(); release()
  await assert.rejects(operation, /released/)
  await new Promise(setImmediate)
  assert.ok(h.calls.some(([name]) => name === 'detach'))
  assert.equal(h.calls.some(([name]) => name === 'remove' || name === 'Browser.close'), false)
})

test('uninstalled and unpaired carrier errors precede navigation/quarantine, with no launched fallback', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-extension-missing-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const host = new ExtensionBrowserViewHost('edge', new NativeBrowserClient(directory, 'edge'))
  const provider = new ElectronBrowserProvider(host, { history: { enabled: false } })
  const session = await provider.open('owner')
  await assert.rejects(provider.openUrl(session, { url: 'https://example.test/' }), /Extension is not connected.*CDP/)
  await assert.rejects(provider.snapshot(session), /Extension is not connected.*CDP/)
  writeFileSync(join(directory, 'config.json'), JSON.stringify({ browser: 'edge', label: 'Personal' }))
  assert.equal(host.connectionStatus().state, 'not-paired')
  await assert.rejects(provider.openUrl(session, { url: 'https://example.test/' }), /not paired/)
  await assert.rejects(provider.snapshot(session), /not paired/)
  await provider.close(session); provider.dispose(); host.dispose()
})

for (const state of ['extension-missing', 'not-paired', 'connected']) test(`runtime extension readiness: ${state}`, () => {
  const report = readRuntimeStatus({ channel: () => 'edge', systemProfile: () => 'user', hasBinary: () => false,
    provision: () => ({ state: 'idle', detail: 'Idle', at: '' }), bridge: () => undefined, endpoint: () => undefined,
    detectBrowser: () => undefined,
    extensionConnection: () => ({ state, connected: state === 'connected', browser: 'edge', profile: 'Personal', detail: state }) })
  assert.equal(report.resolvedCarrier, state === 'connected' ? 'extension' : 'cdp'); assert.equal(report.controlledProfile, state === 'connected' ? 'user' : 'plugin')
  assert.equal(report.readiness, state === 'connected' ? 'ready' : 'blocked')
  assert.equal(report.extension.profile, 'Personal')
})

test('takeover target registry is runtime/owner scoped, rejects ambiguity and removes retired registrations', () => {
  const browser = {}, session = testScope('owner'), target = { session, owner: 'owner', tabId: 'tab', pageId: 'tab', url: 'https://example.test/', connected: () => true }
  const unregister = registerCarrierTakeover(browser, () => [target])
  assert.equal(carrierTakeoverTarget(browser, 'foreign'), undefined)
  assert.equal(carrierTakeoverTarget({}, 'owner'), undefined)
  assert.equal(carrierTakeoverTarget(new Proxy({}, { get() { assert.fail('an opaque Web guest must not be inspected') } }), 'owner'), undefined)
  assert.equal(carrierTakeoverTarget(browser, 'session-owner', 'tab').session, session)
  const remove = registerCarrierTakeover(browser, () => [target, target])
  unregister()
  assert.throws(() => carrierTakeoverTarget(browser, 'owner'), /Select one/)
  remove(); assert.equal(carrierTakeoverTarget(browser, 'owner'), undefined)
})

test('real page through extension controller/carrier: navigation, a11y, vision attachment, source quote/reveal and chat-only takeover', {
  skip: !process.env.DSH_TEST_CHROME && 'set DSH_TEST_CHROME', timeout: 60000,
}, async t => {
  const chrome = await chromiumPage(t)
  const server = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html'); response.end('<title>Extension fixture</title><p>before selected words after</p><input aria-label="Name"><button>Continue</button>') })
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close())
  const url = `http://127.0.0.1:${server.address().port}/`
  const h = fixture(chrome.command), ctx = new Context()
  new BrowserRuntime(ctx)
  const provider = new ElectronBrowserProvider(h.host, { history: { enabled: false } })
  ctx.browser.registerBrowserProvider(provider); ctx.browser.registerPanelProvider(async () => provider)
  const remove = registerCarrierTakeover(ctx.browser, owner => provider.takeoverTargets(owner).map(target => ({ ...target, connected: () => h.host.connectedView(target.tabId) })))
  const tools = takeoverHost(ctx.browser), saved = []
  tools.ctx.llm = { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) }
  tools.ctx.attachments = { saveImage: async ({ data, mediaType }) => {
    saved.push(data)
    return { attachmentId: 'extension-image', mediaType, bytes: data.length, width: data.readUInt32BE(16), height: data.readUInt32BE(20) }
  } }
  tools.exec.agent.model = { current: () => ({ provider: 'test', model: 'vision' }) }
  t.after(async () => { tools.dispose(); remove(); provider.dispose(); h.host.dispose(); await ctx.fiber.dispose() })
  await tools.tools.get('dsh_browser_open').execute({ url }, tools.exec)
  const [session] = provider.watchableSessions()
  assert.equal((await ctx.browser.snapshot(session)).title, 'Extension fixture')
  assert.ok((await ctx.browser.a11y(session, {})).nodes.length > 0)
  await ctx.browser.execute(session, { script: "document.querySelector('input').focus()" })
  await ctx.browser.type(session, { text: 'hello' })
  assert.equal(await chrome.evaluate(`document.querySelector('input').value`), 'hello')
  const shot = await ctx.browser.screenshot(session, { maxWidth: 1280, maxHeight: 960 })
  assert.match(shot.dataUrl, /^data:image\/png;base64,/)
  const screenshotTool = tools.tools.get('dsh_browser_screenshot')
  const image = await screenshotTool.execute({}, tools.exec)
  assert.equal(image.attachment.attachmentId, 'extension-image')
  assert.equal(saved.length, 1)
  assert.equal(screenshotTool.output.render({}, image)[1].type, 'image')
  const folder = mkdtempSync(join(tmpdir(), 'dsh-extension-reference-')); t.after(() => rmSync(folder, { recursive: true, force: true }))
  const service = createReferenceService(ctx.browser, { store: new ReferenceStore(join(folder, 'refs.jsonl')), assetDir: join(folder, 'assets'),
    sourceSession: (owner, pageId) => ctx.browser.bindPanelPage(`session-${owner}`, pageId),
  })
  await chrome.evaluate(`{ const p=document.querySelector('p'), r=document.createRange(); r.setStart(p.firstChild,7);r.setEnd(p.firstChild,21);getSelection().removeAllRanges();getSelection().addRange(r); }`)
  const capture = await service.capture({ sessionId: 'owner', browserSessionId: session, carrier: 'edge' })
  assert.equal(capture.reference.parts[0].text, 'selected words')
  const tab = (await ctx.browser.listTabs(session)).find(tab => tab.active)
  assert.equal(await ctx.browser.bindPanelPage('session-owner', tab.id), session)
  assert.equal((await service.reveal(capture.reference.referenceId, { sourcePageId: tab.id, ownerSessionId: 'owner' })).status, 'revealed')
  for (const decision of ['allowed-once', 'rejected']) {
    const pending = tools.tools.get('dsh_browser_request_takeover').execute({ reason: 'Please complete login' }, tools.exec)
    await until(() => tools.native.some(request => request.answerable))
    await chrome.evaluate(`document.title='Human finished'`)
    tools.native.find(request => request.answerable).answer(decision)
    const result = await pending
    assert.equal(result.outcome, decision === 'allowed-once' ? 'done' : 'skipped')
    assert.equal(result.page.fresh, true); assert.equal(result.page.title, 'Human finished')
  }
  const disconnected = tools.tools.get('dsh_browser_request_takeover').execute({ reason: 'Wait for human' }, tools.exec)
  await until(() => tools.native.some(request => request.answerable))
  h.disconnect()
  assert.equal((await disconnected).outcome, 'cancelled')
  assert.equal(await chrome.evaluate(`document.querySelector('[data-dsh-takeover]') !== null`), false)
  assert.doesNotMatch(JSON.stringify(h.calls), /bringToFront|activateTarget|"active":true|"focused":true/)
  await ctx.browser.close(session)
  assert.equal(h.calls.some(([name]) => name === 'remove'), false, 'session cleanup detaches only')
})
