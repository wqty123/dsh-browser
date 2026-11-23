import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { basename, dirname, join } from 'node:path'

const STALE_GUARD_MS = 10_000
/**
 * How the OS identifies process `pid`'s start, as an opaque string; undefined when it cannot tell.
 * Owner and checker derive it the same way from the same OS record, so clock or DST changes cancel out.
 */
export function processIdentity(pid: number): string | undefined {
  try {
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] || undefined
    }
    const text = process.platform === 'win32'
      ? execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc()`],
      { encoding: 'utf8', timeout: 10_000, windowsHide: true })
      : execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } })
    return text.trim() || undefined
  } catch {
    return undefined
  }
}

let ownIdentity: string | undefined

/** A live PID is still the owner only if the OS gives it the start the owner recorded; Windows reuses PIDs quickly. */
function ownerAlive(pid: number, identity: unknown): boolean {
  try { process.kill(pid, 0) }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
  if (typeof identity !== 'string' || identity === '') return true
  const actual = processIdentity(pid)
  return actual === undefined || actual === identity
}

export interface ProfileLease {
  release(cleanup?: () => void): Promise<void>
}

function isStaleGuard(guardPath: string, leasePath: string): boolean {
  try {
    const ownerPath = statSync(guardPath).isDirectory() ? leasePath : guardPath
    const raw = JSON.parse(readFileSync(ownerPath, 'utf8')) as { pid?: unknown } | null
    if (raw && Number.isSafeInteger(raw.pid) && Number(raw.pid) > 0) {
      try { process.kill(Number(raw.pid), 0) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
      }
      return false
    }
  } catch { /* fall through to mtime check */ }
  try {
    return Date.now() - statSync(guardPath).mtimeMs > STALE_GUARD_MS
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
}

/** Exclusive ownership of the plugin profile, including launch and shutdown. */
export function acquireProfileLease(directory: string): ProfileLease {
  mkdirSync(directory, { recursive: true })
  const root = realpathSync(directory)
  const file = join(root, '.dsh-browser-lease.json')
  const guard = join(dirname(root), `.${basename(root)}.dsh-browser-lease.guard`)
  const token = randomUUID()
  const identity = ownIdentity ??= processIdentity(process.pid) ?? ''
  const busy = (): Error => new Error(`dsh-builtin-browser: browser profile is leased or its ownership cannot be verified: ${root}`)
  const guarded = <T>(operation: () => T): T => {
    let acquired = false
    for (let attempt = 0; attempt < 2; attempt += 1) {
      let fd: number | undefined
      try {
        fd = openSync(guard, 'wx', 0o600)
        writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }))
        acquired = true
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw busy()
        if (attempt === 0 && isStaleGuard(guard, file)) {
          try {
            if (statSync(guard).isDirectory()) rmdirSync(guard)
            else unlinkSync(guard)
          } catch { /* raced with another cleaner */ }
          continue
        }
        throw busy()
      } finally {
        if (fd !== undefined) { try { closeSync(fd) } catch {} }
      }
    }
    if (!acquired) throw busy()
    try { return operation() } finally {
      try { unlinkSync(guard) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
  guarded(() => {
    let previous: unknown
    try { previous = JSON.parse(readFileSync(file, 'utf8')) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw busy()
      previous = undefined
    }
    if (previous !== undefined) {
      const owner = previous as { pid?: unknown; token?: unknown } | null
      if (!owner || !Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0 || typeof owner.token !== 'string') throw busy()
      if (ownerAlive(Number(owner.pid), (owner as { identity?: unknown }).identity)) throw busy()
      unlinkSync(file)
    }
    const fd = openSync(file, 'wx', 0o600)
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token, ...(identity === '' ? {} : { identity }) })) }
    finally { closeSync(fd) }
  })
  let released = false
  return {
    async release(cleanup) {
      if (released) return
      const deadline = Date.now() + 1000
      for (;;) {
        try {
          guarded(() => {
            let owner: { token?: unknown }
            try { owner = JSON.parse(readFileSync(file, 'utf8')) as { token?: unknown } }
            catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
            if (owner.token === token) {
              cleanup?.()
              try { unlinkSync(file) } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
              }
            }
          })
          released = true
          return
        } catch (error) {
          if (Date.now() >= deadline) throw error
          await new Promise(resolve => setTimeout(resolve, 20))
        }
      }
    },
  }
}
