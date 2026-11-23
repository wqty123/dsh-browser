import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { acquireProfileLease, processIdentity } from '../lib/browser-electron/profile-lease.js'

test('one profile has one lease, released idempotently for the next owner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-profile-lease-'))
  const file = join(dir, '.dsh-browser-lease.json')
  try {
    const first = acquireProfileLease(dir)
    assert.equal(JSON.parse(readFileSync(file)).pid, process.pid)
    assert.throws(() => acquireProfileLease(join(dir, '.')), /profile is leased/)
    await first.release()
    const next = acquireProfileLease(dir)
    await first.release()
    assert.equal(existsSync(file), true, 'a previous owner cannot release its successor')
    await next.release()
    assert.equal(existsSync(file), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a dead process lease can be reclaimed and cleanup remains exclusive', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-profile-dead-'))
  const exited = spawnSync(process.execPath, ['-e', ''])
  assert.equal(exited.status, 0)
  try {
    writeFileSync(join(dir, '.dsh-browser-lease.json'), JSON.stringify({ pid: exited.pid, token: 'dead-owner' }))
    const lease = acquireProfileLease(dir)
    await lease.release(() => {
      assert.throws(() => acquireProfileLease(dir), /profile is leased/)
      rmSync(dir, { recursive: true, force: true })
    })
    assert.equal(existsSync(dir), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a lease whose PID now belongs to a later process is reclaimed, the live owner is not', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-profile-reused-'))
  const file = join(dir, '.dsh-browser-lease.json')
  try {
    writeFileSync(file, JSON.stringify({ pid: process.pid, token: 'reused-pid', identity: 'an-earlier-process' }))
    const lease = acquireProfileLease(dir)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).identity, processIdentity(process.pid))
    await lease.release()
    writeFileSync(file, JSON.stringify({ pid: process.pid, token: 'live-owner', identity: processIdentity(process.pid) }))
    assert.throws(() => acquireProfileLease(dir), /profile is leased/)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).token, 'live-owner')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the OS identity of this process is stable across reads', () => {
  const own = processIdentity(process.pid)
  assert.ok(typeof own === 'string' && own !== '')
  assert.equal(processIdentity(process.pid), own)
})

for (const directoryGuard of [false, true]) {
  for (const alive of [false, true]) test(`guard recovery preserves live owners (directory=${directoryGuard}, alive=${alive})`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-profile-guard-'))
    const guard = join(dirname(dir), `.${basename(dir)}.dsh-browser-lease.guard`)
    const exited = spawnSync(process.execPath, ['-e', ''])
    assert.equal(exited.status, 0)
    const pid = alive ? process.pid : exited.pid
    const owner = JSON.stringify({ pid, at: 0, token: 'guard-owner' })
    try {
      if (directoryGuard) {
        mkdirSync(guard)
        writeFileSync(join(dir, '.dsh-browser-lease.json'), owner)
      } else writeFileSync(guard, owner)
      utimesSync(guard, new Date(0), new Date(0))
      if (alive) {
        assert.throws(() => acquireProfileLease(dir), /profile is leased/)
        assert.equal(existsSync(guard), true)
      } else {
        const lease = acquireProfileLease(dir)
        await lease.release()
        assert.equal(existsSync(guard), false)
      }
    } finally {
      rmSync(guard, { recursive: true, force: true })
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

for (const old of [false, true]) test(`legacy empty directory guard recovery requires staleness (${old})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-profile-legacy-'))
  const guard = join(dirname(dir), `.${basename(dir)}.dsh-browser-lease.guard`)
  try {
    mkdirSync(guard)
    if (old) utimesSync(guard, new Date(0), new Date(0))
    if (old) await acquireProfileLease(dir).release()
    else assert.throws(() => acquireProfileLease(dir), /profile is leased/)
  } finally {
    rmSync(guard, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})

for (const invalid of ['', 'null', '{}', '{broken', '{"pid":0,"token":"x"}']) {
  test(`unverifiable ownership refuses without replacing it: ${JSON.stringify(invalid)}`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-profile-lease-'))
    const file = join(dir, '.dsh-browser-lease.json')
    try {
      writeFileSync(file, invalid)
      assert.throws(() => acquireProfileLease(dir), /ownership cannot be verified/)
      assert.equal(readFileSync(file, 'utf8'), invalid)
      assert.equal(existsSync(join(dirname(dir), `.${basename(dir)}.dsh-browser-lease.guard`)), false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
}
