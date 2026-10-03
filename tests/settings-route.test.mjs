// Who may read the settings document, and who may write it.
//
// This is the plugin's only mutating HTTP surface, and its failure modes are both invisible in
// a browser: too strict and the panel silently cannot save, too loose and any process on the
// machine can rewrite the operator's action switches. It is NOT authentication — the plugin has
// no credential to check, because DSH hands plugin routes the raw request — so what is asserted
// here is exactly what a browser reliably sends and what that is worth.
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { sameOrigin } = await import('../lib/browser-electron/settings-route.js')

/** A request as `sameOrigin` sees it: only the headers matter. */
const request = (headers) => ({ headers })

const SAME_ORIGIN_WRITE = {
  host: '127.0.0.1:3080',
  origin: 'http://127.0.0.1:3080',
  'sec-fetch-site': 'same-origin',
}

test('a browser-shaped same-origin write is admitted', () => {
  assert.equal(sameOrigin(request(SAME_ORIGIN_WRITE), true), true)
})

test('a write without an Origin is refused — that is not a browser', () => {
  // curl, a script, another process: all of them can reach 127.0.0.1:<port>, and before this
  // they could PUT the whole document, action switches included.
  assert.equal(sameOrigin(request({ host: '127.0.0.1:3080', 'sec-fetch-site': 'same-origin' }), true), false)
  assert.equal(sameOrigin(request({ host: '127.0.0.1:3080' }), true), false)
})

test('a read without an Origin is let through: inspection, not mutation', () => {
  assert.equal(sameOrigin(request({ host: '127.0.0.1:3080' }), false), true)
  // And the default argument is the readable side, so an omitted `writing` cannot open a write.
  assert.equal(sameOrigin(request({ host: '127.0.0.1:3080' })), true)
})

test('an Origin naming a different host is refused, in both directions', () => {
  assert.equal(sameOrigin(request({ ...SAME_ORIGIN_WRITE, origin: 'http://evil.example' }), true), false)
  assert.equal(sameOrigin(request({ ...SAME_ORIGIN_WRITE, origin: 'http://evil.example' }), false), false)
  // Same site, different origin.
  assert.equal(sameOrigin(request({ ...SAME_ORIGIN_WRITE, origin: 'http://127.0.0.1:9999' }), true), false)
})

test('the fetch-metadata header decides before anything else', () => {
  assert.equal(sameOrigin(request({ ...SAME_ORIGIN_WRITE, 'sec-fetch-site': 'cross-site' }), false), false)
  assert.equal(sameOrigin(request({ ...SAME_ORIGIN_WRITE, 'sec-fetch-site': 'same-site' }), false), false)
  // An absent header is not by itself fatal for a write: the Origin match is the stronger
  // signal, and a client old enough not to send fetch metadata may still be the panel.
  const noSite = { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }
  assert.equal(sameOrigin(request(noSite), false), true)
  assert.equal(sameOrigin(request(noSite), true), true, 'the Origin still names this host')
})

test('an opaque origin is refused outright', () => {
  // `Origin: null` is a sandboxed document or a file:// page. Never this panel.
  assert.equal(sameOrigin(request({ host: '127.0.0.1:3080', origin: 'null' }), true), false)
  assert.equal(sameOrigin(request({ host: '127.0.0.1:3080', origin: 'null' }), false), false)
})

test('an unparseable Origin is refused rather than throwing', () => {
  assert.equal(sameOrigin(request({ ...SAME_ORIGIN_WRITE, origin: 'not a url' }), true), false)
})
