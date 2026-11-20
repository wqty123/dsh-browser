import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { GuestCookieStore, localGuestCookies } from '../src/browser-electron/guest-cookie-store.ts'

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'guest-cookie-store-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('profile cookies survive a real process restart; session values never reach disk or logs', t => {
  const directory = fixture(t)
  const module = new URL('../src/browser-electron/guest-cookie-store.ts', import.meta.url).href
  const run = body => {
    const result = spawnSync(process.execPath, ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e',
      `import assert from 'node:assert/strict'; import { GuestCookieStore } from ${JSON.stringify(module)};
      const store = new GuestCookieStore(${JSON.stringify(directory)}); const url = new URL('https://site.example/'); ${body}`], { encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
  }
  run(`const jar = store.forProfile('user-A');
    jar.setCookies(url, ['PERSIST=kept; Secure; Max-Age=3600; Path=/', 'SESSION=not-on-disk; Path=/']);
    assert.equal(jar.getCookieHeader(url), 'PERSIST=kept; SESSION=not-on-disk');`)
  run(`assert.equal(store.forProfile('user-A').getCookieHeader(url), 'PERSIST=kept');
    assert.equal(store.forProfile('user-B').getCookieHeader(url), undefined);`)
  const files = readdirSync(directory)
  assert.equal(files.length, 1, 'atomic temporary files are removed')
  const file = join(directory, files[0])
  assert.equal(readFileSync(file, 'utf8').includes('not-on-disk'), false)
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600)
})

test('expiry, replacement by a session cookie, and explicit deletion remain effective after restart', t => {
  const directory = fixture(t)
  let now = Date.UTC(2030, 0, 1)
  t.mock.method(Date, 'now', () => now)
  const url = new URL('https://site.example/')
  const jar = new GuestCookieStore(directory).forProfile('local')
  jar.setCookies(url, ['SHORT=yes; Max-Age=1', 'LONG=yes; Max-Age=3600', 'DELETE=yes; Max-Age=3600', 'REPLACE=yes; Max-Age=3600'])
  jar.setCookies(url, ['DELETE=gone; Max-Age=0', 'REPLACE=session-only'])
  now += 1000
  assert.equal(new GuestCookieStore(directory).forProfile('local').getCookieHeader(url), 'LONG=yes')
  assert.equal(jar.getCookieHeader(url), 'LONG=yes; REPLACE=session-only')
})

test('stores isolate profile IDs and DSH homes, never interpreting a profile as a filesystem path', t => {
  const directory = fixture(t)
  const other = fixture(t)
  const url = new URL('https://site.example/')
  const store = new GuestCookieStore(directory)
  const a = store.forProfile('../user-A')
  a.setCookies(url, ['A=one; Max-Age=3600'])
  assert.equal(store.forProfile('../user-A'), a)
  assert.equal(store.forProfile('user-B').getCookieHeader(url), undefined)
  assert.equal(new GuestCookieStore(other).forProfile('../user-A').getCookieHeader(url), undefined)
  const original = process.env.DSH_HOME
  t.after(() => { if (original === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = original })
  process.env.DSH_HOME = directory
  localGuestCookies().setCookies(url, ['LOCAL=yes; Max-Age=3600'])
  process.env.DSH_HOME = other
  assert.equal(localGuestCookies().getCookieHeader(url), undefined)
  process.env.DSH_HOME = directory
  assert.equal(localGuestCookies().getCookieHeader(url), 'LOCAL=yes')
})

test('empty, corrupt and unwritable stores fail without disclosing stored values', t => {
  const directory = fixture(t)
  const file = join(directory, createHash('sha256').update('local').digest('hex') + '.json')
  assert.equal(new GuestCookieStore(directory).forProfile('local').getCookieHeader(new URL('https://site.example/')), undefined)
  writeFileSync(file, 'CORRUPT_SECRET')
  assert.throws(() => new GuestCookieStore(directory).forProfile('local'), /^Error: guest cookie storage unavailable$/)
  assert.equal(readFileSync(file, 'utf8'), 'CORRUPT_SECRET')
  rmSync(file)
  const jar = new GuestCookieStore(directory).forProfile('local')
  mkdirSync(file)
  assert.throws(() => jar.setCookies(new URL('https://site.example/'), ['SECRET=value; Max-Age=3600']), /^Error: guest cookie storage unavailable$/)
  assert.deepEqual(readdirSync(directory), [file.split('/').at(-1)])
  assert.throws(() => new GuestCookieStore(directory).forProfile(''), /profile unavailable/)
})
