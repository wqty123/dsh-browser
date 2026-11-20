import { testScope, tabIn } from './canonical-fixtures.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { BrowserRuntime } from '../lib/browser/runtime.js'
import { createReferenceService } from '../lib/browser-reference/service.js'
import { ReferenceStore } from '../lib/browser-reference/store.js'
import { createReferenceRouteHandlers } from '../lib/browser-electron/reference-route.js'
import { openReferenceSource } from '../src/client/reference/client/production/source-opener.ts'

function runtime(t) {
  const ctx = new Context()
  new BrowserRuntime(ctx)
  t.after(() => ctx.fiber.dispose())
  return ctx
}

test('navigation readiness binds and highlights through the live Cordis panel service', async t => {
  const ctx = runtime(t)
  const folder = mkdtempSync(join(tmpdir(), 'dsh-cordis-reveal-'))
  t.after(() => rmSync(folder, { recursive: true, force: true }))
  const owner = '79b4e5bd-5bf4-49f3-b911-5d1a92b7002b'
  const session = testScope(`session-${owner}`, 'browser:live')
  const url = 'https://www.runoob.com/html/html-lists.html'
  const calls = []
  let ready = false, highlighted = false
  ctx.browser.registerBrowserProvider({ id: 'default', available: () => true, exists: () => false })
  ctx.browser.registerPanelProvider(async () => ({
    id: 'live-sidebar',
    open: async label => { calls.push(['open', label]); return session },
    exists: () => true,
    close: async id => { calls.push(['close', id]) },
    bindPage: async (session, pageId) => {
      assert.equal(ready, true)
      calls.push(['bind', session, pageId])
    },
    execute: async (session, request) => {
      assert.equal(session, testScope(`session-${owner}`, 'browser:live'))
      assert.equal(ready, true)
      if (request.script.includes('text: map.text, truncated: map.truncated')) return { ok: true, value: { text: 'before selected words after' } }
      if (!request.script.includes('return JSON.stringify(highlightText(spec))')) {
        assert.ok(request.script.includes('String(location.href)'))
        return { ok: true, value: { url } }
      }
      assert.ok(request.script.includes('return JSON.stringify(highlightText(spec))'))
      assert.equal(request.args[0].start, 7)
      assert.equal(request.args[0].end, 21)
      highlighted = true
      return { ok: true, value: { ok: true, rects: 1, scrolled: true } }
    },
  }))
  const service = createReferenceService(ctx.browser, {
    store: new ReferenceStore(join(folder, 'references.jsonl')),
    assetDir: join(folder, 'assets'),
    sourceSession: (owner, pageId) => ctx.browser.bindPanelPage(`session-${owner}`, pageId),
  })
  const { reference } = await service.capture({ sessionId: owner, frozenCapture: {
    ok: true, url, title: 'Lists', events: [{ kind: 'text', exact: 'selected words', prefix: 'before ', suffix: ' after' }],
  } })
  assert.ok(reference)
  const route = createReferenceRouteHandlers({ service }).reveal
  const reveal = async sourcePageId => {
    let payload
    await route({
      method: 'POST', headers: { host: 'localhost:3180', origin: 'http://localhost:3180' },
      socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ referenceId: reference.referenceId, sourcePageId })) },
    }, { writeHead(status) { assert.equal(status, 200) }, end(body) { payload = JSON.parse(body) } })
    return payload
  }
  assert.equal((await reveal()).status, 'session-unavailable')
  let acknowledge
  const source = openReferenceSource({
    tabsIn: () => [{ id: 'tab', kind: 'browser' }],
    openTabIn: () => assert.fail('must reuse the visible tab'),
  }, {
    current: () => ({ url: 'https://cn.bing.com/', guestId: '2' }),
    read: () => ({ requestId: 'old' }),
    navigate: query => { calls.push(['navigate', query.url]); return true },
    wait: () => new Promise(resolve => { acknowledge = () => { ready = true; resolve({ guestId: '2' }) } }),
  }, owner, url, new AbortController().signal)
  assert.deepEqual(calls, [['navigate', url]])
  assert.equal(highlighted, false)
  acknowledge()
  const page = await source
  const outcome = await reveal(page.pageId)
  assert.equal(outcome.status, 'revealed', JSON.stringify(outcome))
  assert.equal(highlighted, true)
  assert.deepEqual(calls, [['navigate', url], ['open', `session-${owner}`], ['bind', session, tabIn(session, 'page:2')]])
})

test('Cordis panel registration may be absent or return no controllable surface', async t => {
  const ctx = runtime(t)
  assert.equal(await ctx.browser.openPanel('owner'), undefined)
  const dispose = ctx.browser.registerPanelProvider(async () => undefined)
  assert.equal(await ctx.browser.openPanel('owner'), undefined)
  await dispose()
  assert.equal(await ctx.browser.openPanel('owner'), undefined)
})

test('real registration disposal during open still rejects and closes the late session', async t => {
  const ctx = runtime(t)
  let complete, started
  const reached = new Promise(resolve => { started = resolve })
  const opened = new Promise(resolve => { complete = resolve })
  const closed = []
  const dispose = ctx.browser.registerPanelProvider(async () => ({
    open: () => { started(); return opened },
    close: async id => { closed.push(id) },
  }))
  const pending = ctx.browser.openPanel('owner')
  await reached
  await dispose()
  complete('late-session')
  await assert.rejects(pending, /disposed during open/)
  assert.deepEqual(closed, ['late-session'])
  assert.equal(await ctx.browser.openPanel('owner'), undefined)
})
