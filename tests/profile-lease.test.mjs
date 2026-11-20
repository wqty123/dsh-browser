import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { acquireProfileLease } from '../lib/browser-electron/profile-lease.js'

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
