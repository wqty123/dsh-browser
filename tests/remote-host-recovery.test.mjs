import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { RemoteElectronViewHost } from '../lib/browser-electron/remote-host.js'

// These tests spawn real children, and the host writes one line per spawn and
// per exit to `$DSH_HOME/logs/dsh-builtin-browser-host.log` — the very log an
// operator reads to diagnose a crash loop. Without isolation this file appends
// synthetic spawn/exit records (identifiable only by `electron=<node.exe>`) to
// that real log and makes its history unreadable.
//
// Module scope on purpose, not a `before()` hook: the host reads DSH_HOME when it
// writes, and a hook that runs after the first test body would already be too
// late. The temp directory simply outlives the process.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-hostlog-recovery-'))

/**
 * Regression for issue #5: after the browser host dies (crash, or the DSH
 * process that spawned it was restarted), an ALREADY-MATERIALIZED view
 * handle used to fail forever with "browser host is not running" — the cached
 * materialization stayed bound to the dead child, so no operation could ever
 * trigger a restart. Only a brand-new view (new session / dsh_browser_reset_session)
 * recovered. The fix: a dead-host failure drops the cached materialization,
 * rebuilds the view against a freshly spawned child, and retries the
 * operation once — so surviving sessions self-heal on their first call.
 *
 * The child is a plain-Node fixture speaking the same RPC protocol as
 * host-main.js (see ./fixtures/fake-host-child.mjs), so this runs without an
 * Electron binary or display.
 */
test('a materialized view handle auto-recovers after its browser host dies', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/fake-host-child.mjs', import.meta.url))
  const host = new RemoteElectronViewHost(fixture, process.execPath)
  const view = host.createView()
  try {
    // First use: the host spawns the child and the view materializes.
    const first = await view.sendCommand('Runtime.evaluate', { expression: '1 + 1' })
    assert.equal(first.value, 'fake')

    // Simulate the browser host dying (crash, or the DSH restart that kills
    // the managed child). The child exits mid-command; the pending RPC is
    // rejected as host-gone and the operation is retried once against a fresh
    // child — which dies the same way, so the call ultimately rejects.
    await assert.rejects(() => view.sendCommand('__die'), /host/)

    // THE regression assertion: the SAME handle must recover on its next call
    // — the host is restarted and the operation retried, instead of failing
    // forever with "browser host is not running".
    const recovered = await view.sendCommand('Runtime.evaluate', { expression: '2 + 2' })
    assert.equal(recovered.value, 'fake')
  } finally {
    host.dispose()
  }
})

test('a disposed host refuses operations immediately without spawning a child', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/fake-host-child.mjs', import.meta.url))
  const host = new RemoteElectronViewHost(fixture, process.execPath)
  host.dispose()
  const view = host.createView()
  // The recovery path re-enters ready() after dispose cleared its state: the
  // host must fail fast with the disposed error instead of spawning a fresh
  // child that would then outlive the host (a zombie window nobody disposes).
  await assert.rejects(() => view.sendCommand('Runtime.evaluate', { expression: '1' }), /disposed/)
  // Still disposed afterwards: no retry path spawns either.
  await assert.rejects(() => view.sendCommand('Runtime.evaluate', { expression: '1' }), /disposed/)
})
