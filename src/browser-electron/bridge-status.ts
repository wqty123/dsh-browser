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
import { execFileSync } from 'node:child_process'
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
 *
 * Continues issue #40 (reported there as "bridge install path does not exist on this machine"): scanning `%LOCALAPPDATA%\Programs` alone is not enough, because that is
 * only the DEFAULT place the Windows installer puts the app. An install moved to another drive, or
 * installed with a custom directory, is a perfectly good DSH Desktop that this function used to
 * report as "no desktop on this machine" — with the repair command missing at exactly the moment it
 * was needed (measured: a `E:\Applications\DeepSeek Harness` install, once a stale unpacked
 * directory under `Programs` had been cleaned up, started reporting `present: false`).
 *
 * So the scan keeps its default first — a default install must stay cheap and unambiguous — and
 * then consults the two sources a moved install leaves behind: the user's own `DSH_DESKTOP_APP`
 * (already honoured by `tools/install-web-plugin.mjs`) and the Windows uninstall entry the installer
 * writes. Both are re-verified with the same identity rule, so neither widens what counts as an
 * install; they only widen where we look for one.
 * @param localAppData - the base directory; defaults to the environment's.
 * @param registry - where custom installs are looked up; injectable so a test can close the door on
 *   the machine it runs on. A test that asserted "nothing matches" while the developer's own install
 *   sat in the registry would pass or fail depending on the machine, which is worse than no test.
 * @param conventions - the platform's conventional install locations; injectable for the same reason.
 * @returns the install directory, or undefined when nothing matches.
 */
