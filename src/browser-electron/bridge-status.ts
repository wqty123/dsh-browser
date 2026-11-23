/**
 * Whether the desktop bridge is installed, and what state its files are in.
 *
 * Reported as issue #36: when the bridge is missing the plugin only logs a warning, so a user who
 * chose `channel: sidebar` sees "another window opened again" and has no way to connect that with
 * "the bridge is not installed". This module answers the question the panel needs to show, from the
 * install tree on disk rather than from anything the plugin remembers.
 *
 * The states are the three that actually occur:
 *
 * - `installed` — the loaded main.js carries our marker and its bridge matches this plugin.
 * - `missing` — no marker. Either never installed, or the shell was upgraded (which restores
 *   `app.asar` and replaces `lib/main.js`) and the bridge went with it.
 * - `stale` — the archive is back, or the deployed bridge module is missing or outdated.
 * @module dsh-browser/browser-electron/bridge-status
 */
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

import { desktopPaths, readDesktopIdentity } from './desktop-identity.ts'
import { classifyDesktopShell, noDesktopShell, tauriShell, type DesktopShellReport } from './desktop-shell.ts'
import { findTauriRuntime, runningTauriRuntime, tauriHostPatchStatus } from './tauri-host.ts'
import { MAIN_EXTENSION_UNSUPPORTED, type MainExtensionStatus } from './profile-extension.ts'
import { BRIDGE_VERSION_MESSAGE } from '../bridge-compatibility.ts'
import { conventionalInstallRoots, registeredInstallLocations } from '../../desktop-bridge/desktop-discovery.mjs'

// A normal Electron existsSync(app.asar) caches the archive and keeps it locked on Windows.
// Status inspection must leave maintenance free to rename it after Desktop exits.
const rawExistsSync: typeof existsSync = (() => {
  try { return (createRequire(import.meta.url)('original-fs') as typeof import('node:fs')).existsSync }
  catch { return existsSync }
})()

/**
 * Find the desktop install to report on.
 *
 * Reported as issue #40: this used to probe for a *generic* Electron layout and return the first
 * directory that had one. Any Electron app has that layout, so a stranger's app was reported as
 * "DSH Desktop, bridge missing" — together with a ready-to-run installer command aimed at it. The
 * probe now verifies the same identity the installer does (see `desktop-identity.js`), so the
 * answer is about DSH Desktop and nothing else.
 * @param localAppData - the base directory; defaults to the environment's.
 * @returns the install directory, or undefined when nothing matches.
 */
export function findDesktopInstall(
  localAppData?: string,
  registry: () => readonly string[] = registeredInstallLocations,
  conventions: () => readonly string[] = conventionalInstallRoots,
): string | undefined {
  for (const candidate of desktopInstallCandidates(localAppData, registry, conventions)) {
    if (readDesktopIdentity(candidate).ok) return candidate
  }
  return undefined
}

/**
 * Classify the desktop shell on this machine.
 *
 * The DSH Tauri hosting this process wins; then a verified official install found by the same walk as
 * {@link findDesktopInstall}; then an installed DSH Tauri; else the first recognised DSH-named shell
 * (third-party or unsupported) is reported, so the settings page can say what it found instead of
 * "no install" — and never offer to patch it.
 * @param options - discovery overrides and the browser to recommend when the sidebar is unavailable.
 * @returns the structured report.
 */
export function detectDesktopShell(options: {
  readonly localAppData?: string
  readonly registry?: () => readonly string[]
  readonly conventions?: () => readonly string[]
  readonly preferredBrowser?: string
  readonly platform?: NodeJS.Platform
  readonly execPath?: string
  readonly tauriRegistry?: () => readonly string[]
} = {}): DesktopShellReport {
  const running = runningTauriRuntime(options.execPath)
  if (running !== undefined) return tauriShell(running, tauriHostPatchStatus(running.runtime))
  let recognised: DesktopShellReport | undefined
  for (const candidate of desktopInstallCandidates(options.localAppData, options.registry, options.conventions)) {
    const report = classifyDesktopShell(candidate, readDesktopIdentity(candidate), options)
    if (report.kind === 'official-supported') return report
    if (report.kind !== 'none' && recognised === undefined) recognised = report
  }
  const tauri = findTauriRuntime({ execPath: options.execPath, localAppData: options.localAppData, registry: options.tauriRegistry ?? options.registry })
  if (tauri !== undefined) return tauriShell(tauri, tauriHostPatchStatus(tauri.runtime))
  return recognised ?? noDesktopShell(options)
}

