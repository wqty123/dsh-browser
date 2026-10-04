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
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
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
  //
  // A NEW child per launch, which is what a real spawn does. Returning the same object was
  // why this test could not fail: the first child is marked exited before the second launch,
  // so start()'s loop immediately concluded `stopped = 'exited'` and never reconnected — the
  // stale session id was never sent, and deleting the clearing code changed nothing. The
  // reviewer found this by tracing every frame between the host and the fake browser; the
  // "exit listener masks the start() path" explanation I had recorded was only part of it.
  //
  // The mtime is set FORWARD rather than left to the clock. `freshPort()` refuses a
  // DevToolsActivePort older than this launch, which is right — it is what stops a restart
  // from adopting the previous browser's port — but CI's filesystem timestamps have
  // one-second resolution, so a file written in the same second as the spawn could compare
  // as "older" and be rejected for the whole 30 s budget. That is why this was green here
  // and red there: NTFS is finer-grained than the runner's filesystem. Stamping the file
  // explicitly makes the intent true by construction instead of by timing luck.
  let current = createFakeBrowser()
  const browsers = [current]
  let port = await current.listen()
  const launches = []
  const children = []
  const launcher = () => {
    const portFile = join(profileDir, 'DevToolsActivePort')
    writeFileSync(portFile, `${port}\n`)
    const ahead = new Date(Date.now() + 1000)
    utimesSync(portFile, ahead, ahead)
    launches.push(port)
    const child = fakeChild()
    children.push(child)
    return child
  }

  const host = new SystemBrowserViewHost({ kind: 'chrome', path: 'fake-browser' }, profileDir, [], undefined, launcher)
  const view = host.createView()

  try {
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
    browsers.push(current)
    port = await current.listen()
    children[0].exitCode = 0
    children[0].emit('exit', 0, null)

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
  } finally {
    // A failing assertion must not leave listening servers behind: the test process would
    // then never exit, which reads as a hang rather than the failure it actually is.
    // (Killing an already-closed fake resolves anyway, so this is safe on every path.)
    host.dispose()
    for (const browser of browsers) await browser.kill()
    rmSync(profileDir, { recursive: true, force: true })
  }
})

test('a browser that drops its connection without dying does not carry its sessions over', async () => {
  // The ONE route into a restart that reaches start()'s own cleanup. Every other route clears
  // the maps somewhere else first: the process exiting is handled by the exit listener, and
  // dispose() clears them itself — which is why deleting start()'s clearing left this file
  // green. Here the process stays up and only its debugging connection goes away, so nothing
  // has cleaned up by the time start() runs.
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-dropsocket-'))
  const { SystemBrowserViewHost } = await import('../lib/browser-electron/system-browser.js')

  const browser = createFakeBrowser()
  const browserPort = await browser.listen()
  const launcher = () => {
    // A replacement process: the port file is written by THIS launch, the way a real browser
    // writes its own, so the host reconnects to the browser it just started.
    const portFile = join(profileDir, 'DevToolsActivePort')
    writeFileSync(portFile, `${browserPort}\n`)
    // Stamped forward for the same reason as the first launcher: CI's timestamp
    // resolution can make a file written in this same second compare as older than the
    // spawn, and freshPort() would then refuse it for the whole budget.
    const ahead = new Date(Date.now() + 1000)
    utimesSync(portFile, ahead, ahead)
    return fakeChild()
  }

  const host = new SystemBrowserViewHost({ kind: 'chrome', path: 'fake-browser' }, profileDir, [], undefined, launcher)
  const view = host.createView()
  try {
    await view.sendCommand('Runtime.evaluate', { expression: '1' })
    const droppedSession = browser.sessionId
    assert.match(droppedSession, /^session-/, 'the fake issued a session id')

    // The connection dies; the process does not.
    browser.dropConnections()

    // The first call is the one that discovers the connection is dead, so it is allowed to
    // fail — that is how this carrier decides to rebuild. What matters is what the NEXT call
    // sends, because that is where a session id from the dropped connection would be replayed.
    const discovered = await view.sendCommand('Runtime.evaluate', { expression: '2' }).then(() => 'ok', error => String(error.message))
    const after = await view.sendCommand('Runtime.evaluate', { expression: '3' }).then(() => 'ok', error => String(error.message))

    assert.doesNotMatch(
      after,
      /Session with given id not found/,
      `the reconnected browser was sent a session id issued before the drop (first call: ${discovered})`,
    )
    // And it really did recover onto the browser it started: without this half, a host that
    // never reconnected at all would satisfy the assertion above.
    assert.equal(after, 'ok', `the host did not recover after the drop: ${after}`)
    assert.equal(browser.connections, 2, 'the host reconnected exactly once, to the browser it started')
  } finally {
    host.dispose()
    await browser.kill()
    rmSync(profileDir, { recursive: true, force: true })
  }
})

