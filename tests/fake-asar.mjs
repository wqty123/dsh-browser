// Fixtures for the two readers that must agree on what a DSH Desktop install is.
//
// A *shape* fixture is not enough any more (issue #40): `resources/app/lib/main.js` exists in every
// Electron app, and the archive is what Electron loads when both are present. So these helpers build
// the three things the tests need — a real (minimal) asar, an unpacked tree, and the same tree
// claiming somebody else's package name — and the tests compare bytes before and after.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Write a minimal but structurally valid asar archive.
 *
 * Layout the readers parse: an 8-byte outer pickle whose second u32 is the header-pickle size, the
 * header pickle (u32 JSON length, then JSON), then the file contents. Only single-file entries are
 * needed here; nested paths are folded into the tree.
 * @param archivePath - where to write the archive.
 * @param files - map of slash-separated path to string or Buffer contents.
 */
export function writeAsar(archivePath, files) {
  const tree = { files: {} }
  let content = Buffer.alloc(0)
  for (const [path, value] of Object.entries(files)) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8')
    let node = tree
    const parts = path.split('/')
    for (const part of parts.slice(0, -1)) {
      node.files[part] ??= { files: {} }
      node = node.files[part]
    }
    node.files[parts.at(-1)] = { size: bytes.length, offset: String(content.length) }
    content = Buffer.concat([content, bytes])
  }
  const json = Buffer.from(JSON.stringify(tree), 'utf8')
  const headerPickle = Buffer.alloc(8 + json.length)
  headerPickle.writeUInt32LE(4 + json.length, 0)
  headerPickle.writeUInt32LE(json.length, 4)
  json.copy(headerPickle, 8)
  const outer = Buffer.alloc(8)
  outer.writeUInt32LE(headerPickle.length, 0)
  outer.writeUInt32LE(headerPickle.length, 4)
  mkdirSync(dirname(archivePath), { recursive: true })
  writeFileSync(archivePath, Buffer.concat([outer, headerPickle, content]))
}

/** The shell entry body used by every fixture: parseable, with the trailing `export {};` the installer inserts before. */
export const MAIN_BODY = [
  '// a stand-in for the shell entry point',
  'const app = { whenReady: () => Promise.resolve() };',
  'app.whenReady().then(() => console.log("shell up"));',
  '',
  'export {};',
  '',
].join('\n')

/** A manifest that identifies the app, so a test can say "this is DSH" or "this is not". */
export function manifestFor(name, version = '0.2.1-rc.5') {
  return JSON.stringify({ name, version, main: 'lib/main.js' }, null, 2)
}

/**
 * An unpacked install tree.
 * @param options - package `name` and whether to include the shell entry.
 * @returns the install root.
 */
export function makeUnpackedInstall({ name = '@deepseek-ai/dsh-desktop', withMain = true, manifest = true, fixtureRoot = tmpdir() } = {}) {
  const root = mkdtempSync(join(fixtureRoot, 'dsh-install-'))
  const lib = join(root, 'resources', 'app', 'lib')
  mkdirSync(lib, { recursive: true })
  if (withMain) writeFileSync(join(lib, 'main.js'), MAIN_BODY)
  if (manifest) writeFileSync(join(root, 'resources', 'app', 'package.json'), manifestFor(name))
  return root
}

/**
 * A packed install tree: `resources/app.asar` plus nothing else, which is what the official Windows
 * build looks like.
 * @param options - package `name` put inside the archive, and whether to include the shell entry.
 * @returns the install root.
 */
export function makePackedInstall({ name = '@deepseek-ai/dsh-desktop', withMain = true, fixtureRoot = tmpdir() } = {}) {
  const root = mkdtempSync(join(fixtureRoot, 'dsh-install-packed-'))
  const files = { 'package.json': manifestFor(name) }
  if (withMain) files['lib/main.js'] = MAIN_BODY
  writeAsar(join(root, 'resources', 'app.asar'), files)
  return root
}
