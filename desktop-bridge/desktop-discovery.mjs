import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function registeredInstallLocations(platform = process.platform, query = execFileSync) {
  if (platform !== 'win32') return []
  const roots = [
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ]
  const locations = []
  for (const root of roots) {
    try {
      const output = query('reg', ['query', root, '/s', '/f', 'DeepSeek Harness', '/t', 'REG_SZ'],
        { encoding: 'utf8', stdio: 'pipe', timeout: 15_000, windowsHide: true })
      for (const line of output.split(/\r?\n/)) {
        const match = /^\s+InstallLocation\s+REG_SZ\s+(.+?)\s*$/.exec(line)
        if (match !== null && match[1] !== '') locations.push(match[1])
      }
    } catch {}
  }
  return locations
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