test('the next launch uses the port its own browser wrote, not the stale file', async () => {
  // A killed browser never removes DevToolsActivePort, so after the first restart the file
  // always describes the previous browser. Reading it means connecting to whatever holds that
  // port now — a client this host did not start and cannot kill.
  //
  // This case previously asserted only that the stale browser was NOT contacted, which a
  // discovery loop that never worked at all also satisfies. The positive half — the host
  // connects to the browser THIS launch produced — is what makes the negative half mean
  // something, and the launcher below is the only place that can observe the removal itself
  // rather than its consequences.
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-staleport-'))
  const { SystemBrowserViewHost } = await import('../lib/browser-electron/system-browser.js')

  const portFile = join(profileDir, 'DevToolsActivePort')
  const first = createFakeBrowser()
  const firstPort = await first.listen()
  writeFileSync(portFile, `${firstPort}\n`)

  const second = createFakeBrowser()
  const secondPort = await second.listen()
  const child = fakeChild()
  /** Whether the previous browser's file was still on disk AT SPAWN TIME. */
  let staleAtSpawn
  const host = new SystemBrowserViewHost({ kind: 'chrome', path: 'fake-browser' }, profileDir, [], undefined, () => {
    // The fix removes the stale file BEFORE spawning, so it must already be gone here.
    // Only the freshness check would survive without this observation, which is why
    // deleting the removal left every assertion green before.
    staleAtSpawn = existsSync(portFile)
    // This launch's browser writes ITS OWN port when it comes up, exactly as a real one
    // does — so both halves of the behaviour are decidable: the stale file is refused, and
    // the port this process wrote is the one adopted.
    writeFileSync(portFile, `${secondPort}\n`)
    // Stamped forward, like the other two launchers: `freshPort()` refuses a file older than
    // the spawn, and CI's one-second timestamp resolution can make a file written in this same
    // second compare as older — which is exactly what this test exists to distinguish, so it
    // must not also be able to fail for a reason that has nothing to do with the behaviour.
    const ahead = new Date(Date.now() + 1000)
    utimesSync(portFile, ahead, ahead)
    return child
  })
  const view = host.createView()
  try {
    const outcome = await view.sendCommand('Runtime.evaluate', { expression: '1' }).then(() => 'ok', error => String(error.message))

    // POSITIVE: the host reached the browser this launch produced.
    assert.notEqual(secondPort, firstPort, 'the two fakes listen on different ports')
    assert.equal(outcome, 'ok', `the host must connect to the browser it started (outcome: ${outcome})`)
    assert.match(String(second.sessionId), /^session-/, 'the browser this launch started is the one that answered')

    // NEGATIVE: the browser the stale file names was never contacted.
    assert.notEqual(first.sessionId, undefined, 'the first fake is real')
    assert.equal(first.sessionId, '', 'the host never spoke to the browser named by the stale port file')

    // And the stale file was actually removed, not merely judged stale.
    assert.equal(staleAtSpawn, false, 'the stale port file was still on disk when the browser was spawned')
  } finally {
    // A failing assertion must not leave two listening servers behind: the test process
    // would then never exit, and a mutation run would hang instead of reporting red.
    host.dispose()
    child.exitCode = 0
    await first.kill()
    await second.kill()
    rmSync(profileDir, { recursive: true, force: true })
  }
})
