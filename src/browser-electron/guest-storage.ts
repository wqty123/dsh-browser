import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { dshHome } from './paths.ts'

type Entries = Map<string, string>
type Partitions = Map<string, Entries>
const MAX_STORE_BYTES = 64 * 1024 * 1024
const serialized = (partitions: Partitions): string => JSON.stringify([...partitions].map(([origin, entries]) => [origin, [...entries]]))

function fail(name: string): never { throw Object.assign(new Error(name), { name }) }

/** Storage capabilities are issued only in browser navigation responses, never fetchable HTML. */
export class GuestStorage {
  private readonly secret = randomBytes(32)
  private local: Partitions = new Map()
  private session: Partitions = new Map()

  constructor(private readonly directory?: string, private readonly quota = 5 * 1024 * 1024) {
    if (directory === undefined) return
    let fd: number | undefined
    try {
      fd = openSync(join(directory, 'storage.json'), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
      if (!fstatSync(fd).isFile() || fstatSync(fd).size > MAX_STORE_BYTES) return
      fchmodSync(fd, 0o600)
      const saved: unknown = JSON.parse(readFileSync(fd, 'utf8'))
      if (!saved || typeof saved !== 'object' || !('version' in saved) || saved.version !== 1
        || !('origins' in saved) || !Array.isArray(saved.origins)) return
      for (const item of saved.origins) {
        if (!Array.isArray(item) || item.length !== 2 || typeof item[0] !== 'string' || !Array.isArray(item[1])) continue
        try { if (new URL(item[0]).origin !== item[0] || !/^https?:/u.test(item[0])) continue } catch { continue }
        const entries: Entries = new Map()
        for (const pair of item[1]) {
          if (Array.isArray(pair) && pair.length === 2 && pair.every(value => typeof value === 'string')) entries.set(pair[0], pair[1])
        }
        if (this.size(entries) <= quota) this.local.set(item[0], entries)
      }
    } catch {} finally { if (fd !== undefined) closeSync(fd) }
  }

  issue(origin: string, context: string): string {
    const payload = Buffer.from(JSON.stringify({ origin, context })).toString('base64url')
    return payload + '.' + createHmac('sha256', this.secret).update(payload).digest('base64url')
  }

  execute(token: string, origin: string, input: unknown): unknown {
    if (token.length > 8192) fail('SecurityError')
    const [payload, signature, extra] = token.split('.')
    const expected = createHmac('sha256', this.secret).update(payload ?? '').digest()
    const received = Buffer.from(signature ?? '', 'base64url')
    if (extra !== undefined || received.length !== expected.length || !timingSafeEqual(received, expected)) fail('SecurityError')
    let scope: { origin?: unknown; context?: unknown }
    try { scope = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8')) } catch { fail('SecurityError') }
    if (scope?.origin !== origin || typeof scope.context !== 'string') fail('SecurityError')
    if (!input || typeof input !== 'object' || Array.isArray(input)) fail('TypeError')
    const { area, op, key, value } = input as Record<string, unknown>
    if (area !== 'local' && area !== 'session') fail('TypeError')
    if (!['entries', 'get', 'set', 'remove', 'clear'].includes(String(op))) fail('TypeError')
    if (op !== 'entries' && op !== 'clear' && typeof key !== 'string') fail('TypeError')
    if (op === 'set' && typeof value !== 'string') fail('TypeError')
    const partitions = area === 'local' ? this.local : this.session
    const partition = area === 'local' ? origin : JSON.stringify([scope.context, origin])
    const current = partitions.get(partition) ?? new Map<string, string>()
    if (op === 'entries') return [...current]
    if (op === 'get') return current.get(key as string) ?? null
    const next = new Map(current)
    if (op === 'clear') next.clear()
    else if (op === 'remove') next.delete(key as string)
    else next.set(key as string, value as string)
    if (this.size(next) > this.quota) fail('QuotaExceededError')
    const updated = new Map(partitions)
    if (next.size === 0) updated.delete(partition)
    else updated.set(partition, next)
    if (Buffer.byteLength(serialized(updated), 'utf8') > MAX_STORE_BYTES) fail('QuotaExceededError')
    if (area === 'local') {
      this.persist(updated)
      this.local = updated
    } else this.session = updated
    return null
  }

  private size(entries: Entries): number {
    return [...entries].reduce((size, [key, value]) => size + 2 * (key.length + value.length), 0)
  }

  private persist(origins: Partitions): void {
    if (this.directory === undefined) return
    const file = join(this.directory, 'storage.json'), temporary = file + '.' + randomUUID() + '.tmp'
    let fd: number | undefined
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      fd = openSync(temporary, 'wx', 0o600)
      fchmodSync(fd, 0o600)
      writeFileSync(fd, '{"version":1,"origins":' + serialized(origins) + '}')
      fsyncSync(fd)
      closeSync(fd); fd = undefined
      renameSync(temporary, file)
    } catch { fail('UnknownError') } finally {
      if (fd !== undefined) closeSync(fd)
      try { rmSync(temporary, { force: true }) } catch {}
    }
  }
}

const stores = new Map<string, GuestStorage>()
export function localGuestStorage(): GuestStorage {
  const directory = join(dshHome(), 'dsh-builtin-browser-host', 'web-storage')
  let store = stores.get(directory)
  if (store === undefined) { store = new GuestStorage(directory); stores.set(directory, store) }
  return store
}
