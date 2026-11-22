/**
 * Start a local maintenance coordinator outside the requesting app's tree: through WMI on Windows,
 * as a detached session leader on macOS (which survives the app quitting).
 * This primitive only creates the requested process; its caller owns maintenance authorization,
 * the coordinator's plan, readiness handshake and normal application shutdown.
 * @module dsh-browser/browser-electron/maintenance-broker
 */
import { execFile, spawn } from 'node:child_process'
import { statSync } from 'node:fs'
import { isAbsolute, posix, win32 } from 'node:path'
import { encodePowerShellScript, windowsPowerShellPath } from './windows-system.ts'

export interface MaintenanceBrokerOptions {
  readonly runtimePath: string
  readonly args: readonly string[]
  readonly cwd: string
  /** Overrides for the explicitly inherited environment; undefined removes a variable. */
  readonly environment?: Readonly<Record<string, string | undefined>>
}

export interface MaintenanceBrokerExecution {
  readonly windowsHide: true
  readonly shell: false
  readonly encoding: 'utf8'
  readonly timeout: number
  readonly maxBuffer: number
  readonly env: NodeJS.ProcessEnv
}

export type MaintenanceBrokerExecutor = (
  file: string,
  args: readonly string[],
  options: MaintenanceBrokerExecution,
) => Promise<{ readonly stdout: string; readonly stderr: string }>

export interface MaintenanceBrokerDeps {
  /** Tests supply a fake executor; the real broker is prohibited inside the test runner. */
  readonly execFile?: MaintenanceBrokerExecutor
  readonly platform?: NodeJS.Platform
}

export interface MaintenanceBrokerResult {
  readonly pid: number
}

/** Quote one argument using the Windows C runtime's command-line decoding rules. */
export function quoteWin32Argument(value: string): string {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('a Windows process argument must be a string without NUL')
  // Backslashes are literal except immediately before a quote or the closing quote. At those
  // positions each slash must be doubled, and an embedded quote receives one additional slash.
  return '"' + value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1') + '"'
}

function absolutePath(value: string, label: string): string {
  if (typeof value !== 'string' || value.includes('\0') || value.includes('"')
    || !/^(?:[A-Za-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/.test(value)) {
    throw new Error(`${label} must be a fully qualified Windows path without NUL or quotes`)
  }
  return win32.normalize(value)
}

/** Apply Windows' case-insensitive variable names before passing one explicit environment. */
function inheritEnvironment(overrides: MaintenanceBrokerOptions['environment']): NodeJS.ProcessEnv {
  const environment = { ...process.env }
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (key === '' || /[=\0]/.test(key) || (value !== undefined && (typeof value !== 'string' || value.includes('\0')))) {
      throw new Error('maintenance environment names and values must be valid Windows environment strings')
    }
    for (const existing of Object.keys(environment)) if (existing.toUpperCase() === key.toUpperCase()) delete environment[existing]
    if (value !== undefined) environment[key] = value
  }
  return environment
}

function underTest(environment: NodeJS.ProcessEnv): boolean {
  return Object.entries(environment).some(([key, value]) =>
    (key.toUpperCase() === 'DSH_BROWSER_TEST' && value === '1')
      || (key.toUpperCase() === 'NODE_TEST_CONTEXT' && value !== undefined))
}

const defaultExecutor: MaintenanceBrokerExecutor = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, [...args], options, (error, stdout, stderr) => {
    if (error !== null) {
      const reason = stderr.trim() || (error as NodeJS.ErrnoException).code || 'PowerShell did not complete'
      reject(new Error(`Windows maintenance broker failed: ${String(reason).slice(-1_000)}`))
    } else resolve({ stdout, stderr })
  })
})

/** macOS: a new session (setsid) with no inherited stdio, so the coordinator outlives Desktop. */
async function launchDetached(options: MaintenanceBrokerOptions, environment: NodeJS.ProcessEnv): Promise<MaintenanceBrokerResult> {
  for (const [label, value] of [['runtimePath', options.runtimePath], ['cwd', options.cwd]] as const) {
    if (typeof value !== 'string' || value.includes('\0') || !isAbsolute(value)) throw new Error(`${label} must be an absolute path without NUL`)
  }
  const runtimePath = posix.normalize(options.runtimePath)
  const cwd = posix.normalize(options.cwd)
  if (!statSync(runtimePath).isFile()) throw new Error('the maintenance runtime is not a file')
  if (!statSync(cwd).isDirectory()) throw new Error('the maintenance working directory is not a directory')
  if (!Array.isArray(options.args)) throw new Error('maintenance arguments must be an array')
  return await new Promise((resolve, reject) => {
    const child = spawn(runtimePath, [...options.args], { cwd, env: environment, detached: true, stdio: 'ignore', shell: false })
    child.once('error', error => { reject(new Error(`maintenance broker failed: ${String(error)}`)) })
    child.once('spawn', () => {
      child.unref()
      if (!Number.isSafeInteger(child.pid) || Number(child.pid) <= 0) reject(new Error('the maintenance broker returned no valid process id'))
      else resolve({ pid: Number(child.pid) })
    })
  })
}

