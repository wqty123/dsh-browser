/** Locate Windows system tools from the running system rather than an assumed system drive. */
import { existsSync } from 'node:fs'
import { win32 } from 'node:path'

export function windowsPowerShellPath(
  environment: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string {
  const read = (name: string): string | undefined => Object.entries(environment)
    .find(([key]) => key.toUpperCase() === name)?.[1]
  const root = read('SYSTEMROOT') || read('WINDIR')
  if (root === undefined || !/^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(root)) {
    throw new Error('Windows system directory is unavailable; SystemRoot or WINDIR must identify the current system')
  }
  const path = win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  if (!exists(path)) throw new Error('Windows PowerShell is unavailable in the detected system directory')
  return path
}
