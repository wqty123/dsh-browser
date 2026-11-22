import { BROWSER_PROFILE_DIR } from '../../assets/browser-policy.mjs'
/** User-requested Desktop maintenance (Windows and macOS), coordinated outside the Desktop process tree. */
import { execFile, spawn } from 'node:child_process'
import * as fs from 'node:fs'
import { existsSync, readFileSync } from 'node:fs'
import { cp, mkdir, open, readFile, stat as statAsync, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareBridgeMaintenance } from './bridge-maintenance.ts'
import { launchMaintenanceBroker, type MaintenanceBrokerOptions, type MaintenanceBrokerResult } from './maintenance-broker.ts'
import { runMaintenanceLifecycle, type MaintenanceState } from './maintenance-lifecycle.ts'
import { defaultInstallerPath, runBridgeAction, waitForRestartedBridge, type BridgeActionResult, type HostPatchResult } from './bridge-install.ts'
import { desktopLayout, desktopPaths, readAsarFile, readDesktopIdentity } from './desktop-identity.ts'
import { dshHome } from './paths.ts'
import { encodePowerShellScript, windowsPowerShellPath } from './windows-system.ts'
import { renameMaintenanceFile } from '../../desktop-bridge/maintenance-files.mjs'
import { isDesktopExecutable } from '../../desktop-bridge/desktop-processes.mjs'
import { installedProfileExtension, repairProfileExtension, reconcileProfile, profileDependencySpec, profileRuntimeDirectory, MAIN_EXTENSION_NAME, type InstalledExtension } from './profile-extension.ts'
import { withProfileCheckpoint } from './profile-checkpoint.ts'
import { runProfileCommand } from './profile-command.ts'
import { cleanProfileResidue, inspectProfileResidue } from './profile-residue.ts'

const { hostPatchStatus }: { hostPatchStatus: (packages: readonly string[], options?: { fs: object }) => HostPatchResult } = await import(new URL('../../dsh-host-patch/apply.mjs', import.meta.url).href)
const { stripLegacyBridge }: { stripLegacyBridge: (text: string) => string | undefined } = await import(new URL('../../dsh-host-patch/legacy-bridge.mjs', import.meta.url).href)

interface DesktopProcess { readonly pid: number; readonly path: string; readonly command: string; readonly started: string }
export interface AutomaticMaintenanceJob extends MaintenanceState { readonly id: string; readonly workerPid?: number; readonly startedAt?: string }
export interface AutomaticMaintenanceOptions {
  readonly locale?: 'zh' | 'en'
}
interface AutomaticPlan {
  readonly version: 1
  readonly id: string
  readonly action: 'reinstall'
  readonly root: string
  readonly nodePath: string
  readonly electronNode: boolean
  readonly home: string
  readonly directory: string
  readonly target: DesktopProcess
  readonly createdAt: string
  readonly locale?: 'zh' | 'en'
  readonly dependency: string
  readonly nestedResidue?: readonly string[]
}

export class ReinstallPreflightError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

function archiveExists(path: string): boolean {
  const runtime = process as NodeJS.Process & { noAsar?: boolean }
  const previous = runtime.noAsar
  runtime.noAsar = true
  try { return existsSync(path) } finally { runtime.noAsar = previous }
}

function patchDirectories(root: string): string[] {
  const app = join(desktopPaths(root).resources, 'app')
  return [app, join(app, 'dsh', 'node_modules', '@deepseek-ai', 'dsh-client-ui-sidebar-right')]
}

function validateCliBackup(path: string, kind: 'host' | 'shim'): void {
  const backup = path + '.before-bridge'
  if (!existsSync(backup)) return
  if (![path, backup].every(file => fs.lstatSync(file).isFile() && !fs.lstatSync(file).isSymbolicLink())) {
    throw new ReinstallPreflightError('REINSTALL_BACKUP_CONFLICT', 'A CLI restore baseline is not a regular file.')
  }
  const original = readFileSync(backup, 'utf8'), current = readFileSync(path, 'utf8')
  if (current === original) return
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  let expected: string
  if (kind === 'host') {
    const call = /^(\t)await runDesktopCli\(((?:runtimeDir, )?)join\(dirname\(runtimeArchivePath\(runtimeDir\) \?\? runtimeDir\), "runtime"\)\);$/m.exec(original)
    if (call === null) throw new ReinstallPreflightError('REINSTALL_BACKUP_CONFLICT', 'The CLI differs from its recognized restore baseline.')
    expected = original.replace(call[0], () => [
      '\t// dsh-builtin-browser: recognize an unpacked `app` directory as the app root,',
      '\t// so an installation whose app.asar was moved aside still finds its runtime.',
      '\tconst cliOwnerDir = dirname(runtimeDir);',
      '\tconst cliSupportRoot = basename(cliOwnerDir) === "app" || basename(cliOwnerDir) === "app.asar" ? dirname(cliOwnerDir) : cliOwnerDir;',
      `\tawait runDesktopCli(${call[2]}join(cliSupportRoot, "runtime"));`,
    ].join(eol))
  } else {
    const injection = [
      'rem dsh-builtin-browser: resolve the app directory (resources\\app when the bridge is installed,',
      'rem resources\\app.asar on a stock installation).',
      'set "DSH_APP=%~dp0..\\..\\..\\app"',
      'if not exist "%DSH_APP%\\dsh\\node_modules\\@deepseek-ai\\dsh-desktop-host\\lib\\cli.js" set "DSH_APP=%~dp0..\\..\\..\\app.asar"',
    ].join(eol)
    const setLocal = /^.*setlocal.*$/m.exec(original)
    expected = (setLocal === null ? injection + eol + original : original.replace(setLocal[0], () => setLocal[0] + eol + injection))
      .replace(/%~dp0(?:\.\.\\)+app\.asar\\dsh\\/, () => '%DSH_APP%\\dsh\\')
  }
  if (current !== expected) throw new ReinstallPreflightError('REINSTALL_BACKUP_CONFLICT', 'The CLI differs from its recognized restore baseline.')
}

