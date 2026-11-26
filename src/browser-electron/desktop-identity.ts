/**
 * What proves a directory is a DSH Desktop install.
 *
 * Reported as issue #40. Every reader of an install directory used to accept a *generic* Electron
 * layout (`resources/app/lib/main.js` or `resources/app.asar`) as proof, and that is not proof of
 * anything: any Electron app has it. The consequence was measured — a throwaway app in a temp
 * directory, whose own package.json said `unrelated-meeting-app`, was accepted by discovery, got a
 * "bridge not installed" verdict with a ready-to-run installer command aimed at it, and (with that
 * command) had its entry file rewritten and the bridge copied in.
 *
 * So identity is one rule, in one file (`desktop-bridge/desktop-identity.json`), read by both the
 * installer and this module. Nothing else may decide what a DSH Desktop install is.
 *
 * Two properties are load-bearing and are why this is not a one-line `name ===` check:
 *
 * - **The archive wins.** Electron loads `resources/app.asar` in preference to `resources/app`, and
 *   a desktop update leaves the old extraction lying around. Reading identity from the extraction
 *   while the archive holds a different build would verify the wrong bytes, so when the archive is
 *   present that is what is read — and the sibling directory is not consulted at all.
 * - **Unreadable means not DSH.** Every failure path (missing file, truncated pickle, unsupported
 *   archive version, malformed JSON, unreadable name) refuses. There is no "assume yes" branch: the
 *   caller is about to write into, or delete from, this directory.
 * @module dsh-browser/browser-electron/desktop-identity
 */
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'

// Electron's patched fs opens an ASAR as a virtual directory. Identity needs the raw archive
// header and file offsets, including when this reader runs in the Desktop's Node-mode worker.
const archiveFs: Pick<typeof import('node:fs'), 'openSync' | 'readSync' | 'closeSync' | 'existsSync'> = (() => {
  try { return createRequire(import.meta.url)('original-fs') as typeof import('node:fs') }
  catch { return { openSync, readSync, closeSync, existsSync } }
})()

/** The identity rule, as data. */
/** Where one kind of install keeps its resources, executable and CLI launcher (all relative). */
export interface DesktopLayout {
  readonly name: string
  /** The layout applies when this path exists under the install root; the default has none. */
  readonly marker?: string
  readonly resources: string
  readonly executable: string
  readonly cliLauncher: string
}

interface IdentityRule {
  readonly packageNames: readonly string[]
  readonly mainEntry: string
  /** Further accepted entries; each states the dependency that must be present to qualify. */
  readonly mainEntryCandidates?: readonly {
    readonly entry: string
    readonly packageName?: string
    /** Dependency that must appear in the app's own manifest for this entry to be accepted. */
    readonly requiresDependency?: string
    readonly note?: string
  }[]
  /** Main entries of look-alike Desktops that are recognized only to be refused, with the reason. */
  readonly unsupportedMainEntries?: Readonly<Record<string, string>>
  readonly layouts: readonly DesktopLayout[]
}

/**
 * The rule shipped in `desktop-bridge/desktop-identity.json`, used when the file cannot be read.
 *
 * A copy exists here only as a fallback for a broken package layout; the test suite asserts that it
 * equals the JSON, so the two can never drift apart silently.
 */
export const FALLBACK_RULE: IdentityRule = {
  packageNames: ['@deepseek-ai/dsh-desktop', 'dsh-desktop'],
  mainEntry: 'lib/main.js',
  mainEntryCandidates: [
    {
      entry: 'out/main/index.js',
      packageName: 'dsh-desktop',
      requiresDependency: '@deepseek-ai/dsh',
      note: 'electron-vite layout. The official DSH Desktop 0.14.0 ships this entry with `main: ./out/main/index.js` and no `lib` directory at all (issue #112), while the third-party electron-vite shell (dataelement/dsh-desktop, issue #62) shares the same shape. The `@deepseek-ai/dsh` dependency is what separates them: the official bundle carries it, the third-party shell does not.',
    },
  ],
  unsupportedMainEntries: {
    'out/main/index.js': 'the electron-vite layout of a third-party DSH Desktop (dataelement/dsh-desktop, issue #62), which shares the package name but not the DeepSeek Harness Desktop shell the bridge patches',
  },
  layouts: [
    { name: 'macos-bundle', marker: 'Contents/Info.plist', resources: 'Contents/Resources', executable: 'Contents/MacOS/DeepSeek Harness', cliLauncher: 'runtime/cli/bin/dsh' },
    { name: 'directory', resources: 'resources', executable: 'DeepSeek Harness.exe', cliLauncher: 'runtime/cli/bin/dsh.cmd' },
  ],
}

