import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { pairedRoute } from '../lib/browser-electron/authenticated-route.js'
import { handlePreviewFrame, handlePreviewSessions, PREVIEW_ROUTE, PREVIEW_SESSIONS_ROUTE } from '../lib/browser-electron/preview-route.js'

async function serve(connection, run, getPeer) {
  const calls = { capture: 0, list: 0 }
  const browser = {
    exists: session => session === 'visible-session',
    watchableSessions() { calls.list++; return ['visible-session'] },
    async capturePassive() { calls.capture++; return { dataUrl: 'data:image/png;base64,aW1hZ2U=' } },
  }
  const settings = { get: () => ({ remoteView: { enabled: true } }) }
  const route = pairedRoute(connection, (request, response) => {
    return request.url.startsWith(PREVIEW_SESSIONS_ROUTE)
      ? handlePreviewSessions(request, response, settings, browser)
      : handlePreviewFrame(request, response, settings, browser)
  })
  const server = createServer((request, response) => (
    getPeer === undefined ? route(request, response) : route(request, response, getPeer())
  ))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    await run('http://127.0.0.1:' + server.address().port, calls)
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}

test('preview admission is demand-driven and rechecks host pairing for frames and metadata', async () => {
  let paired = true
  const checked = []
  await serve(() => ({ requestRejection(request) {
    checked.push(request.url)
    return paired && request.headers.cookie === 'host-credential' ? undefined : 401
  } }), async (base, calls) => {
    assert.deepEqual(calls, { capture: 0, list: 0 })
    for (const path of [PREVIEW_SESSIONS_ROUTE, PREVIEW_ROUTE + '?session=visible-session']) {
      const unpaired = await fetch(base + path, { headers: { origin: base } })
      assert.equal(unpaired.status, 401)
      assert.deepEqual(await unpaired.json(), { error: 'unauthorized' })
    }
    assert.deepEqual(calls, { capture: 0, list: 0 })
    const headers = { cookie: 'host-credential', origin: base }
    const list = await fetch(base + PREVIEW_SESSIONS_ROUTE, { headers })
    assert.equal(list.status, 200)
    assert.deepEqual((await list.json()).sessions, ['visible-session'])
    assert.equal(calls.capture, 0, 'listing never captures')
    const frame = await fetch(base + PREVIEW_ROUTE + '?session=visible-session', { headers })
    assert.equal(frame.status, 200)
    assert.equal(await frame.text(), 'image')
    assert.equal(frame.headers.get('cache-control'), 'no-store, private')
    paired = false
    for (const path of [PREVIEW_SESSIONS_ROUTE, PREVIEW_ROUTE + '?session=visible-session']) {
      const revoked = await fetch(base + path, { headers })
      assert.equal(revoked.status, 401)
      await revoked.text()
    }
    assert.deepEqual(calls, { capture: 1, list: 1 })
    assert.equal(checked.length, 6)
  })
})

test('preview refuses unavailable, obsolete, failed or malformed host admission without a fallback', async () => {
  for (const resolve of [
    () => undefined,
    () => ({ authorizeIndex() { assert.fail('index authentication is not API admission') } }),
    () => { throw new Error('disposed') },
    () => ({ requestRejection() { throw new Error('host unavailable') } }),
    () => ({ requestRejection() { return false } }),
  ]) {
    await serve(resolve, async (base, calls) => {
      const response = await fetch(base + PREVIEW_SESSIONS_ROUTE)
      assert.equal(response.status, 503)
      assert.deepEqual(await response.json(), { error: 'browser-pairing-unavailable' })
      assert.deepEqual(calls, { capture: 0, list: 0 })
    })
  }
})

test('preview preserves the host trust fence and does not probe an empty session', async () => {
  await serve(() => ({ requestRejection: () => 403 }), async (base, calls) => {
    const response = await fetch(base + PREVIEW_ROUTE + '?session=visible-session')
    assert.equal(response.status, 403)
    assert.deepEqual(await response.json(), { error: 'forbidden' })
    assert.deepEqual(calls, { capture: 0, list: 0 })
  })
  await serve(() => ({ requestRejection: () => undefined }), async (base, calls) => {
    const response = await fetch(base + PREVIEW_ROUTE, { headers: { origin: base } })
    assert.equal(response.status, 400)
    assert.equal((await response.json()).error, 'session-required')
    assert.deepEqual(calls, { capture: 0, list: 0 })
  })
})

test('preview admits DSH 0.2.3 live peer without legacy requestRejection and rejects aborted peer with 401', async () => {
  const controller = new AbortController()
  const peer = { signal: controller.signal }
  await serve(() => ({}), async (base, calls) => {
    const headers = { origin: base }
    const list = await fetch(base + PREVIEW_SESSIONS_ROUTE, { headers })
    assert.equal(list.status, 200)
    assert.deepEqual((await list.json()).sessions, ['visible-session'])
    const frame = await fetch(base + PREVIEW_ROUTE + '?session=visible-session', { headers })
    assert.equal(frame.status, 200)
    assert.equal(await frame.text(), 'image')
    controller.abort()
    for (const path of [PREVIEW_SESSIONS_ROUTE, PREVIEW_ROUTE + '?session=visible-session']) {
      const denied = await fetch(base + path, { headers })
      assert.equal(denied.status, 401)
      assert.deepEqual(await denied.json(), { error: 'unauthorized' })
    }
    assert.deepEqual(calls, { capture: 1, list: 1 })
  }, () => peer)
})