/**
 * Every directory that might hold a desktop install, most specific first.
 *
 * Not every install lives in %LOCALAPPDATA%\\Programs: people put the app on another drive, under
 * Program Files, or in their own folder. DSH_DESKTOP_PATH names one explicitly, and the usual roots
 * are all probed. A test or a caller that passes a base directory gets exactly that base, so the
 * behaviour stays pinnable. Candidates are unverified; callers check identity.
 */
function* desktopInstallCandidates(
  localAppData?: string,
  registry: () => readonly string[] = registeredInstallLocations,
  conventions: () => readonly string[] = conventionalInstallRoots,
): Generator<string> {
  for (const explicit of [process.env.DSH_DESKTOP_PATH, process.env.DSH_DESKTOP_APP]) {
    if (explicit !== undefined && explicit !== '') {
      yield explicit
      // A parent directory is a reasonable thing to point at too: look one level down.
      try {
        for (const entry of readdirSync(explicit, { withFileTypes: true })) {
          if (entry.isDirectory()) yield join(explicit, entry.name)
        }
      } catch {
        // Not a directory: fall through to the usual roots.
      }
    }
  }
  const roots = localAppData === undefined ? desktopInstallRoots() : [join(localAppData, 'Programs')]
  for (const base of roots) {
    for (const named of DESKTOP_INSTALL_NAMES) yield join(base, named)
    try {
      for (const entry of readdirSync(base, { withFileTypes: true })) {
        if (entry.isDirectory()) yield join(base, entry.name)
      }
    } catch {
      // A root that does not exist is a state, not an error.
    }
  }
  for (const source of [registry, conventions]) {
    let found: readonly string[] = []
    try { found = source() } catch {}
    yield* found
  }
}

/** Directory names an install is given: a plain directory on Windows, an `.app` bundle on macOS. */
const DESKTOP_INSTALL_NAMES = ['DSH Desktop', 'DeepSeek Harness', 'DSH Desktop.app', 'DeepSeek Harness.app']

/**
 * Where this OS keeps installed applications, most specific first.
 * @returns the existing-or-not base directories to probe.
 */
function desktopInstallRoots(): string[] {
  const windows = [process.env.LOCALAPPDATA ?? '', process.env['ProgramFiles'] ?? '', process.env['ProgramFiles(x86)'] ?? '', process.env.APPDATA ?? '', process.env.ProgramData ?? '']
    .filter(base => base !== '')
    .map(base => (base === process.env.LOCALAPPDATA ? join(base, 'Programs') : base))
  // The machine-wide macOS roots cannot be redirected, so a test process never reads them.
  const testing = process.env.DSH_BROWSER_TEST === '1' || process.env.NODE_TEST_CONTEXT !== undefined
  return process.platform === 'darwin' && !testing ? [...windows, '/Applications', join(homedir(), 'Applications')] : windows
}

/** The marker the installer inserts into the shell's main.js. */
const MARKER = '// dsh-builtin-browser: hand the plugin a way to drive the sidebar'

/** One reading of the install tree. */
export interface BridgeStatus {
  readonly mainExtension?: MainExtensionStatus
  readonly code?: string
  /** `installed`, `missing` or `stale`; see the module comment for what each means. */
  readonly state: 'installed' | 'missing' | 'stale'
  /** Whether the loaded application passed DSH Desktop identity verification. */
  readonly present: boolean
  /**
   * The desktop build this reading belongs to, when the identity check could name one.
   *
   * The automatic install runs once per build: a desktop update is exactly when the bridge has to be
   * installed again, so the guard needs to tell the two apart.
   */
  readonly version?: string
  /** The directory that was inspected, when one was found. */
  readonly installRoot?: string
  /** Whether `resources/app.asar` exists — the archive the shell actually loads. */
  readonly archivePresent: boolean
  /** When the pre-bridge backup was written, if there is one. */
  readonly backupAt?: string
  /** A one-line explanation for the panel, in the plugin's own words. */
  readonly detail: string
  /**
   * The command that installs or repairs the bridge.
   *
   * The panel can show this command for manual use. Its install button calls the same packaged
   * installer through the separately authenticated local bridge-action route.
   */
  readonly command?: string
}

