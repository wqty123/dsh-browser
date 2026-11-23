/**
 * DSH Tauri (dsh-tauri/deepseek-harness-desktop) as a sidebar host.
 *
 * DSH Tauri does not run DeepSeek Harness Desktop's `lib/main.js`: its Electron main process is
 * electron-rs, staged in `runtime/<platform>-<arch>` beside an `electron-rs.json` whose identifier
 * names the app. Its sidebar guests get an in-memory partition, so the sidebar host patch
 * (`dsh-host-patch/tauri.json`) targets `runtime/browser.cjs` there. The plugin's own Node process
 * is that same Electron binary in Node mode, so a running Tauri is recognised from `process.execPath`.
 * @module dsh-browser/browser-electron/tauri-host
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dshHome } from './paths.ts'
import { registeredInstallLocations } from '../../desktop-bridge/desktop-discovery.mjs'

const { hostPatchStatus }: { hostPatchStatus: (directory: string) => TauriHostPatch } = await import(new URL('../../dsh-host-patch/apply.mjs', import.meta.url).href)

interface TauriRule {
  readonly identifiers: readonly string[]
  readonly metadata: string
  readonly runtimeRoots: readonly string[]
  readonly installNames: readonly string[]
  readonly registryName: string
}

/** One DSH Tauri electron-rs runtime directory. */
export interface TauriRuntime {
  /** The install root, when the runtime sits at one of the rule's runtime roots. */
  readonly root?: string
  /** `runtime/<platform>-<arch>`: the directory the host patch is applied to. */
  readonly runtime: string
  readonly identifier: string
  readonly appName?: string
  readonly running: boolean
}

/** Host patch state of a Tauri runtime, as `dsh-host-patch/apply.mjs` reports it. */
export interface TauriHostPatch {
  readonly status: string
  readonly reason?: string
}

/**
 * Read the Tauri part of the shared identity rule.
 * @returns the rule, or undefined when it cannot be read.
 */
export function readTauriRule(): TauriRule | undefined {
  try {
    const rule = (JSON.parse(readFileSync(new URL('../../desktop-bridge/desktop-identity.json', import.meta.url), 'utf8')) as { tauri?: TauriRule }).tauri
    const strings = (value: unknown): value is readonly string[] => Array.isArray(value) && value.length > 0 && value.every(item => typeof item === 'string' && item !== '')
    if (rule === undefined || !strings(rule.identifiers) || !strings(rule.runtimeRoots) || !strings(rule.installNames)
      || typeof rule.metadata !== 'string' || typeof rule.registryName !== 'string') return undefined
    return rule
  } catch {
    return undefined
  }
}

function metadataOf(directory: string, rule: TauriRule): { identifier: string; appName?: string; target?: string; arch?: string } | undefined {
  try {
    const value = JSON.parse(readFileSync(join(directory, rule.metadata), 'utf8')) as Record<string, unknown>
    if (typeof value.identifier !== 'string' || !rule.identifiers.includes(value.identifier)) return undefined
    return {
      identifier: value.identifier,
      ...typeof value.appName === 'string' ? { appName: value.appName } : {},
      ...typeof value.target === 'string' ? { target: value.target } : {},
      ...typeof value.arch === 'string' ? { arch: value.arch } : {},
    }
  } catch {
    return undefined
  }
}

function rootOf(runtime: string, rule: TauriRule): string | undefined {
  for (const base of [...rule.runtimeRoots].sort((a, b) => b.split('/').length - a.split('/').length)) {
    const parts = base.split('/')
    let directory = dirname(runtime)
    let matches = true
    for (const part of [...parts].reverse()) {
      if (basename(directory) !== part) { matches = false; break }
      directory = dirname(directory)
    }
    if (matches) return directory
  }
  return undefined
}

/**
 * The Tauri runtime this process runs from, when the plugin is hosted by DSH Tauri. On macOS the
 * Electron binary sits in `<runtime>/<name>.app/Contents/MacOS/`, beside which electron-rs keeps
 * `electron-rs.json` and `runtime/`, so the directory holding the `.app` is the runtime.
 * @param execPath - the running executable.
 * @returns the runtime, or undefined outside DSH Tauri.
 */
