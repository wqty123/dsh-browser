import { randomUUID } from 'node:crypto'
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { GuestCookieJar, normalizeStoredCookie, type StoredCookie } from './guest-cookie-jar.ts'
import { dshHome } from './paths.ts'

export function loadGuestCookies(directory: string): GuestCookieJar {
  const file = join(directory, 'cookies.json')
  let saved: StoredCookie[] = []
  try {
    let fd: number | undefined
    try {
      fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      if (!fstatSync(fd).isFile()) throw new Error()
      fchmodSync(fd, 0o600)
      const data: unknown = JSON.parse(readFileSync(fd, 'utf8'))
      if (data === null || typeof data !== 'object') throw new Error()
      const record = data as Record<string, unknown>
      if (record.version !== 1 || !Array.isArray(record.cookies)) throw new Error()
      saved = record.cookies.flatMap(value => {
        const cookie = normalizeStoredCookie(value)
        return cookie !== undefined && (cookie.expiresAt === undefined || cookie.expiresAt > Date.now()) ? [cookie] : []
      })
    } finally { if (fd !== undefined) closeSync(fd) }
  } catch {}
  const persist = (cookies: readonly StoredCookie[]) => {
    const temporary = file + '.' + randomUUID() + '.tmp'
    let fd: number | undefined
    try {
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      fd = openSync(temporary, 'wx', 0o600)
      fchmodSync(fd, 0o600)
      writeFileSync(fd, JSON.stringify({ version: 1, cookies }))
      fsyncSync(fd)
      closeSync(fd)
      fd = undefined
      renameSync(temporary, file)
    } catch {} finally {
      if (fd !== undefined) { try { closeSync(fd) } catch {} }
      try { rmSync(temporary, { force: true }) } catch { /* A failed write may leave an owner-only temporary file. */ }
    }
  }
  const jar = new GuestCookieJar(persist, saved)
  persist(saved)
  return jar
}

const stores = new Map<string, GuestCookieJar>()

export function localGuestCookies(): GuestCookieJar {
  const directory = join(dshHome(), 'dsh-builtin-browser-host', 'web-cookies')
  let store = stores.get(directory)
  if (store === undefined) {
    store = loadGuestCookies(directory)
    stores.set(directory, store)
  }
  return store
}
