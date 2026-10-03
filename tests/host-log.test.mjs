// The host log is the only evidence left after a spawn failure, so its lines
// must carry enough to name a cause: a timestamp, both paths, and whether the
// entry script existed at spawn and again at exit.
//
// Why that matters: Electron exits 1 with EMPTY stderr when it cannot load the
// app entry script, and that signature is otherwise indistinguishable from a
// missing or corrupt binary. The comparison "present at spawn, absent at exit"
// is what identifies an installation replaced underneath a running host.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { RemoteElectronViewHost } from '../lib/browser-electron/remote-host.js'

// Isolate the whole file and do NOT restore afterwards: `dispose()` kills the
// child asynchronously, so its exit line is written AFTER the test body returns.
// Restoring DSH_HOME in a `finally` therefore sent exactly that line to the
// operator's real host log — the one read to diagnose crash loops — which is how
// synthetic entries ended up in it. The temp directory outlives this process
// instead, so late writes land there too.
process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'dsh-hostlog-'))
const home = process.env.DSH_HOME
const logFile = join(home, 'logs', 'dsh-builtin-browser-host.log')

test('a silent spawn failure is logged with a timestamp, both paths and entry presence', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/silent-exit-child.mjs', import.meta.url))
  const host = new RemoteElectronViewHost(fixture, process.execPath)
  const view = host.createView()
  // The child exits 1 at once, so the first command fails (that part is the
  // pre-existing behaviour); what is under test is what got written down.
  await assert.rejects(() => view.sendCommand('Runtime.evaluate', { expression: '1' }))
  host.dispose()

  const log = readFileSync(logFile, 'utf8')
  assert.match(log, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z spawning: electron=/m, 'spawn line carries an ISO timestamp')
  assert.match(log, /spawning: electron=.*\(exists=true\)/, 'the binary path and its presence are recorded before spawning')
  assert.match(log, /hostMain=.*\(exists=true\)/, 'the entry script path and its presence are recorded too')
  assert.match(log, /browser host exited \(code=1 signal=null\)/, 'the exit is recorded')
  assert.match(log, /pid=\d+/, 'the exit line identifies the dying child')
  assert.match(log, /entryExists=true/, 'entry presence is rechecked at exit for comparison with the spawn line')
  // The line the failure path exists to write. It was unreachable for a while: the dedupe ran
  // twice and the second run compared against a field the first had just written, so its window
  // was 0-1ms wide and the test was always true — a child that exits instantly with empty stderr
  // left nothing in the log at all, which is the one signature this line is meant to expose.
  assert.match(log, /browser host start failed \(attempt \d+\)/, 'the start failure itself is recorded')
})

test('every host-log line is dated', async () => {
  const fixture = fileURLToPath(new URL('./fixtures/fake-host-child.mjs', import.meta.url))
  const host = new RemoteElectronViewHost(fixture, process.execPath)
  const view = host.createView()
  await view.sendCommand('Runtime.evaluate', { expression: '1' })
  await assert.rejects(() => view.sendCommand('__die'), /host/)
  host.dispose()

  const lines = readFileSync(logFile, 'utf8').split('\n').filter(line => line.trim() !== '')
  assert.ok(lines.length > 0, 'the log has content')
  for (const line of lines) {
    // A dated line is what makes a crash loop placeable in time against whatever
    // else happened on the machine (a plugin update, for instance).
    assert.match(line, /^\d{4}-\d{2}-\d{2}T/, `every line is dated: ${line}`)
  }
})
