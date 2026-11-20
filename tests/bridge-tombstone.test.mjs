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
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { BridgeConnection } from '../lib/browser-electron/bridge-connection.js'

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

test('a carrier that borrows an outside process can report its loss', () => {
  // The interface point the fallback hangs on. Removing `onLost` from the bridge host while
  // leaving `adopt`'s listener would be a silent regression: the listener would simply never run.
  const host = readFileSync(new URL('../src/browser-electron/desktop-bridge-host.ts', import.meta.url), 'utf8')
  assert.match(host, /onLost\(listener: \(reason: CarrierLossReason\) => void\): void \{/,
    'the bridge host accepts a listener carrying the reason')
  // The transport can only conclude one thing — the shell stopped refreshing its endpoint — so it
  // reports that, while the panel failure is reported where it is observed.
  assert.match(host, /new BridgeConnection\(endpoint, bridgeEndpointPath\(\), \(\) => this\.reportLost\('shell-exited'\)\)/,
    'and wires it into the transport, which reports an exiting shell')

  const entry = readFileSync(new URL('../src/browser-electron/entry.ts', import.meta.url), 'utf8')
  assert.match(entry, /host\.onLost\?\.\(reason => \{ restoreSelfHosted\(host, reason\) \}\)/,
    'entry point reacts by restoring the self-hosted browser')
  assert.match(entry, /const restoreSelfHosted = \(adopted: ElectronBrowserViewHost, reason: CarrierLossReason\): void => \{/,
    'through a function that exists precisely for it')
})
