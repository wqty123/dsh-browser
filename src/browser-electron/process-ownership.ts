import { execFile } from 'node:child_process'
import { readFile, readlink } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import type { ChildProcess } from 'node:child_process'

export interface ProcessIdentity {
  readonly pid: number
  readonly created: string
  readonly executable: string
  readonly argv: readonly string[]
}

export type ProcessInspector = (pid: number) => Promise<ProcessIdentity | undefined>
export interface ProcessOwnershipOptions {
  readonly managed: boolean
  readonly inspect?: ProcessInspector
}

const execute = promisify(execFile)
const windowsInspection = String.raw`
$ErrorActionPreference='Stop'
try {
  [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
  $p=Get-CimInstance Win32_Process -Filter ('ProcessId='+$env:DSH_INSPECT_PID)
  if($null -eq $p -or !$p.ExecutablePath -or !$p.CommandLine -or !$p.CreationDate) { throw 'Process identity is unavailable' }
  @{pid=[int]$p.ProcessId;created=$p.CreationDate.ToUniversalTime().Ticks.ToString();
    executable=$p.ExecutablePath;commandLine=$p.CommandLine} | ConvertTo-Json -Compress
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 2 }
`

export function parseWindowsCommandLine(command: string): string[] {
  const argv: string[] = []
  let value = '', quoted = false, started = false
  for (let i = 0; i < command.length; i++) {
    const char = command[i]!
    if ((char === ' ' || char === '\t') && !quoted) {
      if (started) argv.push(value)
      value = ''; started = false
      continue
    }
    started = true
    if (char === '\\') {
      let count = 1
      while (command[i + 1] === '\\') { count++; i++ }
      if (command[i + 1] !== '"') { value += '\\'.repeat(count); continue }
      value += '\\'.repeat(Math.floor(count / 2))
      if (count % 2) { value += '"'; i++; continue }
      i++
    } else if (char !== '"') { value += char; continue }
    if (quoted && command[i + 1] === '"') { value += '"'; i++ }
    else quoted = !quoted
  }
  if (started) argv.push(value)
  return argv
}

export async function inspectProcess(pid: number, diagnose?: (reason: string) => void): Promise<ProcessIdentity | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execute(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(windowsInspection, 'utf16le').toString('base64')],
        { windowsHide: true, timeout: 15000, maxBuffer: 128 * 1024, env: { ...process.env, DSH_INSPECT_PID: String(pid) } })
      const result = JSON.parse(stdout.replace(/^\uFEFF/u, ''))
      if (result.pid !== pid || typeof result.created !== 'string' || !result.created
        || typeof result.executable !== 'string' || !result.executable
        || typeof result.commandLine !== 'string' || !result.commandLine) throw new Error('Windows returned an incomplete or mismatched process identity')
      return { pid, created: result.created, executable: result.executable, argv: parseWindowsCommandLine(result.commandLine) }
    }
    if (process.platform === 'linux') {
      const root = `/proc/${pid}`
      const before = await readFile(`${root}/stat`, 'utf8')
      const executable = await readlink(`${root}/exe`)
      const command = await readFile(`${root}/cmdline`, 'utf8')
      const after = await readFile(`${root}/stat`, 'utf8')
      const start = (stat: string): string | undefined => stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]
      const created = start(before)
      if (!created || created !== start(after) || !command.endsWith('\0')) return undefined
      return { pid, created, executable, argv: command.slice(0, -1).split('\0') }
    }
  } catch (error) { diagnose?.(String(error).slice(-2000)) }
  return undefined
}

function canonical(path: string): string {
  const actual = realpathSync(path)
  return process.platform === 'win32' ? actual.toLowerCase() : actual
}

function personalProfile(path: string): boolean {
  const roots = process.platform === 'win32'
    ? ['Microsoft/Edge/User Data', 'Google/Chrome/User Data', 'BraveSoftware/Brave-Browser/User Data']
      .map(name => join(process.env.LOCALAPPDATA || homedir(), name))
    : process.platform === 'darwin'
      ? ['Microsoft Edge', 'Google/Chrome', 'BraveSoftware/Brave-Browser'].map(name => join(homedir(), 'Library', 'Application Support', name))
      : ['microsoft-edge', 'google-chrome', 'chromium', 'BraveSoftware/Brave-Browser'].map(name => join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), name))
  return roots.some(root => {
    let actual: string
    try { actual = canonical(root) } catch { actual = resolve(root); if (process.platform === 'win32') actual = actual.toLowerCase() }
    const child = relative(actual, path)
    return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child))
  })
}

function dataDirectory(argv: readonly string[]): string | undefined {
  const values: string[] = []
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === '--user-data-dir') values.push(argv[++i] ?? '')
    else if (arg.startsWith('--user-data-dir=')) values.push(arg.slice('--user-data-dir='.length))
  }
  return values.length === 1 && values[0] !== '' ? values[0] : undefined
}

export class BrowserProcessOwnership {
  private readonly records = new WeakMap<ChildProcess, { identity: ProcessIdentity; executable: string; directory: string }>()

  constructor(private readonly executable: string, private readonly directory: string,
    private readonly options: ProcessOwnershipOptions) {}

  private live(child: ChildProcess): boolean {
    return Number.isSafeInteger(child.pid) && child.exitCode === null && child.signalCode === null
  }

  async capture(child: ChildProcess): Promise<void> {
    if (!this.options.managed || !this.live(child)) return
    try {
      const record = await (this.options.inspect ?? inspectProcess)(child.pid!)
      if (!record || !this.live(child) || record.pid !== child.pid || !record.created) return
      const directory = canonical(this.directory), argument = dataDirectory(record.argv)
      if (!argument || personalProfile(directory) || canonical(argument) !== directory
        || canonical(record.executable) !== canonical(this.executable)) return
      this.records.set(child, { identity: record, executable: canonical(record.executable), directory })
    } catch { /* Fail closed. */ }
  }

  async verify(child: ChildProcess): Promise<boolean> {
    const captured = this.records.get(child)
    if (!captured || !this.live(child)) return false
    const record = captured.identity
    try {
      const current = await (this.options.inspect ?? inspectProcess)(record.pid)
      return this.live(child) && current !== undefined && current.pid === record.pid
        && current.created === record.created && current.executable === record.executable
        && JSON.stringify(current.argv) === JSON.stringify(record.argv)
        && canonical(current.executable) === captured.executable && canonical(this.executable) === captured.executable
        && canonical(dataDirectory(current.argv) ?? '') === captured.directory && this.ownsDirectory(child)
    } catch { return false }
  }

  ownsDirectory(child: ChildProcess, path = this.directory): boolean {
    const captured = this.records.get(child)
    try {
      return captured !== undefined && canonical(path) === captured.directory
        && canonical(this.directory) === captured.directory && !personalProfile(captured.directory)
    } catch { return false }
  }

  async terminate(child: ChildProcess): Promise<boolean> {
    if (!await this.verify(child) || !this.live(child)) return false
    try { return child.kill() } catch { return false }
  }
}