/** Inspect the archive Electron will load, never a leftover extraction beside it. */
export function inspectReinstallHost(root: string): ReturnType<typeof hostPatchStatus> {
  const identity = readDesktopIdentity(root)
  if (!identity.ok) throw new ReinstallPreflightError('REINSTALL_DESKTOP_INVALID', identity.reason)
  const archive = join(desktopPaths(root).resources, 'app.asar')
  if (archiveExists(archive) && existsSync(archive + '.before-bridge')) {
    throw new ReinstallPreflightError('REINSTALL_BACKUP_CONFLICT', 'Both the Desktop archive and its restore baseline exist.')
  }
  if (identity.layout === 'unpacked') return hostPatchStatus(patchDirectories(root))
  const app = patchDirectories(root)[0]!
  const archiveFile = (path: fs.PathLike): Buffer | undefined => readAsarFile(archive, relative(app, String(path)).split('\\').join('/'))
  const snapshot = {
    ...fs,
    realpathSync: (path: fs.PathLike) => resolve(String(path)),
    readFileSync: (path: fs.PathLike) => {
      const content = archiveFile(path)
      if (content === undefined) throw new Error(`Missing or unreadable archive entry: ${relative(app, String(path))}`)
      return content.toString('utf8')
    },
    existsSync: (path: fs.PathLike) => archiveFile(path) !== undefined,
    lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => false }),
    statSync: () => ({ mode: 0o644 }),
  }
  return hostPatchStatus(patchDirectories(root), { fs: snapshot })
}

/** Entirely read-only: a missing dependency never creates a lock, plan or replacement source. */
export async function preflightReinstall(root: string, home: string): Promise<string> {
  let dependency: string
  try { dependency = await profileDependencySpec(home) } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ReinstallPreflightError('REINSTALL_DEPENDENCY_MISSING', 'The Desktop profile has no dependency specification to reinstall.')
    throw error
  }
  if (/^(?:file|link):/.test(dependency)) {
    const path = resolve(home, 'profiles', 'desktop', dependency.slice(dependency.indexOf(':') + 1))
    try { fs.accessSync(path, fs.constants.R_OK) } catch {
      throw new ReinstallPreflightError('REINSTALL_DEPENDENCY_UNAVAILABLE', 'The captured local dependency source is not readable.')
    }
    const installed = join(home, 'profiles', 'desktop', 'node_modules', MAIN_EXTENSION_NAME)
    if (existsSync(installed)) {
      const source = fs.realpathSync(path)
      const owner = fs.lstatSync(installed).isSymbolicLink() ? resolve(home, 'profiles', 'desktop', 'node_modules') : fs.realpathSync(installed)
      if (source === owner || inside(owner, source)) throw new ReinstallPreflightError('REINSTALL_DEPENDENCY_UNSAFE', 'The captured dependency source would be deleted by plugin removal.')
    }
  }
  await inspectProfileResidue(home)
  const status = inspectReinstallHost(root)
  if (status.status !== 'absent' && status.status !== 'applied') throw new ReinstallPreflightError('REINSTALL_HOST_CONFLICT', status.reason ?? status.status)
  const cli = 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'
  const archive = join(desktopPaths(root).resources, 'app.asar')
  if (status.status === 'applied' && (archiveExists(archive) || ![
    join(desktopPaths(root).resources, 'app', 'lib', 'main.js'), join(desktopPaths(root).resources, 'app', 'lib', 'preload-app.cjs'),
    join(patchDirectories(root)[1]!, 'lib', 'client.js'),
  ].every(path => existsSync(path + '.before-dsh-host-patch')))) {
    throw new ReinstallPreflightError('REINSTALL_BACKUP_CONFLICT', 'An applied host patch has no usable external restore baseline.')
  }
  if (archiveExists(archive) ? readAsarFile(archive, cli) === undefined : !existsSync(join(desktopPaths(root).resources, 'app', cli))) {
    throw new ReinstallPreflightError('REINSTALL_CLI_MISSING', 'The authoritative Desktop CLI is missing or unreadable.')
  }
  validateCliBackup(join(desktopPaths(root).resources, 'runtime', 'cli', 'bin', 'dsh.cmd'), 'shim')
  if (!archiveExists(archive)) validateCliBackup(join(desktopPaths(root).resources, 'app', cli), 'host')
  const main = join(desktopPaths(root).resources, 'app', 'lib', 'main.js')
  if (!archiveExists(join(desktopPaths(root).resources, 'app.asar')) && existsSync(main + '.before-bridge')) {
    const original = readFileSync(main + '.before-bridge', 'utf8')
    const current = readFileSync(existsSync(main + '.before-dsh-host-patch') ? main + '.before-dsh-host-patch' : main, 'utf8')
    if ((stripLegacyBridge(current) ?? current) !== original) {
      throw new ReinstallPreflightError('REINSTALL_BACKUP_CONFLICT', 'The legacy bridge differs from its restore baseline.')
    }
  }
  if (!archiveExists(archive) && existsSync(archive + '.before-bridge')) {
    const preserved = readAsarFile(archive + '.before-bridge', 'lib/main.js')
    const current = readFileSync(existsSync(main + '.before-dsh-host-patch') ? main + '.before-dsh-host-patch' : main, 'utf8')
    if (preserved === undefined || preserved.toString('utf8') !== (stripLegacyBridge(current) ?? current)) {
      throw new ReinstallPreflightError('REINSTALL_BACKUP_CONFLICT', 'The preserved archive belongs to different Desktop bytes.')
    }
  }
  await profileRuntimeDirectory(root)
  return dependency
}

