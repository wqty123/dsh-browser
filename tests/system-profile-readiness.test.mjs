import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SystemBrowserViewHost } from '../lib/browser-electron/system-browser.js'
import { readRuntimeStatus } from '../lib/browser-electron/runtime-status.js'
import { createFakeBrowser } from './fixtures/fake-cdp-browser.mjs'

function setup(t, launcher, profileError) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-profile-readiness-'))
  const previous = process.env.DSH_BROWSER_ATTACH_PORT
  delete process.env.DSH_BROWSER_ATTACH_PORT
  const host = new SystemBrowserViewHost({ kind: 'edge', path: 'fake-edge' }, dir, [], undefined,
    (...args) => launcher(dir, ...args), 'auto', () => false, profileError)
  t.after(() => {
    host.dispose()
    rmSync(dir, { recursive: true, force: true })
    if (previous === undefined) delete process.env.DSH_BROWSER_ATTACH_PORT
    else process.env.DSH_BROWSER_ATTACH_PORT = previous
  })
  const status = () => readRuntimeStatus({
    channel: () => 'edge', hasBinary: () => false, provision: () => ({ state: 'idle' }),
    bridge: () => undefined, endpoint: () => undefined,
    detectBrowser: () => ({ kind: 'edge', path: 'fake-edge' }),
    systemConnection: () => host.connectionStatus(),
  })
  return { host, status, command: () => host.createView().sendCommand('Runtime.evaluate', { expression: '1' }) }
}

test('system readiness is blocked before launch, ready only with live CDP, and blocked again on disconnect', async t => {
  const browser = createFakeBrowser()
  await browser.listen()
  t.after(() => browser.kill())
  let launches = 0
  const h = setup(t, dir => {
    launches++
    writeFileSync(join(dir, 'DevToolsActivePort'), `${browser.port}\n`)
    return Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill() {} })
  })
  assert.equal(h.status().readiness, 'blocked')
  assert.match(h.status().systemBrowser.detail, /has not launched/)
  assert.equal(launches, 0, 'status polling must not launch')
  await h.command()
  assert.equal(h.status().readiness, 'ready')
  browser.dropConnections()
  for (let attempt = 0; attempt < 50 && h.host.connectionStatus().connected; attempt++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.equal(h.status().readiness, 'blocked')
  assert.equal(launches, 1, 'status polling must not relaunch')
  h.host.dispose()
  assert.equal(h.status().readiness, 'blocked')
})

test('launch failure stays visible in runtime status without a different-profile fallback', async t => {
  let launches = 0
  const h = setup(t, () => { launches++; throw new Error('launch permission denied') })
  await assert.rejects(h.command(), /launch permission denied/)
  assert.equal(h.status().readiness, 'blocked')
  assert.match(h.status().systemBrowser.detail, /launch permission denied/)
  assert.equal(h.status().resolvedCarrier, 'system')
  assert.equal(launches, 1)
})

test('default-profile debugging refusal is surfaced without raw browser diagnostics', async t => {
  const h = setup(t, () => {
    const stderr = new EventEmitter()
    const child = Object.assign(new EventEmitter(), { stderr, exitCode: null, signalCode: null, kill() {} })
    queueMicrotask(() => stderr.emit('data', 'private diagnostic URL\nDevTools remote debugging requires a non-default data directory.'))
    return child
  })
  await assert.rejects(h.command(), /refused remote debugging on its default user profile/)
  assert.equal(h.status().readiness, 'blocked')
  assert.match(h.status().systemBrowser.detail, /default user profile/)
  assert.doesNotMatch(h.status().systemBrowser.detail, /private diagnostic/)
})

test('zero-exit launch without DevToolsActivePort reports the possible singleton handoff, not ready', async t => {
  const now = Date.now()
  let offset = 0
  t.mock.method(Date, 'now', () => now + offset)
  const h = setup(t, () => {
    offset = 31000
    return Object.assign(new EventEmitter(), { exitCode: 0, signalCode: null, kill() {} })
  })
  await assert.rejects(h.command(), /exited successfully without DevToolsActivePort/)
  assert.equal(h.status().readiness, 'blocked')
  assert.match(h.status().systemBrowser.detail, /may have handed off/)
  assert.match(h.status().systemBrowser.detail, /No alternative browser profile/)
})

test('an unavailable user-profile path refuses launch instead of using a plugin profile', async t => {
  const h = setup(t, () => assert.fail('must not launch'), 'Selected user profile could not be located; no profile substituted.')
  await assert.rejects(h.command(), /could not be located/)
  assert.equal(h.status().readiness, 'blocked')
  assert.match(h.status().systemBrowser.detail, /could not be located/)
})
