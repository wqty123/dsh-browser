import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

/**
 * The other half of the same cache: a success was kept for the host's lifetime, which
 * is right until the binary it described stops being there — an interrupted reinstall,
 * a removed mount, a wiped cache. Nothing then contradicted the cached "yes": provider
 * selection reads it, so the provider stayed advertised and every later call paid a
 * doomed spawn. Only a real spawn attempt can observe this, which is why the failure
 * paths retire the answer.
 */
test('a cached success does not outlive the binary it described', async () => {
  let scans = 0
  let binaryOnDisk = true
  // The path the host will actually try to spawn: nothing is there, so the failure is the
  // one a deleted binary produces (ENOENT) rather than a crash or a signal.
  const missing = join(tmpdir(), `dsh-no-such-binary-${randomUUID()}.exe`)
  const host = new RemoteElectronViewHost('host-main.js', missing, () => {
    scans++
    if (!binaryOnDisk) throw new Error('Electron binary not found')
  })

  assert.equal(host.available(), true)
  assert.equal(scans, 1)
  assert.equal(host.available(), true)
  assert.equal(scans, 1, 'a cached success does not rescan while it holds')

  // One real attempt is all it takes to discover that the binary is gone.
  const view = host.createView()
  await assert.rejects(() => view.sendCommand('Runtime.evaluate', { expression: '1' }))
  host.dispose()

  // The cached "yes" must not survive the evidence that contradicted it.
  binaryOnDisk = false
  assert.equal(host.available(), false, 'the cached success outlived the binary it described')
  assert.equal(scans, 2, 'the probe ran again instead of reusing the stale answer')
})