/** Copy only shipped runtime files; the running worker and installer survive profile removal. */
export async function stageReinstallRuntime(directory: string, source = fileURLToPath(new URL('../../', import.meta.url))): Promise<string> {
  const destination = join(directory, 'runtime')
  const packageDirectory = fs.realpathSync(source)
  const parent = fs.realpathSync(directory)
  if (parent === packageDirectory || inside(packageDirectory, parent)) throw new Error('Reinstall runtime must be staged outside the removed package')
  await mkdir(destination, { mode: 0o700 })
  for (const name of ['lib', 'assets', 'desktop-bridge', 'dsh-host-patch', 'package.json']) {
    await cp(join(packageDirectory, name), join(destination, name), { recursive: true, dereference: true, errorOnExist: true, force: false })
  }
  return join(destination, 'lib', 'browser-electron', 'automatic-maintenance.js')
}

export interface ReinstallSteps {
  readonly remove: () => Promise<BridgeActionResult>
  readonly absent: () => Promise<boolean>
  readonly revert: () => Promise<BridgeActionResult>
  readonly hostAbsent: () => boolean
  readonly apply: () => Promise<BridgeActionResult>
  readonly add: () => Promise<BridgeActionResult>
}

/** Called under the automatic job lock, only after the closed-process barrier. */
export async function runReinstallTransaction(steps: ReinstallSteps): Promise<BridgeActionResult> {
  const removed = await steps.absent() ? undefined : await steps.remove()
  if (removed && !removed.ok) throw new Error(`REINSTALL_REMOVE_FAILED: ${removed.output}`)
  if (!await steps.absent()) throw new Error('REINSTALL_REMOVE_FAILED: profile dependency remains installed')
  const wasAbsent = steps.hostAbsent()
  const reverted = await steps.revert()
  if (!reverted.ok && !(wasAbsent && steps.hostAbsent() && reverted.code === 1 && /^nothing to revert in /m.test(reverted.output)
    && !/error|refus|incomplete|EACCES|EPERM/i.test(reverted.output))) throw new Error(`REINSTALL_REVERT_FAILED: ${reverted.output}`)
  if (!steps.hostAbsent()) throw new Error('REINSTALL_REVERT_FAILED: host patch is still present')
  const applied = await steps.apply()
  if (!applied.ok || applied.hostPatch?.status !== 'applied') throw new Error(`REINSTALL_APPLY_FAILED: ${applied.output}`)
  const added = await steps.add()
  if (!added.ok) throw new Error(`REINSTALL_ADD_FAILED: ${added.output}`)
  return { ...added, hostPatch: applied.hostPatch, output: [removed?.output, reverted.output, applied.output, added.output].filter(Boolean).join('\n').slice(-20_000) }
}

const terminal = new Set(['completed', 'failed', 'cancelled'])
const workerPath = fileURLToPath(new URL('./automatic-maintenance.js', import.meta.url))
const quitPath = fileURLToPath(new URL('../../desktop-bridge/request-desktop-quit.ps1', import.meta.url))
const progressPath = fileURLToPath(new URL('../../desktop-bridge/maintenance-progress.ps1', import.meta.url))
const delay = async (ms: number): Promise<void> => await new Promise(resolve => setTimeout(resolve, ms))

/** A swallowed maintenance write still deserves one line of diagnostics; it never changes the answer. */
function reportMaintenanceFailure(label: string, error: unknown): void {
  console.error(`[dsh-browser maintenance] ${label}: ${String(error)}`)
}

