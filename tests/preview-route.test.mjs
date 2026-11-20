// The live-view frame endpoint (issue #34), tested for the properties that make it safe rather than
// for the happy path alone.
//
// The design's non-negotiables: off by default with no image and no target metadata leaking through;
// same-origin only; a session the plugin never handed out is not a session; and "cannot draw this
// right now" is a paused state rather than an error the browser caused.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { handlePreviewFrame, PREVIEW_ROUTE } from '../lib/browser-electron/preview-route.js'

/** One request shaped like the host's, with the headers `sameOrigin` inspects. */
function request(method = 'GET', session = 'browser:abc', origin = 'http://localhost:3000') {
  const req = Readable.from([])
  req.method = method
  req.headers = { host: 'localhost:3000', ...origin === '' ? {} : { origin, referer: `${origin}/` } }
  req.url = `${PREVIEW_ROUTE}${session === '' ? '' : `?session=${encodeURIComponent(session)}`}`
  return req
}

/** A response that records what was written. */
function response() {
  const recorded = { status: 0, headers: {}, body: undefined, ended: false }
  return {
    recorded,
    writeHead(status, headers) { recorded.status = status; recorded.headers = headers ?? {} },
    end(body) { recorded.body = body; recorded.ended = true },
  }
}

const jpegDataUrl = 'data:image/jpeg;base64,' + Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString('base64')

/** A browser service with one live session. */
function browser({ capture = async () => ({ dataUrl: jpegDataUrl }) } = {}) {
  return {
    exists: session => session === 'browser:abc',
    capturePassive: capture,
  }
}

const on = { get: () => ({ remoteView: { enabled: true } }) }
const off = { get: () => ({ remoteView: { enabled: false } }) }

test('off by default: no image, and nothing about the target is revealed', async () => {
  const res = response()
  // The session given here IS valid, so a 403 proves the switch is what refused — not a bad id.
  await handlePreviewFrame(request('GET', 'browser:abc'), res, off, browser())
  assert.equal(res.recorded.status, 403)
  const body = JSON.parse(String(res.recorded.body))
  assert.equal(body.error, 'remote-view-disabled')
  assert.doesNotMatch(String(res.recorded.body), /browser:abc|jpeg|image/i,
    'a refusal must not name the session or hint that an image exists')
})

test('a cross-origin request is refused even with sharing on', async () => {
  const res = response()
  await handlePreviewFrame(request('GET', 'browser:abc', 'https://evil.example'), res, on, browser())
  assert.equal(res.recorded.status, 403)
  assert.equal(JSON.parse(String(res.recorded.body)).error, 'not-same-origin')
})

test('the session must be one the plugin handed out', async () => {
  const res = response()
  await handlePreviewFrame(request('GET', 'view:whatever'), res, on, browser())
  assert.equal(res.recorded.status, 404)
  assert.equal(JSON.parse(String(res.recorded.body)).error, 'no-such-session')
})

test('a missing session is a parameter error, not a 404', async () => {
  const res = response()
  await handlePreviewFrame(request('GET', ''), res, on, browser())
  assert.equal(res.recorded.status, 400)
  assert.equal(JSON.parse(String(res.recorded.body)).error, 'session-required')
})

test('only GET is served', async () => {
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const res = response()
    await handlePreviewFrame(request(method), res, on, browser())
    assert.equal(res.recorded.status, 405, `${method} must be refused`)
  }
})

test('a successful frame is a JPEG with no caching', async () => {
  const res = response()
  await handlePreviewFrame(request(), res, on, browser())
  assert.equal(res.recorded.status, 200)
  assert.equal(res.recorded.headers['content-type'], 'image/jpeg')
  // A frame is a moment: replaying the last one would show a stale picture labelled live.
  assert.match(String(res.recorded.headers['cache-control']), /no-store/)
  assert.equal(res.recorded.headers['x-content-type-options'], 'nosniff')
  assert.ok(Buffer.isBuffer(res.recorded.body) && res.recorded.body.length === 6, 'the decoded bytes are returned')
  assert.equal(res.recorded.body.subarray(0, 2).toString('hex'), 'ffd8', 'and they are a JPEG')
})

test('an unpaintable page is a paused state, not a failure the browser caused', async () => {
  const failing = () => {
    const error = new Error('preview unavailable (the page is not painted)')
    error.code = 'BROWSER_PREVIEW_UNAVAILABLE'
    return Promise.reject(error)
  }
  const res = response()
  await handlePreviewFrame(request(), res, on, browser({ capture: failing }))
  assert.equal(res.recorded.status, 503)
  const body = JSON.parse(String(res.recorded.body))
  assert.equal(body.error, 'preview-unavailable')
  assert.equal(body.retryable, true, 'the viewer may try again when the window comes back')
})

test('an empty image is refused rather than served as a broken JPEG', async () => {
  const res = response()
  await handlePreviewFrame(request(), res, on, browser({ capture: async () => ({ dataUrl: 'data:image/jpeg;base64,' }) }))
  assert.equal(res.recorded.status, 503)
})

test('the route path is the documented one', () => {
  // The viewer builds its request from this constant; a change here is a protocol change.
  assert.equal(PREVIEW_ROUTE, '/dsh-builtin-browser/browser-view/frame')
})
