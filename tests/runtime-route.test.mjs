// The readiness routes: who may read them, who may start a download, and what a failure looks like.
//
// The admission rule is the interesting half. Reading readiness is a GET and stays open to a plain
// client (the settings document does the same, deliberately). STARTING the download is a write, at
// 100 MB of network and a minute of the user's time, so it is held to the stricter rule — the one
// that refuses a hand-rolled script while admitting the panel a browser renders.
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  handleRuntimeProvision,
  handleRuntimeStatus,
  RUNTIME_PROVISION_ROUTE,
  RUNTIME_STATUS_ROUTE,
} from '../lib/browser-electron/runtime-route.js'

/** One report, minimal but shaped like the real thing. */
function report() {
  return {
    channel: 'bundled',
    carrier: 'bundled',
    readiness: 'blocked',
    electron: { state: 'preparing', detail: 'downloading Electron 44.10.0', at: '2026-11-03T15:00:00.000Z' },
    bridge: { present: false, state: 'absent', detail: 'no DSH Desktop install was found on this machine' },
    canProvision: false,
  }
}

/**
 * A request with the headers `sameOrigin` inspects.
 * @param method - HTTP method.
 * @param kind - `panel` sends what a browser sends, `script` sends nothing.
 */
function request(method, kind = 'panel') {
  const headers = kind === 'panel'
    ? { host: 'localhost:3000', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'accept-language': 'zh-CN' }
    : { host: 'localhost:3000' }
  return { method, headers }
}

/** A response that records what was written. */
function response() {
  const recorded = { status: 0, headers: {}, body: undefined }
  return {
    recorded,
    writeHead(status, headers) { recorded.status = status; recorded.headers = headers ?? {} },
    end(body) { recorded.body = body },
  }
}

const json = res => JSON.parse(String(res.recorded.body))

/** Deps with a counter, so a test can prove the button did (or did not) start something. */
function deps(overrides = {}) {
  const calls = { report: 0, provision: 0 }
  return {
    calls,
    deps: {
      report: () => { calls.report += 1; return report() },
      provision: () => {
        calls.provision += 1
        return { state: 'preparing', detail: 'downloading Electron 44.10.0', at: '2026-11-03T15:00:00.000Z' }
      },
      ...overrides,
    },
  }
}

test('reading readiness is open to a plain client, like the settings document', async () => {
  const res = response()
  const built = deps()
  await handleRuntimeStatus(request('GET', 'script'), res, built.deps)
  assert.equal(res.recorded.status, 200)
  assert.equal(json(res).ok, true)
  assert.equal(json(res).runtime.carrier, 'bundled')
  assert.equal(json(res).runtime.electron.state, 'preparing')
  assert.equal(res.recorded.headers['cache-control'], 'no-store, private', 'a status a poll reads must not be cached')
})

test('a cross-site read is refused', async () => {
  const res = response()
  const built = deps()
  const crossSite = { method: 'GET', headers: { host: 'localhost:3000', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } }
  await handleRuntimeStatus(crossSite, res, built.deps)
  assert.equal(res.recorded.status, 403)
  assert.equal(json(res).error, 'not-same-origin')
})

test('starting the download from a script is refused, and starts nothing', async () => {
  const res = response()
  const built = deps()
  await handleRuntimeProvision(request('POST', 'script'), res, built.deps)
  assert.equal(res.recorded.status, 403)
  assert.equal(built.calls.provision, 0, 'the refusal must happen before anything is started')
})

test('the panel may start it, and gets the state it is now in', async () => {
  const res = response()
  const built = deps()
  await handleRuntimeProvision(request('POST', 'panel'), res, built.deps)
  assert.equal(res.recorded.status, 200)
  assert.equal(built.calls.provision, 1)
  assert.equal(json(res).provision.state, 'preparing', 'a POST answers immediately; the panel polls for the rest')
  assert.equal(json(res).runtime.electron.state, 'preparing')
})

test('a failed provision is a 200 with a reason, not an HTTP error', async () => {
  // A panel that had to map 5xx to "the download failed" would show a network status where the user
  // needs the sentence explaining what happened and what still works.
  const res = response()
  const built = deps({
    provision: () => ({ state: 'failed', detail: 'the download failed: fetch failed', at: '2026-11-03T15:00:00.000Z' }),
  })
  await handleRuntimeProvision(request('POST', 'panel'), res, built.deps)
  assert.equal(res.recorded.status, 200)
  assert.equal(json(res).provision.state, 'failed')
  assert.match(json(res).provision.detail, /fetch failed/)
})

test('a provision that throws still answers with a report', async () => {
  const res = response()
  const built = deps({ provision: () => { throw new Error('spawn EPERM') } })
  await handleRuntimeProvision(request('POST', 'panel'), res, built.deps)
  assert.equal(res.recorded.status, 200)
  assert.match(json(res).provisionError, /spawn EPERM/)
  assert.equal(json(res).runtime.carrier, 'bundled', 'and the panel still has something to render')
})

test('each route rejects the other verb', async () => {
  const a = response()
  await handleRuntimeStatus(request('POST', 'panel'), a, deps().deps)
  assert.equal(a.recorded.status, 405)
  const b = response()
  const built = deps()
  await handleRuntimeProvision(request('GET', 'panel'), b, built.deps)
  assert.equal(b.recorded.status, 405)
  assert.equal(built.calls.provision, 0, 'a GET must never start a download')
})

test('the paths are the ones the panel fetches', () => {
  assert.equal(RUNTIME_STATUS_ROUTE, '/dsh-builtin-browser/runtime-status')
  assert.equal(RUNTIME_PROVISION_ROUTE, '/dsh-builtin-browser/runtime-provision')
})
