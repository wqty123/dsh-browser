import { closeSync, mkdirSync, openSync, readFileSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { basename, dirname, join } from 'node:path'

export interface ProfileLease {
  release(cleanup?: () => void): Promise<void>
}

/** Exclusive ownership of the plugin profile, including launch and shutdown. */
export function acquireProfileLease(directory: string): ProfileLease {
  mkdirSync(directory, { recursive: true })
  const root = realpathSync(directory)
  const file = join(root, '.dsh-browser-lease.json')
  const guard = join(dirname(root), `.${basename(root)}.dsh-browser-lease.guard`)
  const token = randomUUID()
  const busy = (): Error => new Error(`dsh-builtin-browser: browser profile is leased or its ownership cannot be verified: ${root}`)
  const guarded = <T>(operation: () => T): T => {
    try { mkdirSync(guard) } catch { throw busy() }
    try { return operation() } finally { rmdirSync(guard) }
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
      try { process.kill(Number(owner.pid), 0); throw busy() }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw busy()
      }
      unlinkSync(file)
    }
    const fd = openSync(file, 'wx', 0o600)
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token })) }
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