/** A verified install. */
export interface DesktopIdentity {
  readonly ok: true
  /** The entry this install actually uses: `mainEntry`, or an accepted candidate. */
  readonly mainEntry: string
  /** The install root that was verified. */
  readonly root: string
  /** Which shape was verified — the archive when it exists, the extraction only without one. */
  readonly layout: 'packed' | 'unpacked'
  /** `name` from the package the caller will actually run. */
  readonly packageName: string
  /** `version`, when the package declares one. */
  readonly version?: string
}

/** A refusal, with a reason a human can act on. */
export interface IdentityRefusal {
  readonly ok: false
  readonly reason: string
  /**
   * Set once the manifest has named a DSH Desktop package: `third-party-shell` for a layout the rule
   * attributes to another shell, `official-unsupported` for an official package without the patched entry.
   */
  readonly shell?: 'third-party-shell' | 'official-unsupported'
  /** The manifest version, when the refusal came after reading it. */
  readonly version?: string
}

function versionOf(manifest: { version?: unknown }): { version?: string } {
  return typeof manifest.version === 'string' ? { version: manifest.version } : {}
}

/**
 * Read the identity rule.
 *
 * Resolved relative to this module, which in both the repository and the published tarball puts
 * `desktop-bridge/` beside `lib/`. A missing file is not fatal — the fallback is the same rule —
 * but a *malformed* one is an error the caller should not ignore, so it is reported through the
 * refusal path rather than silently swapped for the fallback.
 * @returns the rule, or an error string.
 */
export function readIdentityRule(): IdentityRule | { readonly error: string } {
  try {
    const path = new URL('../../desktop-bridge/desktop-identity.json', import.meta.url)
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Partial<IdentityRule>
    const names = raw.packageNames
    const main = raw.mainEntry
    if (!Array.isArray(names) || names.length === 0 || names.some(n => typeof n !== 'string')) {
      return { error: 'desktop-identity.json: packageNames must be a non-empty array of strings' }
    }
    if (typeof main !== 'string' || main === '') {
      return { error: 'desktop-identity.json: mainEntry must be a non-empty string' }
    }
    const layouts = raw.layouts
    const field = (value: unknown): boolean => typeof value === 'string' && value !== ''
    if (!Array.isArray(layouts) || layouts.length === 0
      || layouts.some(l => l === null || typeof l !== 'object' || !field(l.name) || !field(l.resources) || !field(l.executable) || !field(l.cliLauncher)
        || (l.marker !== undefined && !field(l.marker)))
      || layouts[layouts.length - 1]?.marker !== undefined) {
      return { error: 'desktop-identity.json: layouts must be a non-empty array whose last entry has no marker' }
    }
    const candidates = raw.mainEntryCandidates
    if (candidates !== undefined && (!Array.isArray(candidates) || candidates.some(c => c === null || typeof c !== 'object'
      || !field(c.entry) || (c.requiresDependency !== undefined && !field(c.requiresDependency))))) {
      return { error: 'desktop-identity.json: mainEntryCandidates must list entries with an optional requiresDependency' }
    }
    const unsupported = raw.unsupportedMainEntries
    if (unsupported !== undefined && (unsupported === null || typeof unsupported !== 'object' || Array.isArray(unsupported)
      || Object.entries(unsupported).some(([entry, reason]) => entry === '' || !field(reason)))) {
      return { error: 'desktop-identity.json: unsupportedMainEntries must map entry paths to reasons' }
    }
    // The candidates are part of the rule; dropping them here is what made a valid candidate entry
    // indistinguishable from an unsupported one.
    const base = candidates === undefined
      ? { packageNames: names, mainEntry: main }
      : { packageNames: names, mainEntry: main, mainEntryCandidates: candidates }
    return unsupported === undefined
      ? { ...base, layouts }
      : { ...base, unsupportedMainEntries: unsupported, layouts }
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return FALLBACK_RULE
    }
    return { error: `desktop-identity.json could not be read: ${String(error)}` }
  }
}

function layoutOf(rule: IdentityRule, installRoot: string): DesktopLayout {
  return rule.layouts.find(layout => layout.marker === undefined || existsSync(join(installRoot, ...layout.marker.split('/'))))
    ?? rule.layouts[rule.layouts.length - 1] as DesktopLayout
}

/**
 * The layout of an install root: a macOS `.app` bundle or a plain directory (Windows).
 * Decided by the install's own shape rather than the host OS, so every platform reads it the same.
 * @param installRoot - the install directory.
 * @returns the layout, or an error when the identity rule cannot be read.
 */
