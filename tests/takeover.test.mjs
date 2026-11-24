import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { BrowserTakeovers } from '../src/tool-browser/takeover.ts'
import { TAKEOVER_ROUTE, TAKEOVER_TOOL } from '../src/takeover-protocol.ts'
import { takeoverHost, until } from './fixtures/takeover-host.mjs'
import { registerCarrierTakeover } from '../src/browser/takeover-target.ts'

const registration = { operation: 'register', owner: 'owner', tabId: 'sidebar-tab', pageId: '42', url: 'https://example.test/challenge', active: true }

test('request-only adoption waits for the owning visible iframe and queued navigation, never foreign or hidden tabs', async () => {
  const state = new BrowserTakeovers(), controller = new AbortController()
  const navigationUrl = 'https://example.test/login'
  let adopted = false
  const adopting = state.adopt('session-owner', controller.signal, navigationUrl).then(page => { adopted = true; return page })
  state.exchange({ ...registration, owner: 'foreign', pageId: 'iframe:foreign', navigationUrl })
  const { lease } = state.exchange({ ...registration, pageId: 'iframe:user-opened', active: false, navigationUrl })
  await Promise.resolve()
  assert.equal(adopted, false)
  state.exchange({ operation: 'poll', lease, url: registration.url, active: true })
  await Promise.resolve()
  assert.equal(adopted, false, 'the previously visible document cannot satisfy a queued tool open')
  state.exchange({ operation: 'poll', lease, url: 'https://example.test/redirected', active: true, navigationUrl })
  const page = await adopting
  assert.equal(page.pageId, 'iframe:user-opened')
  assert.equal(state.blocks('owner'), false, 'adoption alone grants no agent browser session or action')
  assert.equal(await state.adopt('owner', controller.signal), page, 'a human-opened selected tab needs no previous tool open')
  await state.run(page, 'Human action only', undefined, controller.signal, async () => { assert.equal(state.blocks('owner'), true) })
  assert.equal(state.blocks('owner'), false, 'ownership fence lasts for this request only')
  state.dispose()
})

test('adoption fails closed on empty, ambiguous, stopped or disposed sidebar connections', async () => {
  const state = new BrowserTakeovers(), controller = new AbortController()
  await assert.rejects(state.adopt('empty', controller.signal, undefined, 1), /active, connected/)
  state.exchange(registration)
  state.exchange({ ...registration, pageId: 'iframe:another', tabId: 'other-tab' })
  await assert.rejects(state.adopt('owner', controller.signal), /one selected, visible/)
  const stopped = state.adopt('empty', controller.signal)
  controller.abort(new Error('turn stopped'))
  await assert.rejects(stopped, /turn stopped/)
  const disposed = state.adopt('empty', new AbortController().signal)
  state.dispose()
  await assert.rejects(disposed, /disposed/)
})

test('takeover state is owner/tab scoped, idempotent and first button answer wins', async () => {
  const state = new BrowserTakeovers(), { lease } = state.exchange(registration)
  const page = state.target('session-owner')
  let calls = 0
  const operation = async pending => {
    calls++
    const result = await state.listen({ toolName: TAKEOVER_TOOL, signal: pending.controller.signal }, () => new Promise(() => {}))
    pending.controller.abort()
    return result
  }
  const first = state.run(page, '请完成验证码', undefined, undefined, operation)
  const repeat = state.run(page, 'ignored repeat', undefined, undefined, operation)
  assert.equal(first, repeat)
  assert.equal(state.blocks('owner', 'page:42'), true)
  assert.equal(state.blocks('owner', 'another-tab'), false)
  assert.equal(state.blocks('another-owner'), false)
  await Promise.resolve()
  const { notice } = state.exchange({ operation: 'poll', lease, url: page.url, active: true })
  state.exchange({ operation: 'answer', lease, id: notice.id, outcome: 'done' })
  state.exchange({ operation: 'answer', lease, id: notice.id, outcome: 'skipped' })
  assert.equal(await first, 'allowed-once')
  assert.equal(calls, 1)
  assert.equal(state.blocks('owner'), false)
  assert.deepEqual(state.exchange({ operation: 'poll', lease, url: page.url, active: true }), { notice: undefined })
  assert.throws(() => state.exchange({ operation: 'answer', lease, id: notice.id, outcome: 'done' }), /no longer pending/)
  state.dispose()
})

