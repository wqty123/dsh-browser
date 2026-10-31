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
 * - `installed` — the shell's main.js carries our marker and the archive is still moved aside.
 * - `missing` — no marker. Either never installed, or the shell was upgraded (which restores
 *   `app.asar` and replaces `lib/main.js`) and the bridge went with it.
 * - `stale` — the marker is present but `app.asar` is back. That is the signature of a desktop
 *   update that restored the archive without removing our patch: the shell loads the archive, so the
 *   patch inside the unpacked tree has no effect. This is the case that looks installed and is not.
 * @module dsh-browser/browser-electron/bridge-status
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Find the desktop install to report on.
 *
 * The same shape probe the installer uses, repeated here because the two run in different processes
 * and neither can import the other: the product directory is `DeepSeek Harness` on some builds and
 * `DSH Desktop` on others, and the shape that identifies an install is stable across both.
 * @param localAppData - the base directory; defaults to the environment's.
 * @returns the install directory, or undefined when nothing matches.
 */
export function findDesktopInstall(localAppData = process.env.LOCALAPPDATA ?? ''): string | undefined {
  if (localAppData === '') return undefined
  const programs = join(localAppData, 'Programs')
  const looksInstalled = (candidate: string): boolean => existsSync(join(candidate, 'resources', 'app', 'lib', 'main.js'))
    || existsSync(join(candidate, 'resources', 'app.asar'))
  for (const named of ['DSH Desktop', 'DeepSeek Harness']) {
    const candidate = join(programs, named)
    if (looksInstalled(candidate)) return candidate
  }
  try {
    for (const entry of readdirSync(programs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = join(programs, entry.name)
      if (looksInstalled(candidate)) return candidate
    }
  } catch {
    // No Programs directory: nothing to report on, which is a state rather than an error.
  }
  return undefined
}

/** The marker the installer inserts into the shell's main.js. */
const MARKER = '// dsh-builtin-browser: hand the plugin a way to drive the sidebar'

/** One reading of the install tree. */
export interface BridgeStatus {
  /** `installed`, `missing` or `stale`; see the module comment for what each means. */
  readonly state: 'installed' | 'missing' | 'stale'
  /** Whether the install directory looks like a DSH Desktop install at all. */
  readonly present: boolean
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
   * Shown rather than run. Executing it from a web request would mean a page can decide to close the
   * desktop shell, and no amount of same-origin checking makes that a good idea; the user runs it.
   */
  readonly command?: string
}

/**
 * The command a user should run for this state, quoted so it survives a path with spaces.
 * @param installRoot - the install directory, or undefined when none was found.
 * @returns the command line, or undefined when there is nothing useful to suggest.
 */
function repairCommand(installRoot: string | undefined): string | undefined {
  if (installRoot === undefined) return undefined
  return `node desktop-bridge/install.mjs "${installRoot}" --restart`
}

/**
 * Read the bridge's state from an install directory.
 *
 * Never throws: a caller showing this in a settings panel must get an answer even when the directory
 * is unreadable or the user pointed at something that is not an install.
 * @param installRoot - the desktop install directory.
 * @returns the current state.
 */
export function readBridgeStatus(installRoot: string): BridgeStatus {
  const resources = join(installRoot, 'resources')
  const appDir = join(resources, 'app')
  const mainPath = join(appDir, 'lib', 'main.js')
  const archivePath = join(resources, 'app.asar')
  const backupPath = `${mainPath}.before-bridge`

  const archivePresent = safeExists(archivePath)
  const mainPresent = safeExists(mainPath)
  if (!mainPresent && !archivePresent) {
    return {
      state: 'missing',
      present: false,
      installRoot,
      archivePresent,
      command: repairCommand(installRoot),
    detail: 'not a DSH Desktop install: no resources/app/lib/main.js and no resources/app.asar',
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
      ...backupAt === undefined ? {} : { backupAt },
      command: repairCommand(installRoot),
    detail: 'unpacked layout without the bridge patch: the bridge is not installed',
    }
  }
  return {
    state: 'installed',
    present: true,
    installRoot,
    archivePresent,
    ...backupAt === undefined ? {} : { backupAt },
    command: repairCommand(installRoot),
    detail: 'the shell loads the patched tree and the bridge is in it',
  }
}

/** Whether a path exists, treating any error as absence. */
function safeExists(path: string): boolean {
  try { return existsSync(path) } catch { return false }
}

/** Whether a file contains a string, treating any error as absence. */
function safeIncludes(path: string, needle: string): boolean {
  try {
    return existsSync(path) && statSync(path).isFile() && readFileSync(path, 'utf8').includes(needle)
  } catch {
    return false
  }
}
