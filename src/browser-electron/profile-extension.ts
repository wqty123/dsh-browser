/** Profile-only extension maintenance through the installation's supported dsh plugin command. */
import { createHash } from 'node:crypto'
import { readFile, access } from 'node:fs/promises'
import { join, resolve, isAbsolute } from 'node:path'
import type { BridgeAction, BridgeActionResult } from './bridge-install.ts'
import { BridgeConnection } from './bridge-connection.ts'

export const MAIN_EXTENSION_UNSUPPORTED = 'DESKTOP_MAIN_EXTENSION_UNSUPPORTED'
export const MAIN_EXTENSION_NAME = 'dsh-builtin-browser'
export interface MainExtensionStatus {
  readonly state: 'not-installed' | 'pending-restart' | 'loaded' | 'failed'
  readonly version?: string
  readonly loadedAt?: string
  readonly code?: string
}
export interface InstalledExtension { readonly version: string; readonly build: string }

export async function readHostExtensionStatus(home: string): Promise<MainExtensionStatus | undefined> {
  let connection: BridgeConnection | undefined
  try {
    const endpoint = JSON.parse(await readFile(join(home, 'dsh-builtin-browser-bridge.json'), 'utf8')) as { port: number; token: string; pid: number }
    if (!Number.isSafeInteger(endpoint.pid) || endpoint.pid <= 0 || !Number.isInteger(endpoint.port) || endpoint.port <= 0 || endpoint.port > 65535
      || typeof endpoint.token !== 'string' || endpoint.token === '') return undefined
    process.kill(endpoint.pid, 0)
    connection = new BridgeConnection(endpoint)
    const answer = await connection.call({ op: 'version' }, 1_000)
    const status = answer.mainExtension as MainExtensionStatus | undefined
    if (answer.ok !== true || answer.homeId !== extensionHomeId(home) || status === null || typeof status !== 'object'
      || !['not-installed', 'pending-restart', 'loaded', 'failed'].includes(status.state)) return undefined
    return { state: status.state, ...typeof status.version === 'string' ? { version: status.version } : {},
      ...typeof status.loadedAt === 'string' ? { loadedAt: status.loadedAt } : {}, ...typeof status.code === 'string' ? { code: status.code } : {} }
  } catch { return undefined } finally { connection?.close() }
}

export function extensionHomeId(home: string): string {
  const path = resolve(home)
  return createHash('sha256').update(process.platform === 'win32' ? path.toLowerCase() : path).digest('hex')
}

export async function installedProfileExtension(home: string): Promise<InstalledExtension> {
  const directory = join(home, 'profiles', 'desktop', 'node_modules', MAIN_EXTENSION_NAME)
  const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown; dsh?: { desktop?: { main?: unknown } } }
  if (pkg.name !== MAIN_EXTENSION_NAME || typeof pkg.version !== 'string' || pkg.dsh?.desktop?.main !== './desktop-bridge/main.mjs') {
    throw new Error('EXTENSION_ENTRY_INVALID')
  }
  const build = createHash('sha256').update(await readFile(join(directory, 'desktop-bridge/plugin-browser-bridge.js'))).digest('hex')
  return { version: pkg.version, build }
}

export async function profileDependencySpec(home: string): Promise<string> {
  const manifest = JSON.parse(await readFile(join(home, 'profiles', 'desktop', 'package.json'), 'utf8')) as { dependencies?: Record<string, unknown> }
  const dependency = manifest.dependencies?.[MAIN_EXTENSION_NAME]
  if (typeof dependency !== 'string' || dependency.trim() === '') throw Object.assign(new Error('The Desktop profile has no dsh-builtin-browser dependency to reinstall.'), { code: 'REINSTALL_DEPENDENCY_MISSING' })
  return dependency
}

export async function profileExtensionCommand(action: BridgeAction, root: string, home: string, capturedSpec?: string): Promise<readonly string[]> {
  if (!isAbsolute(root) || !isAbsolute(home)) throw new Error('invalid Desktop profile location')
  const profile = join(home, 'profiles', 'desktop')
  const dependency = action === 'install' ? capturedSpec ?? await profileDependencySpec(home) : undefined
  if (action === 'install' && (typeof dependency !== 'string' || dependency.trim() === '')) throw new Error('REINSTALL_DEPENDENCY_MISSING')
  const resources = join(root, 'resources')
  let cli = join(resources, 'app.asar', 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js')
  try { await access(cli) } catch { cli = join(resources, 'app', 'dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'); await access(cli) }
  const args = [cli, 'plugin', '--profile', 'desktop']
  if (action === 'uninstall') return [...args, 'remove', MAIN_EXTENSION_NAME]
  let spec = String(dependency)
  if (/^(?:file|link):/.test(spec)) {
    const colon = spec.indexOf(':')
    spec = spec.slice(0, colon + 1) + resolve(profile, spec.slice(colon + 1))
  }
  return [...args, 'add', `${MAIN_EXTENSION_NAME}@${spec}`]
}

export async function repairProfileExtension(action: BridgeAction, root: string, home: string, run: (
  command: string, argv: readonly string[], environment: NodeJS.ProcessEnv,
) => Promise<{ code: number; output: string }>, capturedSpec?: string): Promise<BridgeActionResult> {
  const argv = ['--expose-internals', ...await profileExtensionCommand(action, root, home, capturedSpec)]
  const command = join(root, 'DeepSeek Harness.exe')
  const environment = { ...process.env, DSH_HOME: home, ELECTRON_RUN_AS_NODE: '1' }
  const result = await run(command, argv, environment)
  return { ok: result.code === 0, code: result.code, output: result.output.slice(-20_000), command: [command, ...argv].map(value => JSON.stringify(value)).join(' '), restarted: false }
}
