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
interface IdentityRule {
  readonly packageNames: readonly string[]
  readonly mainEntry: string
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
}

/** A verified install. */
export interface DesktopIdentity {
  readonly ok: true
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
    return { packageNames: names, mainEntry: main }
  } catch (error) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      return FALLBACK_RULE
    }
    return { error: `desktop-identity.json could not be read: ${String(error)}` }
  }
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
  const resources = join(installRoot, 'resources')
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
  let mainPresent: boolean
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
    mainPresent = entryAt(parsed.header.files, rule.mainEntry) !== undefined
  } else {
    const manifestPath = join(appDir, 'package.json')
    try {
      manifestText = readFileSync(manifestPath, 'utf8')
    } catch (error) {
      console.error(`[dsh-browser] cannot read the package manifest at ${manifestPath}: ${String(error)}`)
      return { ok: false, reason: `${manifestPath} is missing; a directory without a package manifest is not a DSH Desktop install` }
    }
    mainPresent = existsSync(join(appDir, ...rule.mainEntry.split('/')))
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

  // The main entry is the file the installer patches and the shell runs; if it is not there, this
  // is not an install this plugin can reason about even though the manifest looks right.
  if (!mainPresent) {
    return { ok: false, reason: `${rule.mainEntry} is not present under ${archivePresent ? archive : appDir}` }
  }

  return {
    ok: true,
    root: installRoot,
    layout,
    packageName: name,
    ...typeof manifest.version === 'string' ? { version: manifest.version } : {},
  }
}
