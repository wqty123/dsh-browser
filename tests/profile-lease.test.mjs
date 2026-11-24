import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { createServer } from 'node:net'
import { acquireProfileLease, processIdentity } from '../lib/browser-electron/profile-lease.js'

const require = createRequire(import.meta.url)

test('one profile has one lease, released idempotently for the next owner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-profile-lease-'))
  const file = join(dir, '.dsh-browser-lease.json')
  try {
    const first = await acquireProfileLease(dir)
    assert.equal(JSON.parse(readFileSync(file)).pid, process.pid)
    await assert.rejects(() => acquireProfileLease(join(dir, '.')), /profile is leased/)
    await first.release()
    const next = await acquireProfileLease(dir)
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
    const lease = await acquireProfileLease(dir)
    let during
    await lease.release(() => {
      during = acquireProfileLease(dir)
      rmSync(dir, { recursive: true, force: true })
    })
    assert.equal(existsSync(dir), false)
    await assert.rejects(during, /profile is leased/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

const PIPE_PREFIX = '\\\\.\\pipe\\dsh-browser-lease-'
const win = process.platform === 'win32'

const reusedLease = () => win
  ? { pid: process.pid, token: 'reused-pid', pipe: `${PIPE_PREFIX}gone-${process.pid}-${Date.now()}` }
  : { pid: process.pid, token: 'reused-pid', identity: 'an-earlier-process' }

async function liveLease(t) {
  if (!win) return { pid: process.pid, token: 'live-owner', identity: processIdentity(process.pid) }
  const pipe = `${PIPE_PREFIX}live-${process.pid}-${Date.now()}`
  const server = createServer(socket => socket.destroy())
  await new Promise(resolve => server.listen(pipe, resolve))
  t.after(() => server.close())
  return { pid: process.pid, token: 'live-owner', pipe }
}

test('a lease whose PID now belongs to a later process is reclaimed, the live owner is not', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-profile-reused-'))
  const file = join(dir, '.dsh-browser-lease.json')
  try {
    writeFileSync(file, JSON.stringify(reusedLease()))
    const lease = await acquireProfileLease(dir)
    const written = JSON.parse(readFileSync(file, 'utf8'))
    assert.notEqual(written.token, 'reused-pid')
    if (win) assert.ok(written.pipe.startsWith(PIPE_PREFIX))
    else assert.equal(written.identity, processIdentity(process.pid))
    await lease.release()
    writeFileSync(file, JSON.stringify(await liveLease(t)))
    await assert.rejects(() => acquireProfileLease(dir), /profile is leased/)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).token, 'live-owner')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a released lease takes its liveness pipe down with it', { skip: !win }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-profile-pipe-'))
  const file = join(dir, '.dsh-browser-lease.json')
  try {
    const lease = await acquireProfileLease(dir)
    const owner = JSON.parse(readFileSync(file, 'utf8'))
    await lease.release()
    writeFileSync(file, JSON.stringify(owner))
    await (await acquireProfileLease(dir)).release()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('acquiring a lease on Windows never starts a process', { skip: !win }, async t => {
  const children = require('node:child_process')
  const spawned = []
  const names = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']
  const original = Object.fromEntries(names.map(name => [name, children[name]]))
  for (const name of names) children[name] = (...args) => { spawned.push(args[0]); return original[name](...args) }
  syncBuiltinESMExports()
  t.after(() => { Object.assign(children, original); syncBuiltinESMExports() })
  const dir = mkdtempSync(join(tmpdir(), 'dsh-profile-nospawn-'))
  const file = join(dir, '.dsh-browser-lease.json')
  try {
    writeFileSync(file, JSON.stringify(reusedLease()))
    await (await acquireProfileLease(dir)).release()
    writeFileSync(file, JSON.stringify(await liveLease(t)))
    await assert.rejects(() => acquireProfileLease(dir), /profile is leased/)
    assert.deepEqual(spawned, [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('the OS identity of this process is stable across reads, and Windows uses none', () => {
  const own = processIdentity(process.pid)
  if (win) return assert.equal(own, undefined)
  assert.ok(typeof own === 'string' && own !== '')
  assert.equal(processIdentity(process.pid), own)
})

for (const directoryGuard of [false, true]) {
  test(`a guard whose PID was reused by a later process is reclaimed, a verified live guard is preserved (directory=${directoryGuard})`, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-profile-guard-reused-'))
    const file = join(dir, '.dsh-browser-lease.json')
    const guard = join(dirname(dir), `.${basename(dir)}.dsh-browser-lease.guard`)
    try {
      const reused = JSON.stringify({ ...reusedLease(), at: Date.now() })
      if (directoryGuard) {
        mkdirSync(guard)
        writeFileSync(file, reused)
      } else {
        writeFileSync(guard, reused)
      }
      const lease = await acquireProfileLease(dir)
      await lease.release()
      assert.equal(existsSync(guard), false)

      const live = JSON.stringify({ ...(await liveLease(t)), at: Date.now() })
      if (directoryGuard) {
        mkdirSync(guard)
        writeFileSync(file, live)
      } else {
        writeFileSync(guard, live)
      }
      await assert.rejects(() => acquireProfileLease(dir), /profile is leased/)
      assert.equal(existsSync(guard), true)
    } finally {
      rmSync(guard, { recursive: true, force: true })
      rmSync(dir, { recursive: true, force: true })
    }
  })
}

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
        await assert.rejects(() => acquireProfileLease(dir), /profile is leased/)
        assert.equal(existsSync(guard), true)
      } else {
        const lease = await acquireProfileLease(dir)
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
    if (old) await (await acquireProfileLease(dir)).release()
    else await assert.rejects(() => acquireProfileLease(dir), /profile is leased/)
  } finally {
    rmSync(guard, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})

for (const invalid of ['', 'null', '{}', '{broken', '{"pid":0,"token":"x"}']) {
  test(`unverifiable ownership refuses without replacing it: ${JSON.stringify(invalid)}`, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-profile-lease-'))
    const file = join(dir, '.dsh-browser-lease.json')
    try {
      writeFileSync(file, invalid)
      await assert.rejects(() => acquireProfileLease(dir), /ownership cannot be verified/)
      assert.equal(readFileSync(file, 'utf8'), invalid)
      assert.equal(existsSync(join(dirname(dir), `.${basename(dir)}.dsh-browser-lease.guard`)), false)
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
}
