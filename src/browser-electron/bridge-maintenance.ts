/**
 * Prepare Windows bridge maintenance for the user to run after exiting DSH Desktop.
 * Preparation writes a private launcher and plan; it never starts a process or changes Desktop.
 * The current packaged installer performs identity and running-process checks at execution time.
 * @module dsh-browser/browser-electron/bridge-maintenance
 */
import { existsSync, realpathSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readDesktopIdentity } from './desktop-identity.js'
import type { BridgeAction } from './bridge-install.js'

export interface BridgeMaintenanceOptions {
  /** Parent of a new, unique maintenance directory; defaults to the user's DSH home. */
  readonly directory?: string
  /** Explicit Node executable; a verified Desktop executable may be used in Electron Node mode. */
  readonly nodePath?: string
}

export interface PreparedBridgeMaintenance {
  readonly ok: true
  readonly prepared: true
  readonly action: BridgeAction
  readonly path: string
  /** Literal-path invocation for the user's PowerShell terminal. */
  readonly command: string
  readonly commandShell: 'powershell'
  readonly directory: string
  readonly runnerPath: string
  readonly planPath: string
}

interface MaintenancePlan {
  readonly version: 1
  readonly action: BridgeAction
  readonly installRoot: string
  readonly installerPath: string
  readonly nodePath: string
  readonly electronNode: boolean
  readonly dshHome: string
}

/** Batch literals cannot contain these characters; other path content stays in JSON arguments. */
function checkedPath(value: string, label: string): string {
  if (!isAbsolute(value) || /[\0\r\n"]/.test(value)) throw new Error(`${label} must be an absolute path without quotes or control characters`)
  return resolve(value)
}

/** Escape only a batch literal. Delayed expansion is disabled before a literal is read. */
function batchLiteral(value: string): string {
  return value.replace(/%/g, '%%')
}

function withinOrEqual(root: string, path: string): boolean {
  const part = relative(root, path)
  return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith('..\\') && !part.startsWith('../'))
}

/** Resolve existing ancestors before mkdir so a redirected output cannot create files in Desktop. */
function prospectiveRealPath(path: string): string {
  let ancestor = path
  const missing: string[] = []
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor)
    if (parent === ancestor) throw new Error('maintenance directory has no existing ancestor')
    missing.unshift(basename(ancestor))
    ancestor = parent
  }
  return resolve(realpathSync(ancestor), ...missing)
}

/** This runner is deliberately data-driven: paths and actions are never evaluated as shell text. */
const RUNNER = `import { readFileSync, existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
const plan = JSON.parse(readFileSync(new URL('./maintenance.json', import.meta.url), 'utf8'));
if (plan.version !== 1 || !['install', 'uninstall'].includes(plan.action)
  || ![plan.installRoot, plan.installerPath, plan.nodePath, plan.dshHome].every(value => typeof value === 'string' && isAbsolute(value))
  || typeof plan.electronNode !== 'boolean') throw new Error('Invalid bridge maintenance plan');
if (!existsSync(plan.installerPath)) throw new Error('The browser plugin installer is missing. Install or update the plugin and prepare maintenance again.');
const environment = { ...process.env };
for (const key of Object.keys(environment)) {
  if (['DSH_BRIDGE_DETACHED', 'DSH_BRIDGE_HANDOFF_PARENT', 'DSH_BRIDGE_ACTION_RESULT_FILE', 'DSH_BRIDGE_ACTION_LOG_FILE', 'ELECTRON_RUN_AS_NODE'].includes(key.toUpperCase())) delete environment[key];
}
if (plan.electronNode) environment.ELECTRON_RUN_AS_NODE = '1';
// Test boundaries and their private home must survive this launcher unchanged.
if (environment.DSH_BROWSER_TEST !== '1' && environment.NODE_TEST_CONTEXT === undefined) environment.DSH_HOME = plan.dshHome;
const args = [...(plan.electronNode ? ['--expose-internals'] : []), plan.installerPath, plan.installRoot, ...(plan.action === 'uninstall' ? ['--revert'] : [])];
const result = spawnSync(plan.nodePath, args, { shell: false, windowsHide: true, stdio: 'inherit', env: environment });
if (result.error) { console.error('Bridge maintenance could not start: ' + result.error.message); process.exitCode = 1; }
else process.exitCode = result.status ?? 1;
`

/**
 * Prepare an offline Windows launcher. The target may still be running during preparation.
 * User execution remains subject to the installer's closed-Desktop and ancestry guards.
 */