test('empty, ambiguous, malformed, foreign and expired takeover inputs fail closed', async () => {
  const state = new BrowserTakeovers()
  assert.throws(() => state.target('owner'), /active, connected/)
  assert.throws(() => state.exchange({ ...registration, url: 'file:///private' }), /invalid takeover URL/)
  assert.throws(() => state.exchange({ ...registration, owner: '' }), /invalid takeover field/)
  const { lease } = state.exchange(registration)
  assert.throws(() => state.exchange({ operation: 'poll', lease: 'unknown', url: registration.url }), /lease expired/)
  state.exchange({ ...registration, pageId: '43', tabId: 'another-tab' })
  assert.throws(() => state.target('owner'), /one active/)
  state.exchange({ operation: 'remove', lease })
  assert.throws(() => state.target('another-owner'), /active, connected/)
  assert.equal(await state.listen({ toolName: 'another-tool' }, async () => 'rejected'), 'rejected')
  state.dispose()
})

for (const mode of ['button-done', 'button-skip', 'card-done', 'card-skip', 'abort', 'unavailable']) {
  test(`host approval contract and registered takeover tool: ${mode}`, async t => {
    const bindings = []
    const host = takeoverHost({ bindPanelPage: async (...args) => { bindings.push(args); return 'browser:panel' },
      snapshot: async () => ({ url: 'https://example.test/finished', title: 'Human finished', elements: [
        { ref: 1, kind: 'button', label: 'Continue', x: 0, y: 0 },
      ], truncated: false }) })
    const server = createServer((req, res) => { void host.routes.get(TAKEOVER_ROUTE)(req, res) }).listen(0, '127.0.0.1')
    await once(server, 'listening')
    t.after(async () => { host.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
    const origin = `http://127.0.0.1:${server.address().port}`
    const post = async (data, caller = origin) => {
      const response = await fetch(origin + TAKEOVER_ROUTE, { method: 'POST', headers: { origin: caller, 'content-type': 'application/json' }, body: JSON.stringify(data) })
      return { status: response.status, ...await response.json() }
    }
    assert.equal((await post(registration, 'null')).status, 403, 'opaque guests cannot answer or register')
    assert.equal((await post(registration, 'https://foreign.test')).status, 403)
    const { lease } = await post(registration)
    const tool = host.tools.get(TAKEOVER_TOOL)
    if (mode === 'unavailable') host.native.length = 0
    const result = tool.execute({ reason: 'Complete login', instructions: 'Use your own credentials.' }, host.exec)
    await until(() => host.native.length === 1)
    const card = host.native[0]
    assert.equal(card.request.toolName, TAKEOVER_TOOL)
    assert.equal(card.request.callId, 'takeover-call')
    assert.match(card.request.displayReason.zh, /请接管浏览器：Complete login（完成后点「允许一次」或侧栏「确认完成」）/)
    assert.match(card.request.displayReason.zh, /Use your own credentials/)
    const { notice } = await post({ operation: 'poll', lease, url: registration.url, active: true })
    assert.equal(notice.reason, 'Complete login')
    for (const name of ['dsh_browser_open', 'dsh_browser_click', 'dsh_browser_execute', 'dsh_browser_reset', 'dsh_browser_reset_session', 'dsh_browser_reference_reveal']) {
      await assert.rejects(host.tools.get(name).execute({}, host.exec), error => /awaiting human takeover/.test(error.message) && error.code === 'BROWSER_TAKEOVER_PENDING')
    }
    const repeated = tool.execute({ reason: 'same tab' }, host.exec)
    assert.equal(host.native.length, 1)
    if (mode.startsWith('button')) await post({ operation: 'answer', lease, id: notice.id, outcome: mode.endsWith('done') ? 'done' : 'skipped' })
    else if (mode === 'abort') host.controller.abort()
    else card.answer(mode === 'unavailable' ? 'unavailable' : mode.endsWith('done') ? 'allowed-once' : 'rejected')
    const value = await result
    assert.deepEqual(await repeated, value)
    // `unavailable` is reported as itself, not folded into `cancelled`: nobody declined, this host
    // simply had no channel to reach them, and the model needs to tell those two apart.
    assert.equal(value.outcome, mode === 'abort' ? 'cancelled' : mode === 'unavailable' ? 'unavailable' : mode.endsWith('done') ? 'done' : 'skipped')
    assert.equal(card.answerable, false, 'losing native card was withdrawn after the authoritative answer')
    assert.equal(card.request.signal.aborted, true)
    assert.equal(host.audit.at(-1).outcome, mode === 'abort' ? 'cancelled' : mode === 'unavailable' ? 'unavailable' : mode.endsWith('done') ? 'allowed-once' : 'rejected')
    if (mode !== 'abort') {
      assert.equal(value.page.fresh, true)
      assert.equal(value.page.url, 'https://example.test/finished')
      assert.equal(value.page.title, 'Human finished')
      assert.match(value.page.snapshotHint, /Continue/)
      assert.deepEqual(bindings, [['session-owner', '42']])
    } else assert.equal(value.page.fresh, false)
    const after = await post({ operation: 'poll', lease, url: registration.url, active: true })
    assert.equal(after.notice, undefined)
    assert.equal(host.sections.some(section => /Never attempt automatic CAPTCHA or slider solving/.test(section.text)), true)
  })
}

test('registered takeover requires an active turn and reports a missing fresh snapshot honestly', async t => {
  const host = takeoverHost({ bindPanelPage: async () => { throw new Error('page closed') } })
  t.after(() => host.dispose())
  const handler = host.routes.get(TAKEOVER_ROUTE)
  const post = async data => {
    let result
    await handler({ method: 'POST', headers: { origin: 'http://localhost', host: 'localhost' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(data)) },
    }, { writeHead() {}, end(body) { result = JSON.parse(body) } })
    return result
  }
  await post(registration)
  const tool = host.tools.get(TAKEOVER_TOOL)
  await assert.rejects(tool.execute({ reason: ' ' }, host.exec), /must not be empty/)
  await assert.rejects(tool.execute({ reason: 'x'.repeat(1001) }, host.exec), /too long/)
  await assert.rejects(tool.execute({ reason: 'Login', instructions: 'x'.repeat(2001) }, host.exec), /too long/)
  host.setTurnOpen(false)
  await assert.rejects(tool.execute({ reason: 'Login' }, host.exec), /outside an open turn/)
  assert.equal(host.native.length, 0)
  host.setTurnOpen(true)
  const result = tool.execute({ reason: 'Login' }, host.exec)
  await until(() => host.native.length === 1)
  host.native[0].answer('allowed-once')
  const value = await result
  assert.equal(value.outcome, 'done')
  assert.equal(value.page.fresh, false)
  assert.match(value.page.snapshotHint, /Re-read the page before continuing/)
})

test('a turn stopped during the post-approval snapshot still returns cancelled', async t => {
  let reading = false
  const host = takeoverHost({ bindPanelPage: async () => 'panel', snapshot: (_session, signal) => new Promise((_resolve, reject) => {
    reading = true
    signal.addEventListener('abort', () => { reject(signal.reason) }, { once: true })
  }) })
  t.after(() => host.dispose())
  await host.routes.get(TAKEOVER_ROUTE)({ method: 'POST', headers: { origin: 'http://localhost', host: 'localhost' },
    async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify(registration)) },
  }, { writeHead() {}, end() {} })
  const result = host.tools.get(TAKEOVER_TOOL).execute({ reason: 'Login' }, host.exec)
  await until(() => host.native.length === 1)
  host.native[0].answer('allowed-once')
  await until(() => reading)
  host.controller.abort()
  const value = await result
  assert.equal(value.outcome, 'cancelled')
  assert.equal(value.page.fresh, false)
  assert.equal(host.native[0].answerable, false)
})

test('a takeover reveals a quiet-parked personal browser window before asking the person', async t => {
  const browser = { bindPanelPage: async () => { throw new Error('page closed') } }
  const revealed = []
  const remove = registerCarrierTakeover(browser, owner => [{ session: 'browser-1', owner, tabId: 'tab-1', pageId: 'tab-1',
    url: 'https://example.test/login', connected: () => true, reveal: async () => { revealed.push(Date.now()); return true } }])
  const host = takeoverHost(browser)
  t.after(() => { host.dispose(); remove() })
  const result = host.tools.get(TAKEOVER_TOOL).execute({ reason: 'Login' }, host.exec)
  await until(() => host.native.length === 1)
  assert.equal(revealed.length, 1, 'the window is on the screen when the notice appears')
  host.native[0].answer('allowed-once')
  assert.equal((await result).outcome, 'done')
})