/**
 * The installer script inside THIS plugin package.
 *
 * Reported as issue #40, fourth item: the panel told users to run
 * `node desktop-bridge/install.mjs "<root>" --restart`, which assumes the reader is standing in a
 * source checkout. Anyone who installed the plugin from npm or the market has no such relative path —
 * the file lives inside the installed package, and there is nowhere sensible for them to run the
 * command from. Resolving it from this module's own location is the difference between a hint and an
 * instruction that works.
 * @returns the absolute path, or undefined when the package layout is unexpected.
 */
function installerScriptPath(): string | undefined {
  try {
    // lib/browser-electron/bridge-status.js → <package>/desktop-bridge/install.mjs
    const url = new URL('../../desktop-bridge/install.mjs', import.meta.url)
    const path = fileURLToPath(url)
    return safeExists(path) ? path : undefined
  } catch {
    return undefined
  }
}

/**
 * The command a user should run for this state, quoted so it survives a path with spaces.
 * @param installRoot - the install directory, or undefined when none was found.
 * @returns the command line, or undefined when there is nothing useful to suggest.
 */
function repairCommand(installRoot: string | undefined): string | undefined {
  if (installRoot === undefined) return undefined
  const script = installerScriptPath()
  // No absolute path means the package is laid out in a way this module cannot navigate; the bare
  // relative form is still better than nothing, but it is the fallback, not the default.
  const runner = script === undefined ? 'desktop-bridge/install.mjs' : `"${script}"`
  return `node ${runner} "${installRoot}"`
}

/**
 * Read the bridge's state from an install directory.
 *
 * Never throws: a caller showing this in a settings panel must get an answer even when the directory
 * is unreadable or the user pointed at something that is not an install.
 * @param installRoot - the desktop install directory.
 * @returns the current state.
 */
export function readBridgeStatus(installRoot: string, mainExtension?: MainExtensionStatus): BridgeStatus {
  const disk = readBridgeInstallStatus(installRoot)
  if (mainExtension === undefined) return { ...disk, code: disk.code ?? MAIN_EXTENSION_UNSUPPORTED }
  return { ...disk, mainExtension, command: undefined, detail: `desktop main extension: ${mainExtension.state}`,
    state: mainExtension.state === 'loaded' ? 'installed' : mainExtension.state === 'not-installed' ? 'missing' : 'stale',
    code: mainExtension.code }
}