function homePath(): string { return resolve(dshHome()) }
function basePath(home = homePath()): string { return join(home, BROWSER_PROFILE_DIR, 'maintenance') }
function inside(base: string, path: string): boolean {
  const part = relative(base, path)
  return part !== '' && !isAbsolute(part) && part !== '..' && !part.startsWith('..\\') && !part.startsWith('../')
}
/** Platforms whose Desktop can be quit, patched and reopened by the independent worker. */
export function automaticMaintenanceSupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === 'win32' || platform === 'darwin'
}
/** Same-path comparison: case-insensitive on Windows, by on-disk spelling elsewhere (APFS may be either). */
function samePath(a: string, b: string): boolean {
  return isDesktopExecutable(a, b)
}
function requireLiveDesktop(): void {
  if (!automaticMaintenanceSupported()) throw new Error('automatic bridge maintenance requires DSH Desktop on Windows or macOS')
  if (process.env.DSH_BROWSER_TEST === '1' || process.env.NODE_TEST_CONTEXT !== undefined) {
    throw new Error('automatic Desktop maintenance is forbidden in a test process')
  }
}
async function execute(command: string, args: readonly string[], timeout = 15_000, environment?: NodeJS.ProcessEnv): Promise<{ code: number; output: string; stdout: string }> {
  return await new Promise(resolve => {
    execFile(command, [...args], { windowsHide: true, shell: false, encoding: 'utf8', timeout, maxBuffer: 1_048_576,
      ...(environment === undefined ? {} : { env: environment }) }, (error, stdout, stderr) => {
      resolve({ code: error === null ? 0 : typeof error.code === 'number' ? error.code : 1, output: `${stdout}\n${stderr}`.trim(), stdout })
    })
  })
}
/** The Desktop GUI process on macOS: `ps` gives pid, start time, executable path and argv. */
async function posixDesktopProcesses(root: string, includeBundleHelpers = false): Promise<DesktopProcess[]> {
  const psEnv: NodeJS.ProcessEnv = { ...process.env, LC_ALL: 'C', LANG: 'C' }
  const [started, commands] = await Promise.all([
    execute('ps', ['-axww', '-o', 'pid=,lstart=,comm='], 15_000, psEnv),
    execute('ps', ['-axww', '-o', 'pid=,args='], 15_000, psEnv),
  ])
  if (started.code !== 0 || commands.code !== 0) throw new Error('cannot inspect running DSH Desktop processes')
  const argv = new Map<number, string>()
  for (const line of commands.stdout.split('\n')) {
    const match = /^\s*(\d+)\s(.*)$/.exec(line)
    if (match !== null) argv.set(Number(match[1]), match[2] as string)
  }
  const expected = desktopPaths(root).executable
  const layout = desktopLayout(root)
  const bundleRoot = includeBundleHelpers && !('error' in layout) && layout.name === 'macos-bundle'
    ? root
    : undefined
  const rows: DesktopProcess[] = []
  for (const line of started.stdout.split('\n')) {
    // lstart is always five fields under C locale: "Fri Nov 20 04:10:00 2026".
    const match = /^\s*(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d{4})\s+(.+)$/.exec(line)
    if (match === null) continue
    const path = (match[3] as string).trim()
    if (!isAbsolute(path)) continue
    const matched = isDesktopExecutable(path, expected, bundleRoot)
    if (!matched) continue
    const at = Date.parse(match[2] as string)
    if (!Number.isFinite(at)) throw new Error('cannot identify a running DSH Desktop process')
    rows.push({ pid: Number(match[1]), path, command: argv.get(Number(match[1])) ?? '', started: new Date(at).toISOString() })
  }
  return rows.filter(p => !NODE_MODE.test(p.command))
}
// The Desktop also ships a Node-mode CLI under its executable; it is not a GUI to close.
const NODE_MODE = /(?:^|\s)--expose-internals(?:\s|$)|\.[cm]?js(?:"|\s|$)|(?:^|\s)(?:--eval|--print|--input-type)(?:=|\s|$)|(?:^|\s)-(?:e|p)(?:\s|$)/i
async function desktopProcesses(root: string, includeBundleHelpers = false): Promise<DesktopProcess[]> {
  if (process.platform !== 'win32') return await posixDesktopProcesses(root, includeBundleHelpers)
  const script = "$ProgressPreference='SilentlyContinue'; $ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $rows = @((Get-CimInstance Win32_Process -Filter \"Name='DeepSeek Harness.exe'\" -ErrorAction Stop) | ForEach-Object { @{pid=[int]$_.ProcessId;path=$_.ExecutablePath;command=$_.CommandLine;started=$_.CreationDate.ToUniversalTime().ToString('o')} }); ConvertTo-Json -InputObject $rows -Compress"
  const r = await execute(windowsPowerShellPath(), ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShellScript(script)])
  if (r.code !== 0) throw new Error('cannot inspect running DSH Desktop processes')
  let value: unknown
  try { value = JSON.parse(r.stdout.replace(/^\uFEFF/, '').trim()) } catch { throw new Error('Desktop process inspection returned invalid data') }
  return identifyDesktopProcesses(root, value)
}

class DesktopProcessIdentityUnavailable extends Error {}

/** Validate a CIM snapshot without treating an incomplete process identity as an exited process. */
export function identifyDesktopProcesses(root: string, value: unknown): DesktopProcess[] {
  const rows = Array.isArray(value) ? value : value === null ? [] : [value]
  const expected = desktopPaths(root).executable
  return rows.filter((row): row is DesktopProcess => {
    if (row === null || typeof row !== 'object') throw new Error('Desktop process inspection was incomplete')
    const p = row as Partial<DesktopProcess>
    if (typeof p.path !== 'string' || p.path === '' || typeof p.command !== 'string' || !Number.isSafeInteger(p.pid) || typeof p.started !== 'string') {
      throw new DesktopProcessIdentityUnavailable('cannot identify a running DSH Desktop process')
    }
    if (!isDesktopExecutable(p.path, expected, undefined, 'win32')) return false
    return !NODE_MODE.test(p.command)
  })
}

/** Wait through incomplete shutdown snapshots, but require a complete empty snapshot before writing. */
export async function waitForDesktopExit(deps: {
  readonly inspect: () => Promise<readonly DesktopProcess[]>
  readonly checkCancelled: () => void
  readonly pause?: () => Promise<void>
  readonly now?: () => number
}): Promise<void> {
  const now = deps.now ?? Date.now
  const deadline = now() + 60_000
  let incomplete = false
  while (now() < deadline) {
    deps.checkCancelled()
    try {
      const rows = await deps.inspect()
      deps.checkCancelled()
      if (rows.length === 0) return
      incomplete = false
    } catch (error) {
      if (!(error instanceof DesktopProcessIdentityUnavailable)) throw error
      incomplete = true
    }
    await (deps.pause ?? (() => delay(1_000)))()
  }
  throw new Error(incomplete
    ? 'cannot verify that DSH Desktop exited: process identity remains unavailable; maintenance was cancelled'
    : 'Desktop did not exit; maintenance was cancelled. Any running-task confirmation remains under your control.')
}
async function atomicJson(path: string, value: unknown, exclusive = false): Promise<void> {
  if (exclusive && existsSync(path)) {
    const error: NodeJS.ErrnoException = new Error(`EEXIST: ${path} already exists`)
    error.code = 'EEXIST'
    throw error
  }
  const temp = `${path}.${String(process.pid)}.tmp`
  await writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  try { await renameMaintenanceFile(temp, path) } finally {
    await unlink(temp).catch(error => {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') reportMaintenanceFailure('cannot remove maintenance temporary file', error)
    })
  }
}

