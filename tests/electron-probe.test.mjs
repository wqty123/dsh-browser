import { test } from 'node:test'
import assert from 'node:assert/strict'

/**
 * The Electron-binary probe used to be cached for the whole host lifetime —
 * including a NEGATIVE result. Since provider selection also happens once per
 * DSH process, an Electron that arrived later (`npm i electron`, or the package
 * postinstall that downloads the binary) could never be picked up without a
 * DSH restart: every browser call answered "no usable browser provider is
 * registered" even though the binary was now on disk.
 *
 * The probe window is read at module load, hence the env assignment above the
 * dynamic import. The third constructor argument is the probe seam.
 */
process.env.DSH_BROWSER_PROBE_RETRY_MS = '20'
// Isolate the host log: this file constructs real hosts, which write a spawn line
// (and an exit line) to `$DSH_HOME/logs/dsh-builtin-browser-host.log` — the log an
// operator reads to diagnose a crash loop. Writing synthetic entries there would
// make its history unreadable. Module scope, set before the dynamic import below.
process.env.DSH_HOME = (await import('node:fs')).mkdtempSync(
  (await import('node:path')).join((await import('node:os')).tmpdir(), 'dsh-probe-'),
)
const { RemoteElectronViewHost } = await import('../lib/browser-electron/remote-host.js')

const settle = (ms) => new Promise(resolve => setTimeout(resolve, ms))

test('a failed Electron probe expires instead of poisoning the process', async () => {
  let scans = 0
  let binaryOnDisk = false
  const host = new RemoteElectronViewHost('host-main.js', undefined, () => {
    scans++
    if (!binaryOnDisk) throw new Error('Electron binary not found')
  })

  assert.equal(host.available(), false)
  assert.equal(scans, 1)
  // Within the retry window the cached answer is reused — no scan per call.
  assert.equal(host.available(), false)
  assert.equal(scans, 1)

  // Once the window passes, the search runs again: a late-installed Electron
  // heals the provider on its own.
  binaryOnDisk = true
  await settle(150)
  assert.equal(host.available(), true)
  assert.equal(scans, 2)

  // A success is kept, so the hot path never scans again.
  await settle(150)
  assert.equal(host.available(), true)
  assert.equal(scans, 2)
})
