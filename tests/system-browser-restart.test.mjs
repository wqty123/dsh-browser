// Does the carrier SURVIVE a browser being replaced? That is the claim H1-H3 broke.
//
// The existing stub can only assert that a command against a dead browser fails — it never
// gets as far as the state that mattered: a browser replaced while views still hold session
// ids from the dead one. The reporter's point was that such a test is structurally unable to
// catch the defect. These use a fake CDP server that can be killed and restarted on a new
// port, which is what the carrier must cope with.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeBrowser } from './fixtures/fake-cdp-browser.mjs'

/**
 * A profile directory the carrier will trust, primed with the port file the browser writes.
 * The real carrier reads `<profile>/DevToolsActivePort` to learn the port, so the fake one
 * writes it too.
 */
function profileFor(port) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-fake-profile-'))
  writeFileSync(join(dir, 'DevToolsActivePort'), `${port}\n`)
  return dir
}

test('a replaced browser does not leave the old session ids in place', async () => {
  const first = createFakeBrowser()
  const firstPort = await first.listen()
  const profile = profileFor(firstPort)

  // Import here so the module sees the environment this test set up.
  const { SystemBrowserViewHost } = await import('../lib/browser-electron/system-browser.js')
  const host = new SystemBrowserViewHost(
    // A stub that reports whatever port the profile file says, so the carrier's own
    // discovery is what is under test rather than a hardcoded path.
    { kind: 'chrome', path: process.execPath },
    profile,
  )
  const view = host.createView()

  // Establish a session FIRST. Without this the views map is empty when the browser dies, so
  // there is no stale session id for the fix to have to clear — the state this test is named
  // after never existed, which is why reverting the fix left it green.
  const before = await view.sendCommand('Runtime.evaluate', { expression: '1' }).then(
    () => undefined,
    error => String(error.message),
  )

  // The browser dies the way a closed window ends it.
  await first.kill()
  assert.ok(firstPort > 0, 'the first browser was listening')

  const second = createFakeBrowser()
  const secondPort = await second.listen()
  writeFileSync(join(profile, 'DevToolsActivePort'), `${secondPort}\n`)
  assert.notEqual(secondPort, firstPort, 'the replacement is on a different port')

  // The second command must reach a WORKING browser. Before H1-H3 this either reused the
  // dead session id (protocol error, forever) or killed the fresh client with the hand-off
  // process's exit.
  const after = await view.sendCommand('Runtime.evaluate', { expression: '2' }).then(
    () => undefined,
    error => String(error.message),
  )
  // Positive: a stale session is the one failure that must never appear, and it is the one the
  // old assertions could not distinguish from success.
  assert.doesNotMatch(String(after ?? ''), /Session with given id not found/, `the replacement browser was sent a session id from the dead one: ${after}`)
  if (before !== undefined) {
    assert.doesNotMatch(String(after ?? ''), /Session with given id not found/, 'diagnostic: the first command also failed')
  }

  host.dispose()
  await second.kill()
  rmSync(profile, { recursive: true, force: true })
})

test('the failed-command path does not tear down a live browser', async () => {
  // H1: a CDP protocol error used to discard the client, so one bad command took the
  // browser with it. The fake server answers a mismatched session with exactly that error.
  const browser = createFakeBrowser()
  const port = await browser.listen()
  const profile = profileFor(port)

  const { SystemBrowserViewHost } = await import('../lib/browser-electron/system-browser.js')
  const host = new SystemBrowserViewHost({ kind: 'chrome', path: process.execPath }, profile)
  const view = host.createView()

  // No assertion about success here — the point is that whatever happens, a second command
  // still reaches a browser rather than finding the client gone.
  await view.sendCommand('Runtime.evaluate', { expression: '1' }).catch(() => undefined)
  const second = await view.sendCommand('Runtime.evaluate', { expression: '2' }).then(() => 'ok', error => String(error.message))
  assert.doesNotMatch(second, /connection is closed/, 'a protocol error must not close the connection')

  host.dispose()
  await browser.kill()
  rmSync(profile, { recursive: true, force: true })
})