export interface MaintenanceProgressOptions {
  readonly jobId: string
  readonly directory: string
  readonly locale?: 'zh' | 'en'
}
export interface MaintenanceProgressNotification {
  readonly started: boolean
  readonly at: string
  readonly pid?: number
  readonly error?: string
  readonly skipped?: boolean
}
export interface MaintenanceProgressDeps {
  readonly launch?: (options: MaintenanceBrokerOptions) => Promise<MaintenanceBrokerResult>
  readonly helperExists?: (path: string) => boolean
  readonly powershellPath?: () => string
}

/** Data-only argv for the independent, read-only progress window. This function starts nothing. */
export function maintenanceProgressLaunchOptions(
  jobId: string,
  directory: string,
  locale: 'zh' | 'en' = 'zh',
  powershellPath = windowsPowerShellPath(),
): MaintenanceBrokerOptions {
  if (typeof jobId !== 'string' || !/^(?:install|uninstall|reinstall)-[A-Za-z0-9]+$/.test(jobId)
    || typeof directory !== 'string' || !isAbsolute(directory) || basename(directory) !== jobId
    || !['zh', 'en'].includes(locale)) throw new Error('invalid maintenance progress request')
  return {
    runtimePath: powershellPath,
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', progressPath,
      '-StatePath', join(directory, 'state.json'), '-JobId', jobId, '-Locale', locale],
    cwd: directory,
    environment: { ELECTRON_RUN_AS_NODE: undefined },
  }
}

/**
 * Attempt the optional window once per job, after commit and before requesting normal Desktop quit.
 * A missing helper, denied broker or diagnostic write cannot change the maintenance outcome.
 */
export async function startMaintenanceProgressNotification(
  options: MaintenanceProgressOptions,
  deps: MaintenanceProgressDeps = {},
): Promise<MaintenanceProgressNotification> {
  let directory: string | undefined
  let result: MaintenanceProgressNotification
  try {
    const request = maintenanceProgressLaunchOptions(options.jobId, options.directory, options.locale ?? 'zh',
      (deps.powershellPath ?? windowsPowerShellPath)())
    directory = options.directory
    try {
      const claim = await open(join(directory, 'progress-notification.claim'), 'wx', 0o600)
      await claim.close()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return { started: false, skipped: true, at: new Date().toISOString() }
      throw error
    }
    if (!(deps.helperExists ?? existsSync)(progressPath)) throw new Error('the packaged maintenance progress window is unavailable')
    const launched = await (deps.launch ?? launchMaintenanceBroker)(request)
    result = { started: true, at: new Date().toISOString(), pid: launched.pid }
  } catch (error) {
    result = { started: false, at: new Date().toISOString(), error: String(error) }
  }
  if (directory !== undefined) {
    await atomicJson(join(directory, 'progress-notification.json'), { ...result, jobId: options.jobId })
      .catch(error => reportMaintenanceFailure('cannot write the progress notification', error))
  }
  return result
}
/** Last durable outcome survives both the settings page and the HTTP host restarting. */
export function readAutomaticMaintenance(home = homePath()): AutomaticMaintenanceJob | undefined {
  try {
    const base = basePath(home)
    const pointer = JSON.parse(readFileSync(join(base, 'latest.json'), 'utf8')) as { id?: unknown; directory?: unknown }
    if (typeof pointer.id !== 'string' || typeof pointer.directory !== 'string' || !inside(base, pointer.directory)
      || basename(pointer.directory) !== pointer.id) return undefined
    const state = JSON.parse(readFileSync(join(pointer.directory, 'state.json'), 'utf8')) as AutomaticMaintenanceJob
    if (state.id !== pointer.id || !['armed', 'closing', 'installing', 'restarting', 'verifying', ...terminal].includes(state.phase)
      || !['install', 'uninstall', 'reinstall'].includes(state.action) || !Number.isFinite(Date.parse(state.at))) return undefined
    return state
  } catch { return undefined }
}
/** A lock left behind by a killed worker never releases itself; clear only clearly stale ones. */
async function clearStaleLock(lockPath: string, home: string): Promise<boolean> {
  try {
    const info = await statAsync(lockPath)
    // Never touch a lock another request may still be preparing (concurrent start window).
    if (Date.now() - info.mtimeMs < 5 * 60_000) return false
    const id = (await readFile(lockPath, 'utf8')).trim()
    if (!/^(?:install|uninstall|reinstall)-[A-Za-z0-9]+$/.test(id)) return false
    const prior = readAutomaticMaintenance(home)
    if (prior === undefined || prior.id !== id) return true
    if (terminal.has(prior.phase)) return true
    const pid = Number(prior.workerPid)
    if (Number.isSafeInteger(pid) && pid > 0) {
      try { process.kill(pid, 0) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return true
      }
    }
    return false
  } catch (error) {
    reportMaintenanceFailure('cannot inspect a stale maintenance lock', error)
    return false
  }
}

