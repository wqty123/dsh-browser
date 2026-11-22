import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GuestStorage } from '../src/browser-electron/guest-storage.ts'

const origin = 'https://site.example'
const context = 'one-browser-context'
const call = (store, token, area, op, key, value, site = origin) => store.execute(token, site, { area, op, key, value })

test('guest local storage persists by exact origin, with owner-only atomic files; session storage stays per tab and in memory', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-storage-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const store = new GuestStorage(dir), token = store.issue(origin, context)
  assert.equal(call(store, token, 'local', 'get', 'missing'), null)
  assert.deepEqual(call(store, token, 'local', 'entries'), [])
  call(store, token, 'local', 'set', '__proto__', 'safe')
  call(store, token, 'local', 'set', '', '空')
  call(store, token, 'session', 'set', 'session', 'one')
  const otherTab = store.issue(origin, 'another-browser-context')
  assert.equal(call(store, otherTab, 'local', 'get', '__proto__'), 'safe')
  assert.equal(call(store, otherTab, 'session', 'get', 'session'), null)
  const again = store.issue(origin, context)
  assert.equal(call(store, again, 'session', 'get', 'session'), 'one')
  for (const site of ['http://site.example', 'https://site.example:8443', 'https://other.example']) {
    const other = store.issue(site, context)
    assert.equal(call(store, other, 'local', 'get', '__proto__', undefined, site), null)
    assert.equal(call(store, other, 'session', 'get', 'session', undefined, site), null)
    assert.throws(() => call(store, token, 'local', 'get', '__proto__', undefined, site), { name: 'SecurityError' })
  }
  const reloaded = new GuestStorage(dir), fresh = reloaded.issue(origin, context)
  assert.deepEqual(call(reloaded, fresh, 'local', 'entries'), [['__proto__', 'safe'], ['', '空']])
  assert.equal(call(reloaded, fresh, 'session', 'get', 'session'), null)
  assert.throws(() => call(reloaded, token, 'local', 'get', ''), { name: 'SecurityError' })
  assert.ok(!readFileSync(join(dir, 'storage.json'), 'utf8').includes('session'))
  if (process.platform !== 'win32') assert.equal(statSync(join(dir, 'storage.json')).mode & 0o777, 0o600)
  call(reloaded, fresh, 'local', 'remove', '__proto__')
  call(reloaded, fresh, 'local', 'clear')
  assert.deepEqual(call(reloaded, fresh, 'local', 'entries'), [])
  const empty = new GuestStorage(dir)
  assert.deepEqual(call(empty, empty.issue(origin, context), 'local', 'entries'), [])
})

test('guest storage rejects invalid capabilities and requests, preserves quota failures, and recovers corrupt data', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-storage-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, 'storage.json'), '{bad json')
  const store = new GuestStorage(dir, 12), token = store.issue(origin, context)
  call(store, token, 'local', 'set', 'x', 'abc')
  for (const area of ['local', 'session']) {
    assert.throws(() => call(store, token, area, 'set', 'oversize', 'abc'), { name: 'QuotaExceededError' })
    assert.equal(call(store, token, area, 'get', 'oversize'), null)
  }
  assert.equal(call(store, token, 'local', 'get', 'x'), 'abc')
  for (const bad of ['', token + '.extra', 'a.b', 'x'.repeat(9000)]) {
    assert.throws(() => call(store, bad, 'local', 'get', 'x'), { name: 'SecurityError' })
  }
  for (const input of [null, [], {}, { area: 'cookies', op: 'clear' }, { area: 'local', op: 'set', key: 'x', value: 1 }]) {
    assert.throws(() => store.execute(token, origin, input), { name: 'TypeError' })
  }
  const reload = new GuestStorage(dir)
  assert.equal(call(reload, reload.issue(origin, context), 'local', 'get', 'x'), 'abc')
})

test('guest storage write errors are explicit and do not commit an in-memory mutation', t => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-storage-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const file = join(dir, 'not-a-directory')
  writeFileSync(file, '')
  const store = new GuestStorage(file), token = store.issue(origin, context)
  assert.throws(() => call(store, token, 'local', 'set', 'x', 'secret'), { name: 'UnknownError' })
  assert.equal(call(store, token, 'local', 'get', 'x'), null)
})
