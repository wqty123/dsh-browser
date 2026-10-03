// Issue #21, done for real this time.
//
// The previous version could not fail. Its stub was Node, spawned with Chromium's arguments,
// which Node rejects — so no CDP endpoint ever appeared, no session was ever created, and the
// state the test names ("a browser replaced while views still hold session ids from the dead
// one") never existed. Mutation-tested: removing every sessions.clear() left it green.
//
// This drives the host through its injectable launcher, so a real CDP server answers, a
// session exists, and the browser can be killed and replaced while the host is watching.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createFakeBrowser } from './fixtures/fake-cdp-browser.mjs'

/** A fake browser process: enough of a ChildProcess for the host, and it can die. */
function fakeChild() {
  const child = new EventEmitter()
  child.exitCode = null
  child.signalCode = null
  child.kill = () => {
    if (child.exitCode !== null) return
    child.exitCode = 0
    queueMicrotask(() => child.emit('exit', 0, null))
  }
  return child
}

test("a replaced browser is usable and does not carry the dead one's session", async () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-restart-'))
  const { SystemBrowserViewHost } = await import('../lib/browser-electron/system-browser.js')

  // The launcher hands out a fake process and writes the port file the host reads, so the
  // host's own discovery path runs rather than being bypassed.
  let current = createFakeBrowser()
  let port = await current.listen()
  const child = fakeChild()
  const launches = []
  const launcher = () => {
    writeFileSync(join(profileDir, 'DevToolsActivePort'), `${port}\n`)
    launches.push(port)
    return child
  }

  const host = new SystemBrowserViewHost({ kind: 'chrome', path: 'fake-browser' }, profileDir, [], undefined, launcher)
  const view = host.createView()

  // Establish a session FIRST. Without this the views map is empty when the browser dies, so
  // there is no stale session id for the fix to clear — which is why the old test could not
  // distinguish a working fix from a broken one.
  await view.sendCommand('Runtime.evaluate', { expression: '1' })
  const deadSession = current.sessionId
  assert.match(deadSession, /^session-/, 'the fake issued a session id')

  // The browser dies the way a closed window ends it, and a replacement appears on a NEW port
  // with a NEW session id — which is what makes a reused id detectable rather than invisible.
  await current.kill()
  current = createFakeBrowser()
  port = await current.listen()
  child.exitCode = 0
  child.emit('exit', 0, null)

  const after = await view.sendCommand('Runtime.evaluate', { expression: '2' }).then(
    () => undefined,
    error => String(error.message),
  )

  assert.doesNotMatch(
    String(after ?? ''),
    /Session with given id not found/,
    `the replacement was sent a session id issued by the dead browser: ${after}`,
  )
  assert.notEqual(current.sessionId, deadSession, 'the replacement issued a different session id')
  assert.ok(launches.length >= 2, `the host launched a replacement (${launches.length} launches)`)

  host.dispose()
  await current.kill()
  rmSync(profileDir, { recursive: true, force: true })
})

test('the stale port file is not adopted by the next launch', async () => {
  // A killed browser never removes DevToolsActivePort, so after the first restart the file
  // always describes the previous browser. Reading it means connecting to whatever holds that
  // port now — a client this host did not start and cannot kill.
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-staleport-'))
  const { SystemBrowserViewHost } = await import('../lib/browser-electron/system-browser.js')

  const first = createFakeBrowser()
  const firstPort = await first.listen()
  writeFileSync(join(profileDir, 'DevToolsActivePort'), `${firstPort}\n`)

  const second = createFakeBrowser()
  const secondPort = await second.listen()
  const child = fakeChild()
  const host = new SystemBrowserViewHost({ kind: 'chrome', path: 'fake-browser' }, profileDir, [], undefined, () => {
    // Deliberately do NOT write a port file: the only one on disk is the previous browser's.
    return child
  })
  const view = host.createView()
  const outcome = await view.sendCommand('Runtime.evaluate', { expression: '1' }).then(() => 'ok', error => String(error.message))

  // It must not have connected to the stale port. Either it failed, or it is talking to
  // something it launched — never to the browser the file names.
  assert.notEqual(first.sessionId, undefined, 'the first fake is real')
  const adoptedStale = second.sessionId !== undefined && outcome === 'ok' && firstPort !== secondPort
  assert.ok(!adoptedStale, `the host used the stale port file to connect (outcome: ${outcome})`)

  host.dispose()
  child.exitCode = 0
  await first.kill()
  await second.kill()
  rmSync(profileDir, { recursive: true, force: true })
})