async function releaseLock(plan: AutomaticPlan): Promise<void> {
  const lock = join(basePath(plan.home), 'active.lock')
  try { if ((await readFile(lock, 'utf8')).trim() === plan.id) await unlink(lock) } catch { /* no other job's lock is touched */ }
}

/** Validate the staged plan again in the independent process before it can request a quit. */
function validatePlan(value: unknown, path: string, now = Date.now()): AutomaticPlan {
  if (value === null || typeof value !== 'object') throw new Error('invalid automatic maintenance plan')
  const plan = value as Partial<AutomaticPlan>
  const created = typeof plan.createdAt === 'string' ? Date.parse(plan.createdAt) : NaN
  if (plan.version !== 1 || plan.action !== 'reinstall'
    || typeof plan.dependency !== 'string' || plan.dependency.trim() === ''
    || typeof plan.id !== 'string' || !/^reinstall-[A-Za-z0-9]+$/.test(plan.id)
    || ![plan.root, plan.home, plan.nodePath, plan.directory].every(p => typeof p === 'string' && isAbsolute(p))
    || typeof plan.electronNode !== 'boolean' || !Number.isFinite(created) || created > now || now - created > 30_000
    || (plan.locale !== undefined && !['zh', 'en'].includes(plan.locale))) {
    throw new Error('invalid or expired automatic maintenance plan')
  }
  const checked = plan as AutomaticPlan
  if (!inside(basePath(checked.home), checked.directory) || dirname(checked.directory) !== basePath(checked.home)
    || basename(checked.directory) !== checked.id || checked.id.split('-')[0] !== checked.action
    || resolve(path) !== join(checked.directory, 'automatic.json') || !readDesktopIdentity(checked.root).ok) {
    throw new Error('invalid automatic maintenance plan paths or target')
  }
  const target = checked.target
  if (target === null || typeof target !== 'object' || !Number.isSafeInteger(target.pid) || target.pid <= 0
    || typeof target.path !== 'string' || !samePath(target.path, desktopPaths(checked.root).executable)
    || typeof target.command !== 'string' || /(?:^|\s)--type(?:=|\s)/i.test(target.command)
    || typeof target.started !== 'string' || !Number.isFinite(Date.parse(target.started)) || Date.parse(target.started) > now) {
    throw new Error('invalid automatic maintenance target process')
  }
  return checked
}

/** Commit only the armed job after its accepted HTTP response has finished writing. */
export async function commitAutomaticMaintenance(jobId: string, home = homePath()): Promise<void> {
  if (typeof jobId !== 'string' || !/^reinstall-[A-Za-z0-9]+$/.test(jobId)) throw new Error('invalid bridge maintenance job id')
  const state = readAutomaticMaintenance(home)
  if (state?.id !== jobId || state.phase !== 'armed' || !Number.isSafeInteger(state.workerPid) || Number(state.workerPid) <= 0) {
    throw new Error('the bridge maintenance job is no longer armed')
  }
  const directory = join(basePath(home), jobId)
  const planPath = join(directory, 'automatic.json')
  const plan = validatePlan(JSON.parse(await readFile(planPath, 'utf8')), planPath)
  if (plan.home !== resolve(home) || plan.action !== state.action || existsSync(join(directory, 'cancel.json'))) {
    throw new Error('the bridge maintenance job cannot be committed')
  }
  try {
    await atomicJson(join(directory, 'commit.json'), { id: jobId, workerPid: state.workerPid, at: new Date().toISOString() }, true)
  } catch (error) {
    // The worker is polling this file; cancel it at once instead of leaving a successful-looking
    // 202 to turn into a generic "not committed" twenty seconds later. An EEXIST is a duplicate
    // commit of an already-approved job, not a failure: cancelling it would abort good work.
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      await atomicJson(join(directory, 'cancel.json'), { at: new Date().toISOString(), reason: String(error) }).catch(() => {})
    }
    throw error
  }
}

