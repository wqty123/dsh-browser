// Freshness of the port file, without a clock in the comparison.
//
// CI failed on this: a fake browser the test had just started was reported as
//   'dsh-builtin-browser: chrome (fake-browser) did not expose CDP within 30s'
// after waiting out the whole budget, while the browser was listening the entire time.
//
// The cause was the freshness test itself: `statSync(portFile).mtimeMs < spawnedAt` compares a
// FILESYSTEM timestamp against `Date.now()`. Those are different clocks with different
// resolutions, so on a filesystem whose mtime resolution is coarser than a millisecond the file
// just written reports an mtime that rounds DOWN below the spawn time, and the loop refuses to
// look at it. That is not a test-only problem — on such a filesystem the plugin would never see
// the browser it had just launched.
//
// The fix judges freshness against a SNAPSHOT taken before the launch, so the comparison is
// between two filesystem observations rather than between a file and a clock.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeBrowser } from './fixtures/fake-cdp-browser.mjs'

/** A child-process stub the launcher returns; the host only reads exit codes off it. */
function fakeChild() {
  return { exitCode: null, signalCode: null, kill() {}, once() {}, on() {} }
}

/**
 * A host whose launcher writes a port file carrying a mtime in the PAST.
 *
 * That is what a coarse filesystem timestamp looks like from inside the process, and it is exactly
 * the state CI was in. `staleMtime` controls it; the file's contents are always the live port.
 */
async function hostWithCoarseTimestamp(browser, { staleMtime }) {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-coarse-'))
  const { SystemBrowserViewHost } = await import('../lib/browser-electron/system-browser.js')
  const portFile = join(profileDir, 'DevToolsActivePort')
  const host = new SystemBrowserViewHost(
    { kind: 'chrome', path: 'fake-browser' },
    profileDir,
    [],
    undefined,
    () => {
      writeFileSync(portFile, `${browser.port}\n`)
      // Backdate it, AFTER writing: the contents are the browser's real port, only the timestamp
      // is coarse. Nothing is deleted, so this cannot pass by the file being absent.
      const when = new Date(Date.now() - staleMtime)
      utimesSync(portFile, when, when)
      return fakeChild()
    },
  )
  return { host, profileDir, portFile }
}

test('a port file whose mtime predates the launch is still accepted', async () => {
  // The CI condition. 5s in the past is far more than any rounding a coarse filesystem does; the
  // point is that the timestamp is not what decides.
  const browser = createFakeBrowser({ blanks: ['only-blank'] })
  await browser.listen()
  const { host, profileDir } = await hostWithCoarseTimestamp(browser, { staleMtime: 5000 })
  const view = host.createView()
  try {
    const outcome = await view.sendCommand('Runtime.evaluate', { expression: '1' })
      .then(() => 'ok', error => String(error.message))
    assert.equal(outcome, 'ok',
      `the browser is listening and must be reached regardless of its file's timestamp (${outcome})`)
    // And it is the SAME file this launch wrote: a stale file from a previous browser is still
    // refused, which is the property the old check was protecting (see the next test).
    assert.equal(statSync(join(profileDir, 'DevToolsActivePort')).mtimeMs < Date.now(), true,
      'the file really does carry a past timestamp')
  } finally {
    host.dispose()
    await browser.kill()
    rmSync(profileDir, { recursive: true, force: true })
  }
})

test('a file left over from a previous browser is still refused', async () => {
  // The protection must survive the fix: a port file that did not change across this launch names
  // the PREVIOUS browser, and its port may now belong to something else entirely. Here the file
  // exists before the launch with a live port in it, and the launcher writes nothing new — so the
  // snapshot and the file are identical, and the host must not adopt that port.
  const browser = createFakeBrowser({ blanks: ['only-blank'] })
  await browser.listen()
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-stale-'))
  const portFile = join(profileDir, 'DevToolsActivePort')
  writeFileSync(portFile, `${browser.port}\n`) // written by an imaginary earlier run

  const { SystemBrowserViewHost } = await import('../lib/browser-electron/system-browser.js')
  const host = new SystemBrowserViewHost(
    { kind: 'chrome', path: 'no-such-browser-at-all' },
    profileDir,
    [],
    undefined,
    // This launch fails outright and writes nothing, so the only port file present is the stale one.
    () => { throw new Error('ENOENT') },
  )
  const view = host.createView()
  try {
    const outcome = await view.sendCommand('Runtime.evaluate', { expression: '1' })
      .then(() => 'ok', error => String(error.message))
    assert.notEqual(outcome, 'ok', 'a port from a previous browser must not be adopted')
    // It must be the LAUNCH that failed, not a CDP timeout: adopting the stale port would have
    // connected happily and left a client the host does not own.
    assert.match(outcome, /ENOENT|no-such-browser|could not|failed/i,
      `the reported cause must be the launch, not a CDP timeout: ${outcome}`)
  } finally {
    host.dispose()
    await browser.kill()
    rmSync(profileDir, { recursive: true, force: true })
  }
})