export function runningTauriRuntime(execPath: string = process.execPath): TauriRuntime | undefined {
  const rule = readTauriRule()
  if (rule === undefined) return undefined
  const binary = dirname(execPath)
  const bundle = basename(binary) === 'MacOS' && basename(dirname(binary)) === 'Contents' && dirname(dirname(binary)).endsWith('.app')
    ? dirname(dirname(dirname(binary))) : undefined
  const runtime = [binary, bundle].find(directory => directory !== undefined && metadataOf(directory, rule) !== undefined)
  if (runtime === undefined) return undefined
  const metadata = metadataOf(runtime, rule)!
  const root = rootOf(runtime, rule)
  return { ...root === undefined ? {} : { root }, runtime, identifier: metadata.identifier, ...metadata.appName === undefined ? {} : { appName: metadata.appName }, running: true }
}

/**
 * The runtime of a DSH Tauri install root that matches this machine.
 * @param root - a candidate install directory.
 * @param platform - the platform the runtime must target.
 * @param arch - the architecture the runtime must target.
 * @returns the runtime, or undefined when the directory is not DSH Tauri.
 */
export function tauriRuntimeOf(root: string, platform: string = process.platform, arch: string = process.arch): TauriRuntime | undefined {
  const rule = readTauriRule()
  if (rule === undefined) return undefined
  for (const base of rule.runtimeRoots) {
    const directory = join(root, ...base.split('/'))
    let entries: string[] = []
    try { entries = readdirSync(directory, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name) } catch { continue }
    for (const name of entries) {
      const runtime = join(directory, name)
      const metadata = metadataOf(runtime, rule)
      if (metadata === undefined) continue
      if ((metadata.target !== undefined && metadata.target !== platform) || (metadata.arch !== undefined && metadata.arch !== arch)) continue
      return { root, runtime, identifier: metadata.identifier, ...metadata.appName === undefined ? {} : { appName: metadata.appName }, running: false }
    }
  }
  return undefined
}

/**
 * Find DSH Tauri: the running host first, then the usual install locations.
 * @param options - discovery overrides for tests.
 * @returns the runtime, or undefined when no DSH Tauri is found.
 */
export function findTauriRuntime(options: {
  readonly execPath?: string
  readonly localAppData?: string
  readonly registry?: () => readonly string[]
} = {}): TauriRuntime | undefined {
  const running = runningTauriRuntime(options.execPath)
  if (running !== undefined) return running
  const rule = readTauriRule()
  if (rule === undefined) return undefined
  const bases = options.localAppData !== undefined ? [options.localAppData]
    : [process.env.LOCALAPPDATA, join(process.env.LOCALAPPDATA ?? '', 'Programs'), process.env.ProgramFiles, process.env['ProgramFiles(x86)']]
      .filter((base): base is string => typeof base === 'string' && base !== '' && base !== 'Programs')
  const candidates = [
    ...[process.env.DSH_DESKTOP_PATH, process.env.DSH_DESKTOP_APP].filter((path): path is string => typeof path === 'string' && path !== ''),
    ...bases.flatMap(base => rule.installNames.map(name => join(base, name))),
  ]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    const found = tauriRuntimeOf(candidate)
    if (found !== undefined) return found
  }
  let registered: readonly string[] = []
  try { registered = (options.registry ?? (() => registeredInstallLocations(process.platform, undefined, rule.registryName)))() } catch {}
  for (const candidate of registered) {
    const found = tauriRuntimeOf(candidate)
    if (found !== undefined) return found
  }
  return undefined
}

/**
 * Read the sidebar host patch state of a Tauri runtime without writing.
 * @param runtime - the runtime directory.
 * @returns the patch status.
 */
export function tauriHostPatchStatus(runtime: string): TauriHostPatch {
  try { return hostPatchStatus(runtime) } catch (error) { return { status: 'anchors mismatch', reason: String(error) } }
}

/**
 * Name this plugin's package to the Tauri host patch, which starts its `dsh.desktop.main` (the sidebar
 * bridge) inside electron-rs: Tauri has no Desktop main-extension loader to find it in the profile.
 * @param home - the DSH home the host patch reads.
 * @param root - this plugin's package directory.
 * @returns the pointer file path.
 */
export function publishTauriDesktopMain(home: string = dshHome(), root: string = fileURLToPath(new URL('../../', import.meta.url))): string {
  const file = join(home, 'dsh-builtin-browser-desktop-main.json')
  const text = JSON.stringify({ root }) + '\n'
  try { if (readFileSync(file, 'utf8') === text) return file } catch { /* absent */ }
  const temporary = `${file}.${process.pid}.tmp`
  mkdirSync(home, { recursive: true })
  writeFileSync(temporary, text, { mode: 0o600 })
  renameSync(temporary, file)
  return file
}
