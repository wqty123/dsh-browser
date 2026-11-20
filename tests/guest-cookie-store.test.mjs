import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { loadGuestCookies, localGuestCookies } from '../src/browser-electron/guest-cookie-store.ts'

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'guest-cookie-store-'))
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  return directory
}

test('persistent and session cookies survive a real process restart without logging values', t => {
  const directory = fixture(t)
  const module = new URL('../lib/browser-electron/guest-cookie-store.js', import.meta.url).href
  const run = body => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import assert from 'node:assert/strict'; import { localGuestCookies } from ${JSON.stringify(module)};
      const jar = localGuestCookies(); const url = new URL('https://site.example/'); ${body}`], { encoding: 'utf8', env: { ...process.env, DSH_HOME: directory } })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
  }
  run(`jar.setCookies(url, ['PERSIST=kept; Secure; Max-Age=3600; Path=/', 'SESSION=restored; Path=/']);
    assert.equal(jar.getCookieHeader(url), 'PERSIST=kept; SESSION=restored');`)
  run(`assert.equal(jar.getCookieHeader(url), 'PERSIST=kept; SESSION=restored');`)
  const storage = join(directory, 'dsh-builtin-browser-host', 'web-cookies')
  assert.deepEqual(readdirSync(storage), ['cookies.json'], 'one store, with no identity keys or temporary files')
  const file = join(storage, 'cookies.json')
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8'))).sort(), ['cookies', 'version'])
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).cookies.find(cookie => cookie.name === 'SESSION').expiresAt, undefined)
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600)
})

test('expiry, replacement by a session cookie, and explicit deletion remain effective after restart', t => {
  const directory = fixture(t)
  let now = Date.UTC(2030, 0, 1)
  t.mock.method(Date, 'now', () => now)
  const url = new URL('https://site.example/')
  const jar = loadGuestCookies(directory)
  jar.setCookies(url, ['SHORT=yes; Max-Age=1', 'LONG=yes; Max-Age=3600', 'DELETE=yes', 'PAST=yes', 'NEGATIVE=yes', 'REPLACE=yes; Max-Age=3600'])
  jar.setCookies(url, ['DELETE=gone; Max-Age=0', 'PAST=gone; Expires=Tue, 01 Jan 2000 00:00:00 GMT', 'NEGATIVE=gone; Max-Age=-1', 'REPLACE=session-only'])
  now += 1000
  assert.equal(loadGuestCookies(directory).getCookieHeader(url), 'LONG=yes; REPLACE=session-only')
  assert.equal(jar.getCookieHeader(url), 'LONG=yes; REPLACE=session-only')
})

test('one shared jar per DSH_HOME, isolated from other DSH homes', t => {
  const directory = fixture(t)
  const other = fixture(t)
  const url = new URL('https://site.example/')
  const original = process.env.DSH_HOME
  t.after(() => { if (original === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = original })
  process.env.DSH_HOME = directory
  const jar = localGuestCookies()
  jar.setCookies(url, ['LOCAL=yes; Max-Age=3600'])
  assert.equal(localGuestCookies(), jar)
  process.env.DSH_HOME = other
  assert.equal(localGuestCookies().getCookieHeader(url), undefined)
  process.env.DSH_HOME = directory
  assert.equal(localGuestCookies().getCookieHeader(url), 'LOCAL=yes')
})

test('empty, corrupt and unwritable stores remain usable without disclosing stored values', t => {
  const directory = fixture(t)
  const file = join(directory, 'cookies.json')
  assert.equal(loadGuestCookies(directory).getCookieHeader(new URL('https://site.example/')), undefined)
  writeFileSync(file, 'CORRUPT_SECRET')
  assert.equal(loadGuestCookies(directory).getCookieHeader(new URL('https://site.example/')), undefined)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { version: 1, cookies: [] })
  rmSync(file)
  const jar = loadGuestCookies(directory)
  rmSync(file)
  mkdirSync(file)
  assert.doesNotThrow(() => jar.setCookies(new URL('https://site.example/'), ['SECRET=value; Max-Age=3600']))
  assert.equal(loadGuestCookies(directory).getCookieHeader(new URL('https://site.example/')), undefined)
  assert.deepEqual(readdirSync(directory), [basename(file)])
})
