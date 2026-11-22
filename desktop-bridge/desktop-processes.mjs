import { realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve, sep } from 'node:path'

export function isDesktopExecutable(path, executable, bundleRoot, platform = process.platform) {
  if (typeof path !== 'string' || !isAbsolute(path)) return false
  const canonical = value => {
    if (platform === 'win32') return resolve(value).toLowerCase()
    try { return realpathSync.native(value) } catch { return resolve(value) }
  }
  const candidate = canonical(path)
  if (candidate === canonical(executable)) return true
  if (bundleRoot === undefined) return false
  const part = relative(canonical(bundleRoot), candidate)
  return part !== '' && !isAbsolute(part) && part !== '..' && !part.startsWith('..' + sep)
}
