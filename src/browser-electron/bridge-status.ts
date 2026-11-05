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
import { fileURLToPath } from 'node:url'

import { readDesktopIdentity } from './desktop-identity.js'

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
export function findDesktopInstall(localAppData = process.env.LOCALAPPDATA ?? ''): string | undefined {
  if (localAppData === '') return undefined
  const programs = join(localAppData, 'Programs')
  // An archive-only layout is still a DSH Desktop install: a desktop update repacks `resources/app`
  // into `resources/app.asar`, and the identity rule (which reads the unpacked main entry) then has
  // nothing to read. Treating that as "no desktop here" hid the repair command exactly when it was
  // needed most — measured on this machine after an update.
  const isDesktop = (candidate: string): boolean =>
    readDesktopIdentity(candidate).ok || safeExists(join(candidate, 'resources', 'app.asar'))
  for (const named of ['DSH Desktop', 'DeepSeek Harness']) {
    const candidate = join(programs, named)
    if (isDesktop(candidate)) return candidate
  }
  try {
    for (const entry of readdirSync(programs, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = join(programs, entry.name)
      if (isDesktop(candidate)) return candidate
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
  return `node ${runner} "${installRoot}" --restart`
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

  // Identity first, and before any other reading. Two reasons, both measured in issue #40: a
  // stranger's app must not be reported as DSH Desktop, and this status also carries a *command* —
  // pointing that command at a directory whose identity was never verified is how the installer got
  // aimed at an application that merely looked like Electron.
  const identity = readDesktopIdentity(installRoot)
  if (!identity.ok) {
    // The identity rule reads the unpacked main entry. When the archive is what exists, the tree it
    // wants is gone — the signature of a desktop update that restored app.asar and took the bridge
    // with it. Reporting `absent` there was wrong twice over: the desktop is installed, and the
    // user needs the repair command.
    if (safeExists(archivePath)) {
      return {
        state: 'stale',
        present: true,
        installRoot,
        archivePresent: true,
        command: repairCommand(installRoot),
        detail: 'the desktop is packed (resources/app.asar) and the unpacked tree the bridge lives in '
          + 'is gone — most likely a desktop update restored the archive: re-run the installer to repair',
      }
    }
    return {
      state: 'missing',
      present: false,
      installRoot,
      archivePresent: false,
      detail: `not a DSH Desktop install: ${identity.reason}`,
    }
  }

  const archivePresent = safeExists(archivePath)
  const mainPresent = safeExists(mainPath)
  if (!mainPresent && !archivePresent) {
    // Unreachable once identity has passed (identity requires the loaded main entry), kept as the
    // fail-closed branch for a tree that changed between the two reads.
    return {
      state: 'missing',
      present: false,
      installRoot,
      archivePresent,
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
