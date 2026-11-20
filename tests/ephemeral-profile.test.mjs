// An ephemeral profile must not survive the process that owns it.
//
// A process killed outright — SIGKILL from a restart, "End task" in a task manager —
// runs no cleanup at all: the release path never executes, and the user who turned
// persistence OFF is left with a profile on disk holding every cookie the browser had.
// Nothing can run at signal time, so the cleanup happens on the NEXT run instead, which
// is what these cases pin. (M7b's residue: `process.once('exit')` cannot fire on a kill.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { claimEphemeralProfile, ephemeralProfileName, sweepAbandonedEphemeralProfiles } =
  await import('../lib/browser-electron/ephemeral-profile.js')

/** A pid no live process holds, for the "its owner was killed" case. */
const DEAD_PID = 2 ** 30

/** A liveness test that says every pid is gone except the ones named. */
const aliveExcept = (...dead) => (pid) => !dead.includes(pid)

/** Age a directory past the window that protects a profile still in use. */
function ageOut(dir, hours = 2) {
  const when = new Date(Date.now() - hours * 60 * 60 * 1000)
  utimesSync(dir, when, when)
}

/** Age the WHOLE tree: a genuinely abandoned profile has no recent nested writes either. */
function ageOutTree(dir, hours = 2) {
  const when = new Date(Date.now() - hours * 60 * 60 * 1000)
  const pending = [dir]
  while (pending.length > 0) {
    const current = pending.pop()
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) pending.push(path)
      else utimesSync(path, when, when)
    }
    utimesSync(current, when, when)
  }
}

test('a profile whose owner is still running is left alone', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ephem-live-'))
  const dir = join(root, ephemeralProfileName('chrome', 'live'))
  mkdirSync(dir)
  assert.equal(claimEphemeralProfile(dir), true, 'the claim names this process by default')
  // Old enough to sweep on age alone: ownership is the only thing keeping it.
  ageOut(dir)

  assert.deepEqual(sweepAbandonedEphemeralProfiles(root, 'chrome'), [])
  assert.ok(existsSync(dir), 'the live owner keeps its profile')
  rmSync(root, { recursive: true, force: true })
})

test('a profile whose owner is gone and which stopped changing is removed', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ephem-dead-'))
  const name = ephemeralProfileName('chrome', 'dead')
  const dir = join(root, name)
  mkdirSync(dir)
  claimEphemeralProfile(dir, DEAD_PID)
  ageOut(dir)

  const removed = sweepAbandonedEphemeralProfiles(root, 'chrome', { alive: aliveExcept(DEAD_PID) })
  assert.deepEqual(removed, [name], 'the abandoned directory is the one reported')
  assert.equal(existsSync(dir), false, 'and it is gone from disk')
  rmSync(root, { recursive: true, force: true })
})

test('a profile still being written to is kept even when its owner is gone', () => {
  // A killed DSH can leave its Chromium child running, and that child keeps writing to the
  // profile it was given. Deleting it would pull the ground out from under a live browser,
  // so recent activity wins over the dead owner.
  const root = mkdtempSync(join(tmpdir(), 'dsh-ephem-orphan-'))
  const dir = join(root, ephemeralProfileName('chrome', 'orphan'))
  mkdirSync(dir)
  claimEphemeralProfile(dir, DEAD_PID)

  assert.deepEqual(sweepAbandonedEphemeralProfiles(root, 'chrome', { alive: aliveExcept(DEAD_PID) }), [])
  assert.ok(existsSync(dir), 'a profile that was just written to is not garbage')
  rmSync(root, { recursive: true, force: true })
})

test('a profile with no marker at all is swept once it is old enough', () => {
  // A run from before the marker existed, or one killed between creating the directory
  // and claiming it. The age check has already applied, so there is nothing else it can be.
  const root = mkdtempSync(join(tmpdir(), 'dsh-ephem-anon-'))
  const name = ephemeralProfileName('chrome', 'anonymous')
  const dir = join(root, name)
  mkdirSync(dir)
  writeFileSync(join(dir, 'Preferences'), '{}')
  ageOutTree(dir)

  assert.deepEqual(sweepAbandonedEphemeralProfiles(root, 'chrome'), [name])
  assert.equal(existsSync(dir), false)
  rmSync(root, { recursive: true, force: true })
})

test('an OLD root directory with a recent nested write is kept even when its owner is gone', () => {
  // The confirmed baseline defect: a killed DSH leaves a Chromium child that keeps writing
  // Default/Network/Cookies. Writing that file does not refresh the ROOT directory's mtime, so
  // the old root-only age check deleted a profile still in use. Reproduced with a real writer
  // child in the audit; this is the file-system judgement the sweep has to get right.
  const root = mkdtempSync(join(tmpdir(), 'dsh-ephem-nested-'))
  const dir = join(root, ephemeralProfileName('chrome', 'nested-live'))
  const cookiesParent = join(dir, 'Default', 'Network')
  mkdirSync(cookiesParent, { recursive: true })
  writeFileSync(join(cookiesParent, 'Cookies'), 'cookie-data')
  claimEphemeralProfile(dir, DEAD_PID)
  ageOut(dir)

  const removed = sweepAbandonedEphemeralProfiles(root, 'chrome', { alive: aliveExcept(DEAD_PID) })
  assert.deepEqual(removed, [], 'recent nested activity wins over a stale root timestamp')
  assert.ok(existsSync(join(cookiesParent, 'Cookies')), 'the live browser keeps its data')
  rmSync(root, { recursive: true, force: true })
})

test('a profile whose whole tree is old and whose owner is gone is still removed', () => {
  // The fix must not turn the sweep into a no-op: genuinely abandoned data is still reclaimed.
  const root = mkdtempSync(join(tmpdir(), 'dsh-ephem-old-tree-'))
  const name = ephemeralProfileName('chrome', 'old-tree')
  const dir = join(root, name)
  mkdirSync(join(dir, 'Default', 'Network'), { recursive: true })
  writeFileSync(join(dir, 'Default', 'Network', 'Cookies'), 'stale')
  claimEphemeralProfile(dir, DEAD_PID)
  ageOutTree(dir)

  const removed = sweepAbandonedEphemeralProfiles(root, 'chrome', { alive: aliveExcept(DEAD_PID) })
  assert.deepEqual(removed, [name], 'an abandoned tree is still reclaimed')
  assert.equal(existsSync(dir), false)
  rmSync(root, { recursive: true, force: true })
})

test('another product and the persistent profile are never touched', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-ephem-other-'))
  const other = ephemeralProfileName('edge', 'edge-run')
  const otherDir = join(root, other)
  const persistent = join(root, 'chrome-profile')
  mkdirSync(otherDir)
  mkdirSync(persistent)
  claimEphemeralProfile(otherDir, DEAD_PID)
  ageOut(otherDir)
  ageOut(persistent)

  assert.deepEqual(
    sweepAbandonedEphemeralProfiles(root, 'chrome', { alive: aliveExcept(DEAD_PID) }),
    [],
    'the sweep is scoped to the product it was asked about',
  )
  assert.ok(existsSync(otherDir), 'the other product keeps its profile')
  assert.ok(existsSync(persistent), 'and the persistent profile is not a profile to sweep')
  rmSync(root, { recursive: true, force: true })
})

test('a missing profile root is not an error', () => {
  // First run, or the user turned persistence off before any profile was ever written.
  assert.deepEqual(sweepAbandonedEphemeralProfiles(join(tmpdir(), 'dsh-does-not-exist-at-all'), 'chrome'), [])
})
