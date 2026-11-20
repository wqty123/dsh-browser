// A CDP port that accepts connections and then says nothing forever.
//
// The launch loop reads `DevToolsActivePort`, tries `/json/version` on the port inside it, and
// waits 250 ms between attempts under a 30 s deadline. A server that ANSWERS is handled by the
// ordinary path; a server that REFUSES (nothing listening) fails fast and the loop spins. The
// case with no coverage either way is the third one: a socket that accepts and never replies.
// An unbounded fetch parks on that for the rest of the budget, and the deadline above is only
// re-checked between iterations — so the launch stops being a loop and becomes a hang.
//
// This is what `PORT_PROBE_MS` exists for, and it is invisible to every test that uses a
// well-behaved fake: they all answer.
//
// The observable difference is the NUMBER OF ATTEMPTS, not the elapsed time — a launch that
// hangs on one socket and a launch that polls both end at the 30 s deadline. An unbounded probe
// parks inside a single iteration, so the socket is connected to ONCE; a bounded one gives up
// after 250 ms, waits, and tries again, so the socket is connected to repeatedly. The server
// counts the connections, which is the only thing that can tell the two apart.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

test('a port that accepts and never answers does not hang the launch', async () => {
  const { SystemBrowserViewHost } = await import('../lib/browser-electron/system-browser.js')
  const profileDir = mkdtempSync(join(tmpdir(), 'dsh-blackhole-'))

  // Accept every connection and hold it open without writing a byte.
  const held = []
  let connections = 0
  const server = createServer(socket => {
    connections += 1
    held.push(socket)
    // Deliberately no socket.write: this is the black hole.
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port

  const host = new SystemBrowserViewHost(
    { kind: 'chrome', path: 'fake-browser' },
    profileDir,
    [],
    undefined,
    () => {
      const portFile = join(profileDir, 'DevToolsActivePort')
      writeFileSync(portFile, `${port}\n`)
      // Stamped forward so freshPort() accepts it: this test is about the PROBE being bounded,
      // not about the freshness check, and CI's timestamp resolution would otherwise decide it.
      const ahead = new Date(Date.now() + 1000)
      utimesSync(portFile, ahead, ahead)
      return fakeChild()
    },
  )

  const started = Date.now()
  const view = host.createView()
  try {
    await view.sendCommand('Runtime.evaluate', { expression: '1' })
    assert.fail('a black-holed port must not produce a working view')
  } catch (error) {
    const elapsed = Date.now() - started
    // It has to fail, and fail for the right reason — not by some other route.
    assert.match(String(error.message), /did not expose CDP|timed out|released/i)
    // The launch ends at the deadline either way; what distinguishes a bounded probe from a
    // hung one is how many times it knocked. Unbounded parks on ONE connection for the whole
    // budget, so this is the assertion that fails if the bound is removed.
    assert.ok(
      connections > 3,
      `the probe connected ${connections} time(s) in ${elapsed} ms — an unbounded fetch parks on `
      + 'one connection instead of retrying, so this stayed low',
    )
  } finally {
    host.dispose()
    for (const socket of held) socket.destroy()
    await new Promise(resolve => server.close(resolve))
    rmSync(profileDir, { recursive: true, force: true })
  }
})