export async function prepareBridgeMaintenance(
  action: BridgeAction,
  installRoot: string,
  options: BridgeMaintenanceOptions = {},
): Promise<PreparedBridgeMaintenance> {
  if (action !== 'install' && action !== 'uninstall') throw new Error('bridge maintenance action must be install or uninstall')
  const requestedRoot = checkedPath(installRoot, 'Desktop installation')
  const identity = readDesktopIdentity(requestedRoot)
  if (!identity.ok) throw new Error(`cannot prepare bridge maintenance: ${identity.reason}`)
  const target = realpathSync(requestedRoot)
  const installerPath = fileURLToPath(new URL('../../desktop-bridge/install.mjs', import.meta.url))
  if (!existsSync(installerPath)) throw new Error('the packaged bridge installer is missing')

  const currentIsNode = /^(?:node|node\.exe)$/i.test(basename(process.execPath))
  const selected = options.nodePath ?? (currentIsNode ? process.execPath : join(target, 'DeepSeek Harness.exe'))
  const nodePath = checkedPath(selected, 'Maintenance runtime')
  if (!existsSync(nodePath) || !statSync(nodePath).isFile()) throw new Error('the maintenance runtime does not exist')
  const electronNode = !/^(?:node|node\.exe)$/i.test(basename(nodePath))
  const desktopRuntime = join(target, 'DeepSeek Harness.exe')
  if (electronNode && (!existsSync(desktopRuntime) || realpathSync(nodePath).toLowerCase() !== realpathSync(desktopRuntime).toLowerCase())) {
    throw new Error('the Electron maintenance runtime must belong to the verified Desktop installation')
  }

  const dshHome = checkedPath(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'DSH home')
  const testContext = process.env.DSH_BROWSER_TEST === '1' || process.env.NODE_TEST_CONTEXT !== undefined
  if (testContext && options.directory === undefined && process.env.DSH_BRIDGE_TEST_ROOT === undefined) {
    throw new Error('test preparation requires an explicit private maintenance directory')
  }
  const directory = checkedPath(options.directory ?? join(dshHome, 'dsh-builtin-browser-host', 'maintenance'), 'Maintenance directory')
  if (withinOrEqual(target, directory) || withinOrEqual(target, prospectiveRealPath(directory))) {
    throw new Error('maintenance launchers must be stored outside the Desktop installation')
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (withinOrEqual(target, realpathSync(directory))) throw new Error('maintenance directory resolves inside the Desktop installation')
  const output = await mkdtemp(join(directory, `${action}-`))
  const runnerPath = join(output, 'run-maintenance.mjs')
  const planPath = join(output, 'maintenance.json')
  const path = join(output, action === 'uninstall' ? 'uninstall-bridge.cmd' : 'install-bridge.cmd')
  const plan: MaintenancePlan = { version: 1, action, installRoot: target, installerPath, nodePath, electronNode, dshHome }
  const command = [
    '@echo off',
    'setlocal DisableDelayedExpansion',
    'chcp 65001 >nul',
    'echo Exit DSH Desktop normally before running bridge maintenance.',
    `set "ELECTRON_RUN_AS_NODE=${electronNode ? '1' : ''}"`,
    `"${batchLiteral(nodePath)}"${electronNode ? ' --expose-internals' : ''} "%~dp0run-maintenance.mjs"`,
    'set "DSH_BRIDGE_MAINTENANCE_EXIT=%ERRORLEVEL%"',
    'if not "%DSH_BRIDGE_MAINTENANCE_EXIT%"=="0" goto failed',
    'echo Bridge maintenance completed. You can now open DSH Desktop.',
    'goto finished',
    ':failed',
    'echo Bridge maintenance failed. Read the reason above, then prepare maintenance again if needed.',
    ':finished',
    'if not "%DSH_BRIDGE_MAINTENANCE_NO_PAUSE%"=="1" pause',
    'exit /b %DSH_BRIDGE_MAINTENANCE_EXIT%',
    '',
  ].join('\r\n')
  await writeFile(planPath, JSON.stringify(plan, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  await writeFile(runnerPath, RUNNER, { flag: 'wx', mode: 0o600 })
  await writeFile(path, command, { flag: 'wx', mode: 0o600 })
  return { ok: true, prepared: true, action, path, command: `& '${path.replace(/'/g, "''")}'`, commandShell: 'powershell', directory: output, runnerPath, planPath }
}
