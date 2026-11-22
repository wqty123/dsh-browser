import { renameSync } from 'node:fs'
import { rename } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'

const backoff = [20, 40, 80, 160, 250, 250, 250, 250]
const transient = error => ['EPERM', 'EBUSY', 'EACCES'].includes(error?.code)

export async function renameMaintenanceFile(source, target, effects = {}) {
  const move = effects.rename ?? rename
  const pause = effects.pause ?? setTimeout
  for (let attempt = 0; ; attempt++) {
    try { await move(source, target); return } catch (error) {
      if (!transient(error) || attempt === backoff.length) throw error
      await pause(backoff[attempt])
    }
  }
}

export function renameMaintenanceFileSync(source, target, effects = {}) {
  const move = effects.rename ?? renameSync
  const pause = effects.pause ?? (ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms))
  for (let attempt = 0; ; attempt++) {
    try { move(source, target); return } catch (error) {
      if (!transient(error) || attempt === backoff.length) throw error
      pause(backoff[attempt])
    }
  }
}
