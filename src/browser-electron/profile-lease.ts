import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { connect, createServer, type Server } from 'node:net'
import { execFileSync } from 'node:child_process'
import { basename, dirname, join } from 'node:path'

const STALE_GUARD_MS = 10_000
const PIPE_PROBE_MS = 1000
const PIPE_PREFIX = '\\\\.\\pipe\\dsh-browser-lease-'
/**
 * How the OS identifies process `pid`'s start, as an opaque string; undefined when it cannot tell.
 * Owner and checker derive it the same way from the same OS record, so clock or DST changes cancel out.
 */
export function processIdentity(pid: number): string | undefined {
  try {
    if (process.platform === 'win32') return undefined
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] || undefined
    }
    const text = execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', timeout: 2000, env: { ...process.env, TZ: 'UTC', LC_ALL: 'C' } })
    return text.trim() || undefined
  } catch {
    return undefined
  }
}

let ownIdentity: string | undefined

/** A named pipe exists only while its server is open, so it dies with the owner however that ends. */
function openOwnerPipe(root: string, token: string): Promise<{ readonly name: string; readonly server: Server } | undefined> {
  const name = `${PIPE_PREFIX}${createHash('sha256').update(root).digest('hex').slice(0, 32)}-${token}`
  return new Promise(resolve => {
    const server = createServer(socket => socket.destroy())
    server.once('error', () => resolve(undefined))
    server.listen(name, () => { server.unref(); resolve({ name, server }) })
  })
}

function pipeAnswers(name: string): Promise<boolean> {
  return new Promise(resolve => {
    const socket = connect(name)
    const done = (alive: boolean): void => { clearTimeout(timer); socket.destroy(); resolve(alive) }
    const timer = setTimeout(() => done(true), PIPE_PROBE_MS)
    socket.once('connect', () => done(true))
    socket.once('error', error => {
      const code = (error as NodeJS.ErrnoException).code
      done(code !== 'ENOENT' && code !== 'ECONNREFUSED')
    })
  })
}

/** A live PID is still the owner only if the OS ties it to the owner; Windows reuses PIDs quickly. */
async function ownerAlive(owner: { pid?: unknown; pipe?: unknown; identity?: unknown }): Promise<boolean> {
  try { process.kill(Number(owner.pid), 0) }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
  if (process.platform === 'win32') {
    return typeof owner.pipe !== 'string' || !owner.pipe.startsWith(PIPE_PREFIX) || await pipeAnswers(owner.pipe)
  }
  if (typeof owner.identity !== 'string' || owner.identity === '') return true
  const actual = processIdentity(Number(owner.pid))
  return actual === undefined || actual === owner.identity
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
export async function acquireProfileLease(directory: string): Promise<ProfileLease> {
  mkdirSync(directory, { recursive: true })
  const root = realpathSync(directory)
  const file = join(root, '.dsh-browser-lease.json')
  const guard = join(dirname(root), `.${basename(root)}.dsh-browser-lease.guard`)
  const token = randomUUID()
  const identity = ownIdentity ??= processIdentity(process.pid)
  let pipe: { readonly name: string; readonly server: Server } | undefined
  const busy = (): Error => new Error(`dsh-builtin-browser: browser profile is leased or its ownership cannot be verified: ${root}`)
  const guarded = async <T>(operation: () => T | Promise<T>): Promise<T> => {
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
    try { return await operation() } finally {
      try { unlinkSync(guard) } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
    }
  }
  try {
    await guarded(async () => {
      let previous: unknown
      try { previous = JSON.parse(readFileSync(file, 'utf8')) }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw busy()
        previous = undefined
      }
      if (previous !== undefined) {
        const owner = previous as { pid?: unknown; token?: unknown } | null
        if (!owner || !Number.isSafeInteger(owner.pid) || Number(owner.pid) <= 0 || typeof owner.token !== 'string') throw busy()
        if (await ownerAlive(owner as { pid?: unknown; pipe?: unknown; identity?: unknown })) throw busy()
        unlinkSync(file)
      }
      if (process.platform === 'win32') pipe = await openOwnerPipe(root, token)
      const fd = openSync(file, 'wx', 0o600)
      try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token, ...(identity === undefined ? {} : { identity }), ...(pipe === undefined ? {} : { pipe: pipe.name }) })) }
      finally { closeSync(fd) }
    })
  } catch (error) {
    pipe?.server.close()
    throw error
  }
  let released = false
  return {
    async release(cleanup) {
      if (released) return
      const deadline = Date.now() + 1000
      for (;;) {
        try {
          await guarded(() => {
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
          pipe?.server.close()
          return
        } catch (error) {
          if (Date.now() >= deadline) throw error
          await new Promise(resolve => setTimeout(resolve, 20))
        }
      }
    },
  }
}