export function findDesktopInstall(
  localAppData = process.env.LOCALAPPDATA ?? '',
  registry: () => readonly string[] = registeredInstallLocations,
  conventions: () => readonly string[] = conventionalInstallRoots,
): string | undefined {
  // An archive-only layout is still a DSH Desktop install: a desktop update repacks `resources/app`
  // into `resources/app.asar`, and the identity rule (which reads the unpacked main entry) then has
  // nothing to read. Treating that as "no desktop here" hid the repair command exactly when it was
  // needed most — measured on this machine after an update.
  const isDesktop = (candidate: string): boolean =>
    readDesktopIdentity(candidate).ok || safeExists(join(candidate, 'resources', 'app.asar'))
  const found = (candidate: string | undefined): boolean =>
    candidate !== undefined && candidate !== '' && isDesktop(candidate)

  if (localAppData !== '') {
    const programs = join(localAppData, 'Programs')
    for (const named of ['DSH Desktop', 'DeepSeek Harness']) {
      const candidate = join(programs, named)
      if (found(candidate)) return candidate
    }
    try {
      for (const entry of readdirSync(programs, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const candidate = join(programs, entry.name)
        if (found(candidate)) return candidate
      }
    } catch {
      // No Programs directory: nothing to report on, which is a state rather than an error. The
      // remaining sources are still worth asking, because a custom install does not need one.
    }
  }

  // The user said where it is. Checked before the registry because an explicit answer needs no
  // inference — and because the environment variable is the documented way to point this plugin at
  // an install the default probe cannot see.
  const declared = process.env.DSH_DESKTOP_APP
  if (found(declared)) return declared as string

  // The installer writes what it actually did here. `InstallLocation` is the directory the user
  // chose, which is precisely the fact a default-path scan cannot know. A lookup that throws is
  // treated as "no answer" rather than propagated: this is one source among three, and the panel
  // must render a state on a locked-down machine as readily as on an open one.
  try {
    for (const location of registry()) {
      if (found(location)) return location
    }
  } catch {
    // Fall through to "nothing found": a failed lookup is not evidence of an install.
  }

  // Platforms with no registry and no `Programs` directory: the convention is the record. On
  // Windows this list is empty (the two sources above already cover it), so this changes nothing
  // there — which is why the reported defect keeps its behaviour while macOS and Linux stop
  // answering "no desktop on this machine" on a machine that has one. Guarded like the registry
  // lookup: walking `/Applications` can fail for reasons the caller cannot act on.
  try {
    for (const candidate of conventions()) {
      if (found(candidate)) return candidate
    }
  } catch {
    // A platform whose conventional locations cannot be read is a state, not an error.
  }
  return undefined
}
/**
 * The `InstallLocation` values the Windows uninstall registry lists for this app.
 *
 * Read through `reg.exe` rather than a Node binding: this module also runs under plain `node` (the
 * installer, the tests), where no registry API exists, and spawning a console tool is the one way
 * that works in both. Every failure — not Windows, `reg` absent, no such key, unparsable output —
 * means "no answer", never an error, because this is one discovery source among several.
 * @returns candidate directories, unverified; the caller applies the identity rule.
 */
function registeredInstallLocations(): readonly string[] {
  if (process.platform !== 'win32') return []
  // The per-user key holds a per-user install and needs no elevation; the machine-wide one holds an
  // install for all users. Both spellings of the product name have shipped, so neither key name is
  // assumed: the whole Uninstall subtree is searched and matched on the value shown to users.
  const roots = [
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ]
  const locations: string[] = []
  for (const root of roots) {
    let output = ''
    try {
      output = execFileSync('reg', ['query', root, '/s', '/f', 'DeepSeek Harness', '/t', 'REG_SZ'],
        { encoding: 'utf8', stdio: 'pipe', timeout: 15_000, windowsHide: true })
    } catch {
      // A key that does not exist exits non-zero, and so does a missing `reg.exe`; both mean the
      // same thing here.
      continue
    }
    // Output is a flat list of `    ValueName    REG_SZ    Data` lines under `Key` headers. Only
    // `InstallLocation` is consulted: `DisplayName` also mentions the product and would otherwise
    // contribute a directory-shaped string that is not a directory.
    for (const line of output.split(/\r?\n/)) {
      const match = /^\s+InstallLocation\s+REG_SZ\s+(.+?)\s*$/.exec(line)
      if (match !== null && match[1] !== '') locations.push(match[1])
    }
  }
  return locations
}

/**
 * The places a packaged app is conventionally installed on this platform.
 *
 * Windows has a registry to consult; the other two do not, so the convention IS the record. Naming
 * them is not the same as guessing blindly — every candidate still has to pass the identity rule —
 * and it is what makes discovery work at all on a platform with no default install directory that
 * this plugin can compute from one environment variable.
 *
 * macOS puts a user-visible app in `/Applications` (all users) or `~/Applications` (one user), and
 * the part that matters is inside the bundle: `<app>.app/Contents/Resources/app.asar`.
 *
 * Linux has no single convention. The directories listed are where each packaging style actually
 * lands: `/opt` for a tarball or a vendor `.deb`, `/usr/lib` for a distro package, `~/.local` for a
 * per-user extract. The point is to have somewhere to look before declaring the machine empty.
 * @param platform - injected so a test can ask for another platform's list.
 * @returns candidate install roots, unverified.
 */
function conventionalInstallRoots(platform: NodeJS.Platform = process.platform): readonly string[] {
  const home = process.env.HOME ?? ''
  if (platform === 'darwin') {
    // Inside the bundle, `Resources` is what Electron treats as `resources`; the identity rule then
    // looks for `app.asar` or `app/` beneath it exactly as on Windows.
    const bundles = [
      '/Applications/DeepSeek Harness.app',
      '/Applications/DSH Desktop.app',
      ...home === '' ? [] : [
        join(home, 'Applications', 'DeepSeek Harness.app'),
        join(home, 'Applications', 'DSH Desktop.app'),
      ],
    ]
    return bundles.map(bundle => join(bundle, 'Contents', 'Resources'))
  }
  if (platform === 'linux') {
    // Directory names only — never a package name. The accepted package names live in
    // `desktop-identity.json` and nowhere else.
    return [
      '/opt/DeepSeek Harness',
      '/opt/DSH Desktop',
      '/usr/lib/DeepSeek Harness',
      '/usr/lib/DSH Desktop',
      ...home === '' ? [] : [
        join(home, '.local', 'share', 'DeepSeek Harness'),
        join(home, '.local', 'share', 'DSH Desktop'),
      ],
    ]
  }
  return []
}

/** The marker the installer inserts into the shell's main.js. */
const MARKER = '// dsh-builtin-browser: hand the plugin a way to drive the sidebar'

/** One reading of the install tree. */
export interface BridgeStatus {
  /** `installed`, `missing` or `stale`; see the module comment for what each means. */
  readonly state: 'installed' | 'missing' | 'stale'
  /** Whether the install directory looks like a DSH Desktop install at all. */
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
    version: 'version' in identity && typeof identity.version === 'string' ? identity.version : 'unknown',
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
