import { PROFILE_COMMAND_TIMEOUT_MS } from '../../assets/browser-policy.mjs'
import { execFile, spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { windowsPowerShellPath } from './windows-system.ts'
import { MaintenanceRecoveryError } from './maintenance-lifecycle.ts'

/** Terminate the complete package-manager tree before allowing a profile rollback. */
export async function runProfileCommand(command: string, args: readonly string[], environment: NodeJS.ProcessEnv, timeoutMs = PROFILE_COMMAND_TIMEOUT_MS): Promise<{ code: number; output: string }> {
  const taskkill = process.platform === 'win32' ? join(dirname(dirname(dirname(windowsPowerShellPath(environment)))), 'taskkill.exe') : undefined
  return await new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { env: environment, windowsHide: true, shell: false, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', timedOut = false
    let termination: Promise<void> | undefined
    const append = (data: Buffer): void => { output = (output + data.toString()).slice(-1_048_576) }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    const timer = setTimeout(() => {
      timedOut = true
      if (child.pid === undefined) return
      const pid = child.pid
      termination = new Promise((done, reject) => {
        if (taskkill !== undefined) {
          execFile(taskkill, ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 10_000 }, error => { if (error) reject(error); else done() })
        } else {
          try { process.kill(-pid, 'SIGKILL'); done() } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ESRCH') done()
            else reject(error)
          }
        }
      })
      void termination.catch(error => {
        child.unref()
        child.stdout.destroy()
        child.stderr.destroy()
        reject(new MaintenanceRecoveryError(`${output}\nREINSTALL_ROLLBACK_FAILED: cannot confirm package-manager termination: ${String(error)}`))
      })
    }, timeoutMs)
    child.once('error', error => { clearTimeout(timer); resolve({ code: 1, output: `REINSTALL_COMMAND_START_FAILED: ${error.message}` }) })
    child.once('close', async (code, signal) => {
      clearTimeout(timer)
      try { await termination } catch (error) {
        reject(new MaintenanceRecoveryError(`${output}\nREINSTALL_ROLLBACK_FAILED: cannot confirm package-manager termination: ${String(error)}`)); return
      }
      resolve({ code: timedOut ? 1 : code ?? 1, output: `${output}${timedOut ? `\nREINSTALL_COMMAND_TIMEOUT: exceeded ${timeoutMs}ms; package-manager tree terminated` : signal === null ? '' : `\nREINSTALL_COMMAND_SIGNAL: ${signal}`}`.trim() })
    })
  })
}
