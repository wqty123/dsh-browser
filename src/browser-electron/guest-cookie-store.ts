import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { GuestCookieJar, type StoredCookie } from './guest-cookie-jar.ts'
import { dshHome } from './paths.ts'

export const LOCAL_GUEST_PROFILE = 'local'

function validCookie(value: unknown): value is StoredCookie {
  if (value === null || typeof value !== 'object') return false
  const c = value as Record<string, unknown>
  if (typeof c.host !== 'string' || typeof c.name !== 'string' || typeof c.value !== 'string'
    || typeof c.path !== 'string' || typeof c.secure !== 'boolean' || typeof c.expiresAt !== 'number'
    || !Number.isFinite(c.expiresAt) || !c.path.startsWith('/') || /[\x00-\x1f\x7f]/u.test(c.path)
    || !/^[!#$%&'*+\-.^_`|~\da-z]+$/iu.test(c.name) || /[\x00-\x20\x7f;,]/u.test(c.value)) return false
  try {
    const url = new URL('https://' + c.host)
    if (url.host !== c.host || url.username !== '' || url.password !== '' || url.pathname !== '/') return false
  } catch { return false }
  return (!c.name.startsWith('__Secure-') || c.secure)
    && (!c.name.startsWith('__Host-') || (c.secure && c.path === '/'))
}

/** Profile IDs must come from the host, never from guest query parameters or conversations. */
export class GuestCookieStore {
  private readonly jars = new Map<string, GuestCookieJar>()

  constructor(private readonly directory: string) {}

  forProfile(profile: string): GuestCookieJar {
    if (profile === '') throw new Error('guest cookie profile unavailable')
    const existing = this.jars.get(profile)
    if (existing !== undefined) return existing
    const file = join(this.directory, createHash('sha256').update(profile).digest('hex') + '.json')
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
        if (record.version !== 1 || record.profile !== profile || !Array.isArray(record.cookies)
          || !record.cookies.every(validCookie)) throw new Error()
        saved = record.cookies
      } finally { if (fd !== undefined) closeSync(fd) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('guest cookie storage unavailable')
    }
    const jar = new GuestCookieJar(cookies => {
      const temporary = file + '.' + randomUUID() + '.tmp'
      let fd: number | undefined
      try {
        mkdirSync(this.directory, { recursive: true, mode: 0o700 })
        fd = openSync(temporary, 'wx', 0o600)
        fchmodSync(fd, 0o600)
        writeFileSync(fd, JSON.stringify({ version: 1, profile, cookies }))
        fsyncSync(fd)
        closeSync(fd)
        fd = undefined
        renameSync(temporary, file)
      } catch {
        throw new Error('guest cookie storage unavailable')
      } finally {
        if (fd !== undefined) closeSync(fd)
        try { rmSync(temporary, { force: true }) } catch { /* A failed write may leave an owner-only temporary file. */ }
      }
    }, saved)
    this.jars.set(profile, jar)
    return jar
  }
}

const stores = new Map<string, GuestCookieStore>()

/** rc.5 token-login Web has one local profile per DSH_HOME, shared across conversations. */
export function localGuestCookies(): GuestCookieJar {
  const directory = join(dshHome(), 'dsh-builtin-browser-host', 'web-cookies')
  let store = stores.get(directory)
  if (store === undefined) {
    store = new GuestCookieStore(directory)
    stores.set(directory, store)
  }
  return store.forProfile(LOCAL_GUEST_PROFILE)
}