function readBridgeInstallStatus(installRoot: string): BridgeStatus {
  let resources: string
  try { resources = desktopPaths(installRoot).resources }
  catch (error) {
    return { state: 'missing', present: false, installRoot, archivePresent: false, detail: `not a DSH Desktop install: ${String(error)}` }
  }
  const appDir = join(resources, 'app')
  const mainPath = join(appDir, 'lib', 'main.js')
  const archivePath = join(resources, 'app.asar')
  const backupPath = `${mainPath}.before-bridge`

  // Identity first, and before any other reading. Two reasons, both measured in issue #40: a
  // stranger's app must not be reported as DSH Desktop, and this status also carries a *command* —
  // pointing that command at a directory whose identity was never verified is how the installer got
  // aimed at an application that merely looked like Electron.
  const identity = readDesktopIdentity(installRoot)
  if (!identity.ok) {
    return {
      state: 'missing',
      present: false,
      installRoot,
      archivePresent: safeExists(archivePath),
      detail: `not a DSH Desktop install: ${identity.reason}`,
    }
  }

  const archivePresent = safeExists(archivePath)
  const version = identity.version ?? 'unknown'
  const mainPresent = safeExists(mainPath)
  if (!mainPresent && !archivePresent) {
    // Unreachable once identity has passed (identity requires the loaded main entry), kept as the
    // fail-closed branch for a tree that changed between the two reads.
    return {
      state: 'missing',
      present: false,
      installRoot,
      archivePresent,
      version,
      detail: 'not a DSH Desktop install: no resources/app/lib/main.js and no resources/app.asar',
    }
  }
  if (!rawExistsSync(archivePath)
    && safeIncludes(mainPath, '//#region lib/types/main-extensions.js')
    && safeExists(fileURLToPath(new URL('../../desktop-bridge/main.mjs', import.meta.url)))) {
    return {
      state: 'installed', present: true, installRoot, archivePresent: false,
      detail: 'DSH Desktop main extension loads the bridge from the installed profile plugin',
      ...identity.version === undefined ? {} : { version: identity.version },
      command: repairCommand(installRoot),
    }
  }
  let backupAt
  try {
    if (existsSync(backupPath)) backupAt = statSync(backupPath).mtime.toISOString()
  } catch {
    // A backup we cannot stat is simply not reported; it does not change the state.
  }
  if (archivePresent && !safeIncludes(mainPath, MARKER)) {
    // The archive is what the shell loads, so an unpacked tree without our marker is not in effect
    // even if it were patched.
    return {
      state: 'missing',
      present: true,
      installRoot,
      archivePresent,
      version,
      ...backupAt === undefined ? {} : { backupAt },
      command: repairCommand(installRoot),
      detail: 'packed layout with no bridge in the loaded tree: the bridge is not installed',
    }
  }
  if (archivePresent) {
    return {
      state: 'stale',
      present: true,
      installRoot,
      archivePresent,
      version,
      ...backupAt === undefined ? {} : { backupAt },
      command: repairCommand(installRoot),
      detail: 'the archive is back alongside the patched tree, so the shell loads the archive: '
        + 'a desktop update restored it. Re-run the installer to repair.',
    }
  }
  if (!safeIncludes(mainPath, MARKER)) {
    return {
      state: 'missing',
      present: true,
      installRoot,
      archivePresent,
      version,
      ...backupAt === undefined ? {} : { backupAt },
      command: repairCommand(installRoot),
      detail: 'unpacked layout without the bridge patch: the bridge is not installed',
    }
  }
  const bridgePath = join(appDir, 'lib', 'plugin-browser-bridge.js')
  let bridgeDetail: string | undefined
  let bridgeCode: string | undefined
  try {
    const deployed = readFileSync(bridgePath)
    const shipped = readFileSync(new URL('../../desktop-bridge/plugin-browser-bridge.js', import.meta.url))
    const loader = readFileSync(new URL('../../desktop-bridge/profile-loader.mjs', import.meta.url))
    if (deployed.equals(loader)) {
      try {
        const profile = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'profiles', 'desktop')
        const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'))
        if (!Object.hasOwn(manifest.dependencies ?? {}, 'dsh-builtin-browser')) throw new Error('not a direct profile dependency')
        const directory = realpathSync(join(profile, 'node_modules', 'dsh-builtin-browser'))
        const entry = realpathSync(join(directory, 'desktop-bridge', 'plugin-browser-bridge.js'))
        const child = relative(directory, entry)
        if (!child || isAbsolute(child) || child === '..' || child.startsWith('../') || child.startsWith('..\\')) {
          throw new Error('bridge entry resolves outside its package')
        }
        if (!readFileSync(entry).equals(shipped)) bridgeDetail = BRIDGE_VERSION_MESSAGE
      } catch {
        bridgeCode = 'DSH_BRIDGE_PACKAGE_UNAVAILABLE'
        bridgeDetail = `${bridgeCode}: the profile loader's package bridge is missing, unreadable or outside its package`
      }
    } else if (!deployed.equals(shipped)) bridgeDetail = BRIDGE_VERSION_MESSAGE
  } catch {
    bridgeDetail = 'the bridge module is missing or cannot be verified; reinstall the bridge to restore it'
  }
  return {
    state: bridgeDetail === undefined ? 'installed' : 'stale',
    ...bridgeCode === undefined ? {} : { code: bridgeCode },
    present: true,
    installRoot,
    archivePresent,
    version,
    ...backupAt === undefined ? {} : { backupAt },
    command: repairCommand(installRoot),
    detail: bridgeDetail ?? 'the shell loads the patched tree and its bridge module matches this plugin version',
  }
}

/** Whether a path exists, treating any error as absence. */
function safeExists(path: string): boolean {
  try { return rawExistsSync(path) } catch { return false }
}

/** Whether a file contains a string, treating any error as absence. */
function safeIncludes(path: string, needle: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile() && readFileSync(path, 'utf8').includes(needle)
  } catch {
    return false
  }
}
