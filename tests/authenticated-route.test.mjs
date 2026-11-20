import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { authenticatedRoute, isDirectLoopback } from '../lib/browser-electron/authenticated-route.js'

async function withServer(connection, handler, run) {
  const server = createServer(authenticatedRoute(connection, handler))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = 'http://127.0.0.1:' + server.address().port
  try {
    await run(base)
  } finally {
    server.closeAllConnections()
    await new Promise(resolve => server.close(resolve))
  }
}

function hostSession(isValid = request => request.headers.cookie === 'dsh_session=signed-test-cookie') {
  return {
    authorizeIndex(request, response) {
      if (isValid(request)) return true
      response.writeHead(401, { 'cache-control': 'no-store' })
      response.end('unauthorized')
      return false
    },
  }
}

test('forged browser and desktop headers cannot bypass host authentication', async () => {
  let captures = 0
  await withServer(() => hostSession(), (_request, response) => {
    captures++
    response.writeHead(200, { 'content-type': 'image/jpeg' })
    response.end(Buffer.from([0xff, 0xd8]))
  }, async base => {
    for (const headers of [
      {},
      { origin: base },
      { 'user-agent': 'Mozilla/5.0', 'accept-language': 'en' },
      { origin: 'dsh-app://app' },
      { referer: 'dsh-desktop://app/' },
      { cookie: 'dsh_session=forged' },
    ]) {
      const response = await fetch(base + '/browser-view/frame?session=known-session', { headers })
      assert.equal(response.status, 401)
      assert.equal(await response.text(), 'unauthorized')
    }
  })
  assert.equal(captures, 0, 'authentication runs before any page capture')
})

test('the current host cookie is checked again for every request and method', async () => {
  let allowed = true
  let writes = 0
  await withServer(() => hostSession(request => allowed && request.headers.cookie === 'dsh_session=signed-test-cookie'), (_request, response) => {
    writes++
    response.writeHead(200)
    response.end('saved')
  }, async base => {
    const headers = { cookie: 'dsh_session=signed-test-cookie' }
    const first = await fetch(base + '/settings', { method: 'PUT', headers, body: '{}' })
    assert.equal(first.status, 200)
    assert.equal(await first.text(), 'saved')
    allowed = false
    const second = await fetch(base + '/settings', { method: 'PUT', headers, body: '{}' })
    assert.equal(second.status, 401)
    await second.text()
  })
  assert.equal(writes, 1, 'revoked access never reaches the write operation')
})

test('a missing or disposed connection service refuses the route', async () => {
  for (const connection of [
    () => undefined,
    () => ({}),
    () => { throw new Error('disposed') },
  ]) {
    await withServer(connection, () => assert.fail('must not run without host authentication'), async base => {
      const response = await fetch(base)
      assert.equal(response.status, 503)
      assert.deepEqual(await response.json(), { error: 'browser-auth-unavailable' })
    })
  }
})

test('the host owns an authentication redirect or denial response', async () => {
  await withServer(() => ({
    authorizeIndex(_request, response) {
      response.writeHead(303, { location: '/' })
      response.end()
      return false
    },
  }), () => assert.fail('must not overwrite the host response'), async base => {
    const response = await fetch(base + '/protected', { redirect: 'manual' })
    assert.equal(response.status, 303)
    assert.equal(response.headers.get('location'), '/')
    await response.text()
  })
})

test('machine-wide bridge changes require a direct loopback request', () => {
  const request = (remoteAddress, headers = {}) => ({ socket: { remoteAddress }, headers })
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isDirectLoopback(request(address)), true)
    for (const name of ['forwarded', 'x-forwarded-for', 'x-forwarded-host', 'x-real-ip']) {
      assert.equal(isDirectLoopback(request(address, { [name]: 'remote.example' })), false)
    }
  }
  assert.equal(isDirectLoopback(request('192.168.1.20')), false)
  assert.equal(isDirectLoopback(request(undefined)), false)
})