/**
 * Create a hidden, independent local process. No shell evaluates runtime paths or arguments.
 * WMI receives an explicit environment copied from this process, including any plan overrides;
 * it therefore does not accidentally inherit the provider service's unrelated environment.
 */
export async function launchMaintenanceBroker(
  options: MaintenanceBrokerOptions,
  deps: MaintenanceBrokerDeps = {},
): Promise<MaintenanceBrokerResult> {
  const environment = inheritEnvironment(options.environment)
  if (deps.execFile === undefined && (underTest(process.env) || underTest(environment))) {
    throw new Error('the real Windows maintenance broker is disabled in tests; inject a fake executor')
  }
  const platform = deps.platform ?? process.platform
  if (platform === 'darwin') return await launchDetached(options, environment)
  if (platform !== 'win32') throw new Error('the maintenance broker requires Windows or macOS')
  const runtimePath = absolutePath(options.runtimePath, 'runtimePath')
  const cwd = absolutePath(options.cwd, 'cwd')
  if (!statSync(runtimePath).isFile()) throw new Error('the maintenance runtime is not a file')
  if (!statSync(cwd).isDirectory()) throw new Error('the maintenance working directory is not a directory')
  if (!Array.isArray(options.args)) throw new Error('maintenance arguments must be an array')
  const commandLine = [runtimePath, ...options.args].map(quoteWin32Argument).join(' ')
  if (commandLine.length >= 32_767) throw new Error('the maintenance command exceeds the Windows command-line limit')
  const payload = Buffer.from(JSON.stringify({ commandLine, cwd }), 'utf8').toString('base64')
  // The only interpolated script data is Base64 JSON. The full environment is inherited by
  // execFile, then read as data here rather than embedded in the PowerShell command line.
  const script = `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
try {
  $plan = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
  $environment = [string[]]@([System.Environment]::GetEnvironmentVariables('Process').GetEnumerator() | ForEach-Object { [string]$_.Key + '=' + [string]$_.Value })
  $startup = New-CimInstance -Namespace root/cimv2 -ClassName Win32_ProcessStartup -ClientOnly -Property @{ ShowWindow = [uint16]0; CreateFlags = [uint32]1024; EnvironmentVariables = $environment }
  $result = Invoke-CimMethod -Namespace root/cimv2 -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = [string]$plan.commandLine; CurrentDirectory = [string]$plan.cwd; ProcessStartupInformation = $startup }
  @{ code = [uint32]$result.ReturnValue; pid = [uint32]$result.ProcessId } | ConvertTo-Json -Compress
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  exit 1
}
`
  const encoded = encodePowerShellScript(script)
  const powershellPath = windowsPowerShellPath()
  if (encoded.length + powershellPath.length + 100 >= 32_767) throw new Error('the encoded maintenance broker command exceeds the Windows command-line limit')
  const result = await (deps.execFile ?? defaultExecutor)(powershellPath,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { windowsHide: true, shell: false, encoding: 'utf8', timeout: 30_000, maxBuffer: 64_000, env: environment })
  let record: { code?: unknown; pid?: unknown }
  try { record = JSON.parse(result.stdout.replace(/^\uFEFF/, '').trim()) as typeof record } catch {
    throw new Error('the Windows maintenance broker returned an unreadable result')
  }
  if (record === null || typeof record !== 'object' || !Number.isSafeInteger(record.code) || Number(record.code) < 0) {
    throw new Error('the Windows maintenance broker returned an invalid result')
  }
  if (record.code !== 0) throw new Error(`Windows maintenance broker refused process creation (WMI code ${String(record.code)})`)
  if (!Number.isSafeInteger(record.pid) || Number(record.pid) <= 0) throw new Error('the Windows maintenance broker returned no valid process id')
  return { pid: Number(record.pid) }
}