export function desktopLayout(installRoot: string): DesktopLayout | { readonly error: string } {
  const rule = readIdentityRule()
  return 'error' in rule ? rule : layoutOf(rule, installRoot)
}

/**
 * Absolute paths an install keeps, from its layout.
 * @param installRoot - the install directory.
 * @returns resources directory, GUI executable and CLI launcher.
 */
export function desktopPaths(installRoot: string): { readonly resources: string; readonly executable: string; readonly cliLauncher: string } {
  const layout = desktopLayout(installRoot)
  if ('error' in layout) throw new Error(layout.error)
  const resources = join(installRoot, ...layout.resources.split('/'))
  return { resources, executable: join(installRoot, ...layout.executable.split('/')), cliLauncher: join(resources, ...layout.cliLauncher.split('/')) }
}

/**
 * One entry of a Chromium pickle header.
 *
 * `offset` is relative to the content area that follows the header; `unpacked` entries carry no
 * bytes in the archive and live beside it instead.
 */
interface AsarEntry {
  readonly size: number
  readonly offset?: string
  readonly unpacked?: boolean
  readonly files?: Record<string, AsarEntry>
}

/**
 * Parse an asar header, the same way the installer does.
 *
 * Layout, for the next reader: an 8-byte outer pickle (`[size][jsonLength]`), then the header
 * pickle whose first 4 bytes are the JSON length, then the JSON tree. File content starts right
 * after the header pickle.
 * @param archive - the archive path.
 * @returns the header tree and the offset where content starts, or an error string.
 */
function readAsarHeader(archive: string): { header: { files?: Record<string, AsarEntry> }; contentBase: number } | { error: string } {
  let fd: number | undefined
  try {
    fd = archiveFs.openSync(archive, 'r')
    const outer = Buffer.alloc(8)
    if (archiveFs.readSync(fd, outer, 0, 8, 0) !== 8) return { error: 'the archive header is truncated' }
    const headerSize = outer.readUInt32LE(4)
    if (headerSize < 8 || headerSize > 64 * 1024 * 1024) return { error: `implausible archive header size (${headerSize})` }
    const header = Buffer.alloc(headerSize)
    if (archiveFs.readSync(fd, header, 0, headerSize, 8) !== headerSize) return { error: 'the archive header is truncated' }
    const jsonLength = header.readUInt32LE(4)
    if (jsonLength <= 0 || jsonLength > headerSize - 8) return { error: 'the archive header has an implausible JSON length' }
    return { header: JSON.parse(header.toString('utf8', 8, 8 + jsonLength)), contentBase: 8 + headerSize }
  } catch (error) {
    return { error: `the archive header could not be read: ${String(error)}` }
  } finally {
    if (fd !== undefined) {
      try { archiveFs.closeSync(fd) } catch { /* already closed */ }
    }
  }
}

/**
 * Walk a slash-separated path inside an asar header tree.
 * @param tree - the header's `files` node.
 * @param path - e.g. `lib/main.js`.
 * @returns the entry, or undefined when the path does not exist.
 */
function entryAt(tree: Record<string, AsarEntry> | undefined, path: string): AsarEntry | undefined {
  let node: AsarEntry | undefined
  let files: Record<string, AsarEntry> | undefined = tree
  for (const part of path.split('/')) {
    if (files === undefined) return undefined
    node = files[part]
    if (node === undefined) return undefined
    files = node.files
  }
  return node
}

/**
 * Read one file out of an asar archive without extracting the tree.
 * @param archive - the archive path.
 * @param path - a slash-separated path inside the archive.
 * @returns the bytes, or undefined when the entry is absent or unreadable.
 */
export function readAsarFile(archive: string, path: string): Buffer | undefined {
  const parsed = readAsarHeader(archive)
  if ('error' in parsed) return undefined
  const entry = entryAt(parsed.header.files, path)
  if (entry === undefined || entry.files !== undefined || entry.unpacked === true) return undefined
  if (typeof entry.offset !== 'string' || typeof entry.size !== 'number' || entry.size < 0) return undefined
  let fd: number | undefined
  try {
    fd = archiveFs.openSync(archive, 'r')
    const buffer = Buffer.alloc(entry.size)
    const read = archiveFs.readSync(fd, buffer, 0, entry.size, parsed.contentBase + Number(entry.offset))
    return read === entry.size ? buffer : undefined
  } catch {
    return undefined
  } finally {
    if (fd !== undefined) {
      try { archiveFs.closeSync(fd) } catch { /* already closed */ }
    }
  }
}

