import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { carrierHarness, Sidebar } from './carrier-harness.mjs'
import { BridgeConnection } from '../lib/browser-electron/bridge-connection.js'
import { DesktopBridgeViewHost } from '../lib/browser-electron/desktop-bridge-host.js'

test('sidebar loss reports the actual cause without selecting a standalone browser', async t => {
  const sidebar = new Sidebar()
  let current = sidebar
  const h = carrierHarness(t, { discover: async () => current })
  const view = h.current.createView('session-owner')
  await view.sendCommand('Runtime.evaluate')
  sidebar.lose('panel-unusable')
  assert.match(h.warnings[0], /shell is running.*cannot be driven.*panel-unusable/)
  assert.doesNotMatch(h.warnings[0], /has exited/)
  await new Promise(setImmediate)
  const next = new Sidebar()
  current = next
  await view.sendCommand('Runtime.evaluate')
  next.lose('shell-exited')
  assert.match(h.warnings[1], /shell.*has exited.*shell-exited/)
  assert.equal(h.registered.length, 1)
})

test('a real bridge transport forwards shell loss through the sidebar to the entry logger', async t => {
  const discover = DesktopBridgeViewHost.discover.bind(DesktopBridgeViewHost)
  const h = carrierHarness(t, { discover })
  const file = join(process.env.DSH_HOME, 'dsh-builtin-browser-bridge.json')
  writeFileSync(file, JSON.stringify({ port: 1, token: 'fixture', pid: 999999, updatedAt: new Date(0).toISOString() }))
  const original = BridgeConnection.prototype.call
  t.mock.method(BridgeConnection.prototype, 'call', function (request, timeout) {
    if (request.op === 'list') return Promise.resolve({ ok: true, frame: 'webview' })
    return original.call(this, request, timeout)
  })
  await assert.rejects(h.current.createView('session-owner').sendCommand('Page.navigate', { url: 'https://example.com' }), /has exited/)
  assert.match(h.warnings.join('\n'), /shell-exited/)
  assert.equal(h.registered.length, 1)
})

test('disposal preserves the in-flight failure and happens on a later turn', async t => {
  const sidebar = new Sidebar()
  let rejectPending
  sidebar.createView = () => ({ id: 'guest', sendCommand: () => new Promise((resolve, reject) => {
    rejectPending = reject
    sidebar.lose('panel-unusable')
    queueMicrotask(() => reject(new Error('sidebar unavailable (cannot drive this panel)')))
  }) })
  sidebar.dispose = () => { sidebar.disposed = true; rejectPending(new Error('bridge closed')) }
  const h = carrierHarness(t, { discover: async () => sidebar })
  await assert.rejects(h.current.createView('session-owner').sendCommand('Runtime.evaluate'), /sidebar unavailable \(cannot drive this panel\)/)
  assert.equal(sidebar.disposed, false)
  await new Promise(setImmediate)
  assert.equal(sidebar.disposed, true)
  assert.match(h.warnings.join('\n'), /panel-unusable/)
})

test('startedAt records when the bridge started, not when it last said hello', () => {
  const bridge = readFileSync(new URL('../desktop-bridge/plugin-browser-bridge.js', import.meta.url), 'utf8')
  const fn = bridge.slice(bridge.indexOf('function publishEndpoint('))
  const body = fn.slice(0, fn.indexOf('\n}'))
  assert.match(body, /startedAt: instanceStartedAt\(\)/)
  assert.doesNotMatch(body, /startedAt: new Date\(\)\.toISOString\(\)/)
  assert.match(body, /updatedAt: new Date\(\)\.toISOString\(\)/)
  assert.match(body, /endpointFile\(dshHome\)/)
  assert.match(bridge, /const instanceStartedAt = \(\(\) => \{/)
  assert.match(bridge, /const at = new Date\(\)\.toISOString\(\)\n\s*return \(\) => at/)
})
