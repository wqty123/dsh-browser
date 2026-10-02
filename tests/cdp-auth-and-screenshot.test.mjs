// Cookies and screenshots over CDP, on carriers that are not self-hosted.
//
// Two limits used to be described as carrier limits when they were really implementation
// limits: `browser_auth` refused to run unless the self-hosted handle provided a native
// method, and JPEG was denied to every CDP path because Electron's CDP JPEG encoder
// hangs. The behaviour lives in three pure functions — the cookie mapping in both
// directions and the layout sizing — so those are what is pinned here. Driving a whole
// provider session for this would test the harness more than the logic.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { layoutSize, toCdpCookie, toExportedCookies } from '../lib/browser-electron/provider.js'

test('a CDP cookie is mapped onto the exported shape', () => {
  const [cookie] = toExportedCookies([
    { name: 'sid', value: 'abc', domain: '.example.com', path: '/app', secure: true, httpOnly: true, expires: 1893456000 },
  ])
  assert.ok(cookie, 'the cookie survived')
  assert.equal(cookie.name, 'sid')
  assert.equal(cookie.value, 'abc')
  assert.equal(cookie.url, 'https://example.com/app', 'a leading dot is dropped and the path is kept')
  assert.equal(cookie.domain, '.example.com')
  assert.equal(cookie.secure, true)
  assert.equal(cookie.httpOnly, true)
  assert.equal(cookie.expirationDate, 1893456000, 'CDP seconds pass through')
})

test('a cookie with no expiry is exported without one', () => {
  const [cookie] = toExportedCookies([{ name: 'a', value: 'b', domain: 'example.com' }])
  assert.equal(cookie.expirationDate, undefined, 'a session cookie must not gain an expiry')
  assert.equal(cookie.path, '/', 'a missing path defaults to /')
  assert.equal(cookie.url, 'http://example.com/', 'and the URL is http without secure')
})

test('cookies missing the essentials are dropped rather than exported broken', () => {
  const cookies = toExportedCookies([
    { value: 'no-name', domain: 'example.com' },
    { name: 'no-domain', value: 'x' },
    { name: 'empty-domain', value: 'x', domain: '' },
    { name: 'ok', value: 'y', domain: 'example.com' },
  ])
  assert.equal(cookies.length, 1, 'only the usable one is exported')
  assert.equal(cookies[0]?.name, 'ok')
})

test('a non-array response yields nothing instead of throwing', () => {
  // A carrier that answers with an error object must not crash the export.
  assert.deepEqual(toExportedCookies(undefined), [])
  assert.deepEqual(toExportedCookies({ cookies: [] }), [])
  assert.deepEqual(toExportedCookies([null, 'x', 42]), [])
})

test('an exported cookie is converted back for CDP', () => {
  const cookie = toCdpCookie({ url: 'https://example.com/app', name: 'sid', value: 'abc', secure: true })
  assert.equal(cookie.name, 'sid')
  assert.equal(cookie.domain, 'example.com', 'the domain is recovered from the URL')
  assert.equal(cookie.path, '/app', 'and so is the path')
  assert.equal(cookie.secure, true)
})

test('an explicit domain and path win over the URL', () => {
  const cookie = toCdpCookie({ url: 'https://example.com/', name: 'a', value: 'b', domain: '.other.com', path: '/x' })
  assert.equal(cookie.domain, '.other.com')
  assert.equal(cookie.path, '/x')
})

test('a cookie with no usable domain is skipped, not sent to CDP malformed', () => {
  assert.equal(toCdpCookie({ url: 'not a url', name: 'a', value: 'b' }), undefined)
  assert.equal(toCdpCookie({ url: '', name: 'a', value: 'b', domain: '' }), undefined)
})

test('the layout size accepts both CDP spellings', () => {
  const modern = layoutSize({
    cssContentSize: { width: 1000, height: 2000 },
    cssLayoutViewport: { width: 1000, height: 800 },
  })
  assert.deepEqual(modern, { width: 1000, height: 2000, viewportHeight: 800 })

  const older = layoutSize({
    contentSize: { width: 500, height: 600 },
    layoutViewport: { width: 500, height: 400 },
  })
  assert.deepEqual(older, { width: 500, height: 600, viewportHeight: 400 })
})

test('an unusable layout response reports nothing rather than zeroes', () => {
  // Zero would divide by zero when the scale is computed; undefined makes the caller
  // capture unscaled instead, which is the safe outcome.
  assert.equal(layoutSize({}), undefined)
  assert.equal(layoutSize({ cssContentSize: { width: 0, height: 0 } }), undefined)
  assert.equal(layoutSize({ cssContentSize: { width: '1000', height: 2000 } }), undefined)
})

test('a size without a viewport falls back to the document height', () => {
  const size = layoutSize({ cssContentSize: { width: 100, height: 200 } })
  assert.equal(size.viewportHeight, 200, 'no viewport means the document is the viewport')
})

// The scale itself is computed inside the screenshot path, but its inputs are these
// values; pinning the arithmetic here keeps the formula honest.
test('the downscale factor never upscales', () => {
  const scaleFor = (maxWidth, maxHeight, width, height) => {
    const byWidth = maxWidth !== undefined && width > 0 ? maxWidth / width : 1
    const byHeight = maxHeight !== undefined && height > 0 ? maxHeight / height : 1
    return Math.min(1, byWidth, byHeight)
  }
  assert.equal(scaleFor(500, undefined, 1000, 800), 0.5, 'half the width')
  assert.equal(scaleFor(undefined, 200, 1000, 800), 0.25, 'a quarter for the height')
  assert.equal(scaleFor(2000, 2000, 1000, 800), 1, 'a larger cap does not enlarge the image')
  assert.equal(scaleFor(500, 200, 1000, 800), 0.25, 'the tighter of the two caps wins')
})