/**
 * Whether an install directory is DSH Desktop.
 *
 * Everything the caller does next (stop the app, delete a tree, extract, rename, write) depends on
 * this being right, so every uncertainty resolves to a refusal that names what was found.
 * @param installRoot - the directory a user or the discovery probe named.
 * @returns the verified identity, or a refusal with a reason.
 */
export function readDesktopIdentity(installRoot: string): DesktopIdentity | IdentityRefusal {
  const rule = readIdentityRule()
  if ('error' in rule) return { ok: false, reason: rule.error }
  const resources = join(installRoot, ...layoutOf(rule, installRoot).resources.split('/'))
  const appDir = join(resources, 'app')
  const archive = join(resources, 'app.asar')

  let archivePresent: boolean
  try {
    archivePresent = archiveFs.existsSync(archive)
  } catch {
    return { ok: false, reason: `cannot inspect ${archive}` }
  }

  const layout: 'packed' | 'unpacked' = archivePresent ? 'packed' : 'unpacked'
  let manifestText: string | undefined
  let hasEntry: (entry: string) => boolean
  if (archivePresent) {
    const parsed = readAsarHeader(archive)
    if ('error' in parsed) {
      return { ok: false, reason: `${archive} could not be read: ${parsed.error}` }
    }
    const manifest = entryAt(parsed.header.files, 'package.json')
    if (manifest === undefined || manifest.files !== undefined || manifest.unpacked === true) {
      return { ok: false, reason: `${archive} has no plain package.json; an archive without one is not proof of identity` }
    }
    manifestText = readAsarFile(archive, 'package.json')?.toString('utf8')
    if (manifestText === undefined) {
      return { ok: false, reason: `${archive}: package.json is listed but its bytes cannot be read` }
    }
    hasEntry = entry => entryAt(parsed.header.files, entry) !== undefined
  } else {
    const manifestPath = join(appDir, 'package.json')
    try {
      manifestText = readFileSync(manifestPath, 'utf8')
    } catch (error) {
      // Candidate probe directories routinely do not contain resources/app/package.json (issue #106).
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.error(`[dsh-browser] cannot read the package manifest at ${manifestPath}: ${String(error)}`)
      }
      return { ok: false, reason: `${manifestPath} is missing; a directory without a package manifest is not a DSH Desktop install` }
    }
    hasEntry = entry => existsSync(join(appDir, ...entry.split('/')))
  }

  let manifest: { name?: unknown; version?: unknown }
  try {
    manifest = JSON.parse(manifestText) as { name?: unknown; version?: unknown }
  } catch {
    return { ok: false, reason: 'the package manifest is not valid JSON' }
  }
  const name = typeof manifest.name === 'string' ? manifest.name : ''
  if (!rule.packageNames.includes(name)) {
    return {
      ok: false,
      reason: `the app calls itself ${name === '' ? '(no name)' : JSON.stringify(name)}, which is not one of `
        + `${rule.packageNames.join(' / ')} — refusing to touch a different application`,
    }
  }

  // The main entry is the file the installer patches and the shell runs. The default name comes
  // first; the candidates cover layouts that later official builds adopted (0.14.0 ships
  // "out/main/index.js" and no "lib" at all), and each candidate is gated on a dependency that the
  // official bundle carries and the look-alike third-party shell does not.
  let mainEntry: string = rule.mainEntry
  let mainPresent = hasEntry(mainEntry)
  if (!mainPresent) {
    const dependencies = (manifest as { dependencies?: Record<string, unknown> }).dependencies
    for (const candidate of rule.mainEntryCandidates ?? []) {
      if (!hasEntry(candidate.entry)) continue
      if (candidate.requiresDependency !== undefined && dependencies?.[candidate.requiresDependency] === undefined) continue
      mainEntry = candidate.entry
      mainPresent = true
      break
    }
  }
  if (!mainPresent) {
    const foreign = Object.entries(rule.unsupportedMainEntries ?? {}).find(([entry]) => hasEntry(entry))
    if (foreign !== undefined) {
      return { ok: false, shell: 'third-party-shell', ...versionOf(manifest), reason: `${foreign[0]} instead of ${rule.mainEntry}: ${foreign[1]}; use DSH Web or DeepSeek Harness Desktop` }
    }
    return { ok: false, shell: 'official-unsupported', ...versionOf(manifest), reason: `${rule.mainEntry} is not present under ${archivePresent ? archive : appDir}` }
  }

  return {
    ok: true,
    root: installRoot,
    layout,
    mainEntry,
    packageName: name,
    ...typeof manifest.version === 'string' ? { version: manifest.version } : {},
  }
}