/** Only the new, authenticated explicit-click endpoint calls this function. */
export async function startAutomaticMaintenance(action: 'reinstall', root: string, options: AutomaticMaintenanceOptions = {}): Promise<AutomaticMaintenanceJob> {
  requireLiveDesktop()
  if (action !== 'reinstall') throw new Error('invalid bridge maintenance action')
  if (options.locale !== undefined && !['zh', 'en'].includes(options.locale)) throw new Error('invalid bridge maintenance locale')
  const dependency = await preflightReinstall(root, homePath())
  if (!readDesktopIdentity(root).ok) throw new Error('the maintenance target is not a verified DSH Desktop installation')
  if (process.platform === 'win32' && !existsSync(quitPath)) throw new Error('the packaged Desktop quit helper is missing')
  const processes = await desktopProcesses(root)
  const mains = processes.filter(p => !/(?:^|\s)--type(?:=|\s)/i.test(p.command))
  if (mains.length !== 1) throw new Error('automatic maintenance requires one running DSH Desktop window')
  const home = homePath()
  const base = basePath(home)
  await mkdir(base, { recursive: true, mode: 0o700 })
  const lockPath = join(base, 'active.lock')
  let lock
  try { lock = await open(lockPath, 'wx', 0o600) }
  catch {
    if (!(await clearStaleLock(lockPath, home))) throw new Error('bridge maintenance is already in progress')
    await unlink(lockPath).catch(error => reportMaintenanceFailure('cannot remove a stale maintenance lock', error))
    lock = await open(lockPath, 'wx', 0o600)
  }
  let plan: AutomaticPlan | undefined
  try {
    const prepared = await prepareBridgeMaintenance('install', root, { directory: base })
    const original = JSON.parse(await readFile(prepared.planPath, 'utf8')) as { nodePath: string; electronNode: boolean }
    const id = basename(prepared.directory).replace(/^install-/, 'reinstall-')
    const directory = join(base, id)
    await renameMaintenanceFile(prepared.directory, directory)
    const stagedWorker = await stageReinstallRuntime(directory)
    await lock.writeFile(id + '\n')
    await lock.close()
    plan = { version: 1, id, action, dependency, nestedResidue: await inspectProfileResidue(home), root: resolve(root), nodePath: original.nodePath, electronNode: original.electronNode,
      home, directory, target: mains[0] as DesktopProcess, createdAt: new Date().toISOString(),
      ...options.locale === undefined ? {} : { locale: options.locale } }
    const path = join(directory, 'automatic.json')
    await writeFile(path, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    await atomicJson(join(base, 'latest.json'), { id, directory })
    const launched = await launchMaintenanceBroker({ runtimePath: plan.nodePath,
      args: [...plan.electronNode ? ['--expose-internals'] : [], stagedWorker, '--automatic-maintenance', path], cwd: directory,
      environment: { DSH_HOME: home, ELECTRON_RUN_AS_NODE: plan.electronNode ? '1' : undefined, ELECTRON_NO_ASAR: '1' } })
    // WMI's return code proves creation only. The worker must actually load and publish its arm.
    const deadline = Date.now() + 12_000
    while (Date.now() < deadline) {
      const state = readAutomaticMaintenance(home)
      if (state?.id === id && state.workerPid === launched.pid) {
        if (state.phase !== 'armed') throw new Error(state.error ?? 'the maintenance worker did not arm')
        return state
      }
      await delay(100)
    }
    throw new Error('the independent maintenance worker did not become ready')
  } catch (error) {
    await lock.close().catch(error => reportMaintenanceFailure('cannot close the maintenance lock', error))
    if (plan !== undefined) {
      await atomicJson(join(plan.directory, 'cancel.json'), { at: new Date().toISOString() })
        .catch(error => reportMaintenanceFailure('cannot stage the maintenance cancellation', error))
      await atomicJson(join(plan.directory, 'state.json'), { id: plan.id, action, phase: 'failed', ok: false, restarted: false,
        at: new Date().toISOString(), startedAt: plan.createdAt, error: String(error) })
        .catch(writeError => reportMaintenanceFailure('cannot record the failed maintenance state', writeError))
      await releaseLock(plan)
    } else { await unlink(lockPath).catch(error => reportMaintenanceFailure('cannot remove the unused maintenance lock', error)) }
    throw error
  }
}

/**
 * Ask the verified macOS Desktop to quit through its own Quit command (Apple event), exactly as
 * Cmd-Q does: any running-task confirmation stays with the user. The pid and start time are
 * re-read first, so a reused pid or a second copy of the app is never asked.
 */
async function requestPosixQuit(plan: AutomaticPlan): Promise<void> {
  const current = (await desktopProcesses(plan.root)).filter(p => !/(?:^|\s)--type(?:=|\s)/i.test(p.command))
  if (current.length !== 1 || current[0]?.pid !== plan.target.pid || current[0].started !== plan.target.started) {
    throw new Error('the running Desktop is not the one maintenance was requested from; no quit was sent')
  }
  const result = await execute('osascript', ['-e', 'on run argv', '-e', 'tell application (item 1 of argv) to quit', '-e', 'end run', plan.root], 25_000)
  if (result.code !== 0) throw new Error(result.output || 'the Desktop Quit command was not accepted')
}

async function runWorker(path: string): Promise<void> {
  requireLiveDesktop()
  const plan = validatePlan(JSON.parse(await readFile(path, 'utf8')), path)
  let extension: InstalledExtension | undefined
  const checkCancelled = (): void => {
    if (existsSync(join(plan.directory, 'cancel.json'))) throw new Error('bridge maintenance was cancelled before Desktop exited')
  }
  process.env.DSH_HOME = plan.home
  const publish = async (state: MaintenanceState): Promise<void> => {
    // If the host gave up on this job (readiness timeout), its terminal state wins. Without this
    // a late worker flips "failed" back to "armed" and the settings page oscillates.
    const prior = readAutomaticMaintenance(plan.home)
    if (prior?.id === plan.id && terminal.has(prior.phase)) return
    await atomicJson(join(plan.directory, 'state.json'), { ...state, id: plan.id, workerPid: process.pid, startedAt: plan.createdAt })
  }
  try {
    checkCancelled()
    await runMaintenanceLifecycle(plan.action, {
      publish,
      requestQuit: async () => {
        // Arming proves the worker is independent and loaded. It grants no permission to quit
        // until the original request's response has finished and its host commits this exact job.
        const deadline = Date.now() + 20_000
        let committed = false
        while (Date.now() < deadline) {
          checkCancelled()
          try {
            const record = JSON.parse(await readFile(join(plan.directory, 'commit.json'), 'utf8')) as { id?: unknown; workerPid?: unknown; at?: unknown }
            if (record.id !== plan.id || record.workerPid !== process.pid || typeof record.at !== 'string' || !Number.isFinite(Date.parse(record.at))) {
              throw new Error('invalid bridge maintenance commit')
            }
            committed = true
            break
          } catch (error) {
            // An empty or half-written commit.json is a transient state, not a cancellation.
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
          }
          await delay(100)
        }
        if (!committed) throw new Error('the maintenance request was not committed; Desktop remains open')
        checkCancelled()
        await publish({ phase: 'closing', action: plan.action, at: new Date().toISOString() })
        if (process.platform !== 'win32') {
          await requestPosixQuit(plan)
          return
        }
        await startMaintenanceProgressNotification({ jobId: plan.id, directory: plan.directory, locale: plan.locale ?? 'zh' })
        const result = await execute(windowsPowerShellPath(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', quitPath,
          '-TargetPid', String(plan.target.pid), '-ExpectedExecutable', plan.target.path,
          '-ExpectedStartTimeUtc', plan.target.started, '-TimeoutSeconds', '20'], 25_000)
        checkCancelled()
        if (result.code !== 0) throw new Error(result.output || 'the official Desktop Quit menu was not available')
      },
      waitUntilClosed: async () => {
        await waitForDesktopExit({ inspect: async () => await desktopProcesses(plan.root, true), checkCancelled })
      },
      maintain: async () => {
        checkCancelled()
        if ((await desktopProcesses(plan.root, true)).length > 0) throw new Error('DSH Desktop was reopened during maintenance; refusing to modify its files')
        if (await preflightReinstall(plan.root, plan.home) !== plan.dependency) throw new Error('REINSTALL_DEPENDENCY_CHANGED')
        const bridge = async (action: 'install' | 'uninstall'): Promise<BridgeActionResult> => await runBridgeAction(action, plan.root, {
          node: () => plan.nodePath, installer: defaultInstallerPath, trackResult: true,
          run: async (cmd, args, extra) => await execute(cmd, [...plan.electronNode ? ['--expose-internals'] : [], ...args], 180_000,
            { ...process.env, ...extra, ELECTRON_RUN_AS_NODE: plan.electronNode ? '1' : undefined, ELECTRON_NO_ASAR: '1' }),
        })
        const profile = async (action: 'install' | 'uninstall'): Promise<BridgeActionResult> => await repairProfileExtension(action, plan.root, plan.home,
          runProfileCommand, plan.dependency)
        return await withProfileCheckpoint(plan.home, plan.directory, async () => {
          const residue = await cleanProfileResidue(plan.home)
          const result = await runReinstallTransaction({
            remove: () => profile('uninstall'),
            absent: async () => {
              const manifest = JSON.parse(await readFile(join(plan.home, 'profiles', 'desktop', 'package.json'), 'utf8')) as { dependencies?: Record<string, unknown> }
              return manifest.dependencies?.[MAIN_EXTENSION_NAME] === undefined && !existsSync(join(plan.home, 'profiles', 'desktop', 'node_modules', MAIN_EXTENSION_NAME))
            },
            revert: () => bridge('uninstall'),
            hostAbsent: () => inspectReinstallHost(plan.root).status === 'absent',
            apply: () => bridge('install'), add: () => profile('install'),
          })
          extension = await installedProfileExtension(plan.home)
          return { ...result, output: [residue, result.output].filter(Boolean).join('\n') }
        }, { reconcile: () => reconcileProfile(plan.root, plan.home) })
      },
      restart: async () => {
        if ((await desktopProcesses(plan.root, true)).length > 0) throw new Error('DSH Desktop is already running; not opening a second instance')
        const identity = readDesktopIdentity(plan.root)
        if (!identity.ok) throw new Error(`Desktop cannot be safely reopened: ${identity.reason}`)
        const environment: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: plan.home }
        for (const key of Object.keys(environment)) {
          const upper = key.toUpperCase()
          if (upper === 'ELECTRON_RUN_AS_NODE' || upper === 'ELECTRON_NO_ASAR' || upper.startsWith('DSH_BRIDGE_')) {
            delete environment[key]
          }
        }
        return await new Promise<number>((resolve, reject) => {
          const child = spawn(desktopPaths(plan.root).executable, [], { cwd: plan.root, env: environment, stdio: 'ignore', windowsHide: true, detached: true })
          child.once('error', reject)
          child.once('spawn', () => { child.unref(); resolve(child.pid as number) })
        })
      },
      verify: async (pid, action) => {
        if (action === 'reinstall') {
          if (inspectReinstallHost(plan.root).status !== 'applied') throw new Error('REINSTALL_HOST_VERIFY_FAILED')
          await waitForRestartedBridge(pid, { timeoutMs: 45_000, endpointPath: join(plan.home, 'dsh-builtin-browser-bridge.json'),
            ...(extension === undefined ? {} : { extension, home: plan.home }) })
          return
        }
        await delay(1_500)
        if (!(await desktopProcesses(plan.root)).some(p => p.pid === pid)) throw new Error('the reopened Desktop did not remain running')
      },
    })
  } catch (error) {
    await publish({ phase: 'cancelled', action: plan.action, at: new Date().toISOString(), ok: false, restarted: false, error: String(error) })
      .catch(writeError => reportMaintenanceFailure('cannot publish the cancelled maintenance state', writeError))
  } finally { await releaseLock(plan) }
}

// Importing this module only exposes functions. Execution requires the private staged plan.
if (process.argv[2] === '--automatic-maintenance' && process.argv[1] !== undefined && resolve(process.argv[1]) === workerPath) {
  void runWorker(resolve(process.argv[3] ?? '')).catch(error => { console.error(String(error)); process.exitCode = 1 })
}
