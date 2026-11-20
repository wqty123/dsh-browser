import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as dns } from 'node:dns'
import { webReferenceHttp } from './fixtures/web-reference-http.mjs'
import { guestPath } from '../lib/browser-electron/guest-route.js'
import { WebReferenceSources } from '../lib/browser-reference/web-sources.js'

test('web frozen capture and registered model reveal share an owned source over real HTTP, not a fictitious browser session', async t => {
  const host = await webReferenceHttp()
  t.after(() => host.close())
  assert.equal(host.distinctBrowserProxies, true, 'Cordis returns caller-scoped browser wrappers')
  const pageUrl = 'https://web-reference.example/article'
  const oldFetch = globalThis.fetch, oldLookup = dns.lookup
  globalThis.fetch = async () => new Response('<html><body><p>selected words</p></body></html>', { headers: { 'content-type': 'text/html' } })
  dns.lookup = async () => [{ address: '93.184.216.34', family: 4 }]
  t.after(() => { globalThis.fetch = oldFetch; dns.lookup = oldLookup })
  const navigation = await host.call(guestPath(pageUrl), undefined, { 'sec-fetch-dest': 'iframe', 'sec-fetch-mode': 'navigate' })
  assert.equal(navigation.status, 200)
  assert.match(navigation.text, /data-dsh-guest-runtime/u)
  assert.match(navigation.headers['content-security-policy'], /^sandbox allow-scripts allow-forms/u)
  const registration = await host.source({ operation: 'register', sessionId: 'session-owner', pageId: 'iframe:source-1', url: pageUrl })
  assert.equal(registration.status, 200)
  const { lease } = registration.json()
  const capture = { sessionId: 'session-owner', sourcePageId: 'iframe:source-1', origin: 'user-selection', entry: 'page-overlay', capture: {
    ok: true, url: pageUrl, title: 'Article', events: [{ kind: 'text', exact: 'selected words', prefix: '', suffix: '' }],
  } }
  assert.equal((await host.call('/dsh-builtin-browser/reference/capture', { ...capture, sessionId: 'session-foreign' })).status, 422)
  assert.equal((await host.call('/dsh-builtin-browser/reference/capture', { ...capture, capture: { ...capture.capture, url: 'https://web-reference.example/other' } })).status, 422)
  const captured = await host.call('/dsh-builtin-browser/reference/capture', capture)
  assert.equal(captured.status, 200, captured.text)
  const reference = host.service.get(captured.json().reference.referenceId)
  assert.deepEqual(reference.owner, { sessionId: 'owner', sourcePageId: 'iframe:source-1' })
  assert.equal(reference.owner.browserSessionId, undefined)
  assert.equal((await host.reveal('missing')).status, 'not-found')
  assert.equal((await host.reveal(reference.referenceId, 'session-foreign')).status, 'unavailable')
  assert.equal((await host.source({ operation: 'poll', lease: 'forged', url: pageUrl })).status, 410)
  const revealing = host.reveal(reference.referenceId)
  const polled = await host.source({ operation: 'poll', lease, url: pageUrl })
  const [command] = polled.json().commands
  assert.equal(command.reference.referenceId, reference.referenceId)
  assert.deepEqual(command.reference.owner, reference.owner)
  const ack = await host.source({ operation: 'poll', lease, url: pageUrl, acknowledgements: [{ id: command.id, status: 'revealed' }] })
  assert.equal(ack.status, 200)
  assert.equal((await revealing).status, 'revealed')
  assert.equal(ack.json().commands.length, 0)
  const posted = host.call('/dsh-builtin-browser/reference/reveal', { referenceId: reference.referenceId })
  let postedCommand
  for (let attempt = 0; attempt < 20 && postedCommand === undefined; attempt++) {
    postedCommand = (await host.source({ operation: 'poll', lease, url: pageUrl })).json().commands[0]
  }
  assert.ok(postedCommand, 'the actual reveal POST must dispatch to the same source channel')
  await host.source({ operation: 'poll', lease, url: pageUrl, acknowledgements: [{ id: postedCommand.id, status: 'missing' }] })
  assert.equal((await posted).json().status, 'missing')
  assert.equal((await host.reveal(reference.referenceId, 'session-owner', { partId: 'absent' })).status, 'not-found')
  await host.source({ operation: 'poll', lease, url: 'https://web-reference.example/other' })
  assert.equal((await host.reveal(reference.referenceId)).status, 'page-mismatch')
  await host.source({ operation: 'remove', lease })
  const closed = await host.reveal(reference.referenceId)
  assert.equal(closed.status, 'unavailable')
  assert.doesNotMatch(closed.note, /session.*gone/u)
  assert.equal((await host.source({ operation: 'register', sessionId: 'owner', pageId: 'iframe:other', url: pageUrl }, { origin: 'http://evil.example' })).status, 403)
})

test('web source leases reject invalid owners, expire without inventing a native session, and finish pending work on cancellation or disposal', async t => {
  const sources = new WebReferenceSources()
  const url = 'https://example.test/article'
  const reference = { owner: { sessionId: 'owner' }, source: { pageUrl: url } }
  assert.throws(() => sources.register('', 'iframe:test', url), /invalid web source/u)
  assert.throws(() => sources.register('owner', 'iframe:test', 'https://'), /Invalid URL/u)
  assert.equal(await sources.reveal(reference, 'iframe:missing'), 'unavailable')
  const lease = sources.register('session-owner', 'iframe:test', url)
  assert.throws(() => sources.register('other-owner', 'iframe:test', url), /already registered/u)
  assert.equal(sources.owns('owner', 'iframe:test'), true)
  assert.equal(sources.owns('other', 'iframe:test'), false)
  assert.equal(sources.owns('owner', 'iframe:test', 'https://other.test/'), false)
  const abort = new AbortController()
  const cancelled = sources.reveal(reference, 'iframe:test', undefined, abort.signal)
  abort.abort()
  assert.equal(await cancelled, 'unavailable')
  assert.deepEqual(sources.poll(lease, url, []), [])
  const disposed = sources.reveal(reference, 'iframe:test')
  sources.remove(lease)
  assert.equal(await disposed, 'unavailable')
  const renewed = sources.register('owner', 'iframe:test', url)
  const now = Date.now()
  t.mock.method(Date, 'now', () => now + 16_000)
  assert.equal(sources.owns('owner', 'iframe:test'), false)
  assert.throws(() => sources.poll(renewed, url, []), /lease expired/u)
})
