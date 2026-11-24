import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEFAULT_DISPLAY_NAMES = ['DeepSeek Harness', 'DSH Desktop']
const MAX_SUBKEY_LOOKUPS = 16

function parseInstallLocationLine(line, env = process.env) {
  const match = /^\s+InstallLocation\s+(REG_(?:EXPAND_)?SZ)\s+(.+?)\s*$/.exec(line)
  if (!match) return undefined
  let location = match[2].replace(/^"(.*)"$/, '$1').trim()
  if (location === '') return undefined
  if (match[1] === 'REG_EXPAND_SZ') {
    location = location.replace(/%([^%]+)%/g, (whole, name) => env[name] ?? env[name.toUpperCase()] ?? whole)
  }
  return location
}

export function registeredInstallLocations(platform = process.platform, query = execFileSync, displayName = DEFAULT_DISPLAY_NAMES) {
  if (platform !== 'win32') return []
  const roots = [
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ]
  const names = Array.isArray(displayName) ? displayName : [displayName]
  const execOptions = { encoding: 'utf8', stdio: 'pipe', timeout: 15_000, windowsHide: true }
  const locations = new Set()
  const pendingKeys = new Set()
  for (const name of names) {
    if (typeof name !== 'string' || name === '') continue
    for (const root of roots) {
      try {
        const output = query('reg', ['query', root, '/s', '/f', name, '/t', 'REG_SZ'], execOptions)
        let currentKey
        let currentKeyHasLocation = false
        const flushKey = () => {
          if (currentKey !== undefined && !currentKeyHasLocation) pendingKeys.add(currentKey)
        }
        for (const rawLine of String(output).split(/\r?\n/)) {
          const trimmed = rawLine.trim()
          if (/^HKEY_/.test(trimmed)) {
            flushKey()
            currentKey = trimmed
            currentKeyHasLocation = false
            continue
          }
          const location = parseInstallLocationLine(rawLine)
          if (location !== undefined) {
            locations.add(location)
            currentKeyHasLocation = true
          }
        }
        flushKey()
      } catch {}
    }
  }
  // `reg query ... /s /f <name>` only prints lines whose key or value contains `<name>`; when an app
  // is installed to a custom directory whose path does not include `<name>`, `DisplayName` matches
  // while `InstallLocation` is omitted. Follow up on each matched uninstall key to read it directly.
  let lookups = 0
  for (const key of pendingKeys) {
    if (lookups >= MAX_SUBKEY_LOOKUPS) break
    lookups += 1
    try {
      const output = query('reg', ['query', key, '/v', 'InstallLocation'], execOptions)
      for (const rawLine of String(output).split(/\r?\n/)) {
        const location = parseInstallLocationLine(rawLine)
        if (location !== undefined) locations.add(location)
      }
    } catch {}
  }
  return [...locations]
}

export function conventionalInstallRoots(platform = process.platform, home = homedir()) {
  if (platform === 'darwin') {
    return ['/Applications', ...home === '' ? [] : [join(home, 'Applications')]]
      .flatMap(base => ['DeepSeek Harness.app', 'DSH Desktop.app'].map(name => join(base, name)))
  }
  if (platform === 'linux') {
    return ['/opt', '/usr/lib', ...home === '' ? [] : [join(home, '.local', 'share')]]
      .flatMap(base => ['DeepSeek Harness', 'DSH Desktop'].map(name => join(base, name)))
  }
  return []
}
