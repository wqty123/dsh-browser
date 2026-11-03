// "Installed" versus "running": the distinction the readiness panel exists to make.
//
// A shell whose bridge is installed and which is not running is the most common broken state there
// is (the desktop app is closed). Reading only the install tree calls that ready; reading only the
// endpoint file cannot tell whether our patch is even in the shell being dialled. So the report
// takes both, and these are the readings that feed the second half.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { readBridgeEndpoint } from '../lib/browser-electron/bridge-endpoint.js'

const dir = mkdtempSync(join(tmpdir(), 'dsh-bridge-endpoint-'))
let seq = 0

/** Write an endpoint file and return its path. */
function endpoint(contents) {
  const path = join(dir, `endpoint-${seq += 1}.json`)
  writeFileSync(path, typeof contents === 'string' ? contents : JSON.stringify(contents), 'utf8')
  return path
}

/** The reading of a file written for this pid, so the pid check is genuinely alive. */
const aliveFor = () => ({ port: 65402, token: 't', pid: process.pid, updatedAt: new Date().toISOString() })

test('no file at all means no shell has published one', () => {
  const state = readBridgeEndpoint(join(dir, 'nope.json'))
  assert.equal(state.present, false)
  assert.equal(state.alive, false)
  assert.match(state.detail, /no desktop shell/)
})

test('an unreadable file is a state, not an exception', () => {
  // A directory in the endpoint's place is the nastiest shape: it exists, so `existsSync` says yes,
  // and reading it throws EISDIR. A panel must still get an answer.
  const state = readBridgeEndpoint(dir)
  assert.equal(state.present, true)
  assert.equal(state.alive, false)
  assert.match(state.detail, /unreadable/)
})

test('malformed JSON is unreadable rather than fatal', () => {
  const state = readBridgeEndpoint(endpoint('{ this is not json'))
  assert.equal(state.present, true)
  assert.equal(state.alive, false)
  assert.match(state.detail, /unreadable/)
})

test('a fresh stamp with a live pid is a running shell', () => {
  const state = readBridgeEndpoint(endpoint(aliveFor()))
  assert.equal(state.alive, true)
  assert.match(state.detail, /running/)
  assert.ok(state.updatedAt !== undefined, 'and the stamp it based that on is reported')
})

test('a stamp nobody refreshed for over a minute is a tombstone', () => {
  // A live shell rewrites the file every ~15 s. Four missed refreshes is a shell that exited and
  // left its last write behind — a file naming a port nobody owns.
  const written = aliveFor()
  const state = readBridgeEndpoint(endpoint(written), Date.parse(written.updatedAt) + 61_000)
  assert.equal(state.present, true)
  assert.equal(state.alive, false)
  assert.match(state.detail, /not been refreshed/)
})

test('a stale-looking stamp inside the window is still alive', () => {
  const written = aliveFor()
  const state = readBridgeEndpoint(endpoint(written), Date.parse(written.updatedAt) + 30_000)
  assert.equal(state.alive, true, 'the window is 60 s; 30 s is a slow refresh, not a dead shell')
})

test('a live stamp with a dead pid is not running', () => {
  // The stamp alone is forgeable by a tombstone; the pid is the second, independent signal. 0x7fffffe0
  // is inside the legal pid range and is not a process this machine will be running.
  const dead = { ...aliveFor(), pid: 0x7fffffe0 }
  const state = readBridgeEndpoint(endpoint(dead))
  assert.equal(state.present, true)
  assert.equal(state.alive, false)
  assert.match(state.detail, /not running/)
})

test('an older bridge that writes no stamp is judged by its pid alone', () => {
  const noStamp = { port: 65402, token: 't', pid: process.pid }
  assert.equal(readBridgeEndpoint(endpoint(noStamp)).alive, true, 'a live pid is enough')
  const deadNoStamp = { port: 65402, token: 't', pid: 0x7fffffe0 }
  const state = readBridgeEndpoint(endpoint(deadNoStamp))
  assert.equal(state.alive, false)
  assert.match(state.detail, /not running/)
})
