import { testTab, testScope, tabIn } from './canonical-fixtures.mjs'
// A desktop shell that exits leaves its endpoint file behind.
//
// The file is the ONLY thing that says where the bridge is, so a tombstone in it names a port
// nobody owns. Trusting that port is not a slow degradation — every later call fails against a
// dead address, and because the carrier swap happens once at startup, nothing ever revisits the
// decision. Reported from real use as "the browser stopped working and only restarting DSH brought
// it back".
//
// What makes the tombstone detectable is the field the live shell keeps refreshing: its keep-alive
// rewrites `updatedAt` every fifteen seconds.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BridgeConnection } from '../lib/browser-electron/bridge-connection.js'
import { carrierHarness, Sidebar } from './carrier-harness.mjs'

/** An endpoint file with a chosen age, on a port nothing listens on. */
function endpointFile(ageMs) {
  const file = join(mkdtempSync(join(tmpdir(), 'bridge-tombstone-')), 'endpoint.json')
  writeFileSync(file, JSON.stringify({
    port: 1,
    token: 'token-nobody-serves',
    pid: 999_999,
    updatedAt: new Date(Date.now() - ageMs).toISOString(),
  }))
  return file
}

test('a shell that stopped refreshing its endpoint is reported gone, not dialled forever', async () => {
  const file = endpointFile(3_600_000)
  let lost = 0
  const connection = new BridgeConnection({ port: 1, token: 'token-nobody-serves', pid: 999_999 }, file, () => { lost += 1 })

  await assert.rejects(
    () => connection.call({ op: 'version' }, 5_000),
    /has exited/,
    'the failure names the cause instead of surfacing as a bare ECONNREFUSED',
  )
  assert.equal(lost, 1, 'and the surface is told, so it can fall back')

  await assert.rejects(() => connection.call({ op: 'version' }, 5_000), /has exited/)
  assert.equal(lost, 1, 'reported exactly once, however many calls follow')
})

test('an endpoint that is still being refreshed is used normally', async () => {
  // The guard must not fire on a live shell: a fresh stamp means the shell is there, and the
  // connection then fails for the ordinary reason (nothing listening on this test port).
  const file = endpointFile(0)
  let lost = 0
  const connection = new BridgeConnection({ port: 1, token: 'token-nobody-serves', pid: 999_999 }, file, () => { lost += 1 })

  await assert.rejects(() => connection.call({ op: 'version' }, 3_000), (error) => !/has exited/.test(String(error.message)))
  assert.equal(lost, 0, 'a live endpoint is never called gone')
})

test('an endpoint with no stamp at all keeps working', async () => {
  // An older bridge never wrote `updatedAt`. Absence must not read as staleness, or every shell
  // older than the field would be declared dead on first use.
  const file = join(mkdtempSync(join(tmpdir(), 'bridge-nostamp-')), 'endpoint.json')
  writeFileSync(file, JSON.stringify({ port: 1, token: 'token-nobody-serves', pid: 999_999 }))
  let lost = 0
  const connection = new BridgeConnection({ port: 1, token: 'token-nobody-serves', pid: 999_999 }, file, () => { lost += 1 })

  await assert.rejects(() => connection.call({ op: 'version' }, 3_000), (error) => !/has exited/.test(String(error.message)))
  assert.equal(lost, 0, 'no stamp is not the same answer as an old stamp')
})

test('a borrowed carrier reports its loss and reconnects only the sidebar', async t => {
  const first = new Sidebar(), second = new Sidebar()
  let discoveries = 0
  const h = carrierHarness(t, { discover: async () => ++discoveries === 1 ? first : second })
  const host = h.current
  const view = host.createView(testTab('session-owner'))
  await view.sendCommand('Runtime.evaluate')
  first.lose('shell-exited')
  assert.equal(first.disposed, false)
  await new Promise(setImmediate)
  assert.equal(first.disposed, true)
  assert.match(h.warnings.join('\n'), /shell-exited/)
  assert.deepEqual(await view.sendCommand('Runtime.evaluate'), { method: 'Runtime.evaluate', owner: 'session-owner' })
  assert.equal(discoveries, 2)
  assert.equal(h.current, host)
  assert.deepEqual(h.registered, [host], 'loss never installs an external carrier')
})
