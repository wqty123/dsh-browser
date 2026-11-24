import { test } from 'node:test'
import assert from 'node:assert/strict'
import dns from 'node:dns'
import { createServer, request as httpRequest } from 'node:http'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { Agent } from 'undici'
import { fetchGuestResource, guestPath, handleGuest } from '../src/browser-electron/guest-route.ts'
import { GuestCookieJar } from '../src/browser-electron/guest-cookie-jar.ts'

// The vetting lookup answers a public address; every later lookup of the name answers loopback.
async function rebinding(t) {
  let hits = 0
  const loopback = createServer((_request, response) => { hits++; response.end('internal') })
  loopback.listen(0, '127.0.0.1')
  await once(loopback, 'listening')
  const checks = []
  const { lookup } = dns
  const promised = dns.promises.lookup
  dns.promises.lookup = async hostname => { checks.push(hostname); return [{ address: '192.0.2.10', family: 4 }] }
  dns.lookup = (_hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {} }
    if (options.all) callback(null, [{ address: '127.0.0.1', family: 4 }])
    else callback(null, '127.0.0.1', 4)
  }
  t.after(() => { dns.lookup = lookup; dns.promises.lookup = promised; loopback.closeAllConnections(); loopback.close() })
  return { url: `http://rebind.test:${loopback.address().port}/a.png`, hits: () => hits, checks }
}

test('a quoted image whose name rebinds to loopback after the check never reaches loopback', async t => {
  const target = await rebinding(t)
  await assert.rejects(fetchGuestResource(target.url, { maxBytes: 1024, signal: AbortSignal.timeout(1000) }))
  assert.deepEqual(target.checks, ['rebind.test'])
  assert.equal(target.hits(), 0)
})

test('a guest request whose name rebinds to loopback after the check never reaches loopback', async t => {
  const target = await rebinding(t)
  const proxy = createServer((request, response) => {
    void handleGuest(request, response, '', 'owner', new GuestCookieJar()).catch(error => response.destroy(error))
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  t.after(() => { proxy.closeAllConnections(); proxy.close() })
  const client = httpRequest({ port: proxy.address().port, path: guestPath(target.url), headers: { host: 'dsh.example:3102', 'x-dsh-guest-sub': '1' } })
  client.on('error', () => {})
  client.end()
  await delay(1000)
  client.destroy()
  assert.ok(target.checks.includes('rebind.test'))
  assert.equal(target.hits(), 0)
})

test('dispatcher.close() rejection never causes an unhandled rejection or masks the fetch error', async t => {
  const target = await rebinding(t)
  const unhandled = []
  const onUnhandled = reason => { unhandled.push(reason) }
  process.on('unhandledRejection', onUnhandled)
  t.mock.method(Agent.prototype, 'close', () => Promise.reject(new Error('synthetic close failure')))
  t.after(() => { process.off('unhandledRejection', onUnhandled) })

  await assert.rejects(
    fetchGuestResource(target.url, { maxBytes: 1024, signal: AbortSignal.timeout(300) }),
    error => !/synthetic close failure/.test(String(error)),
  )
  await delay(50)
  assert.deepEqual(unhandled, [], 'close rejection must be caught internally')
})

test('overridden globalThis.fetch in tests receives clean init without an external undici dispatcher', async t => {
  const promised = dns.promises.lookup
  const originalFetch = globalThis.fetch
  const seen = []
  dns.promises.lookup = async () => [{ address: '93.184.216.34', family: 4 }]
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), hasDispatcher: 'dispatcher' in (init ?? {}) })
    return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
  }
  t.after(() => { dns.promises.lookup = promised; globalThis.fetch = originalFetch })

  const bytes = await fetchGuestResource('https://example.test/img.png', { maxBytes: 1024 })
  assert.deepEqual([...bytes], [1, 2, 3])
  assert.deepEqual(seen, [{ url: 'https://example.test/img.png', hasDispatcher: false }])
})
