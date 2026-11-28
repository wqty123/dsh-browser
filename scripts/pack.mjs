/**
 * Pack this plugin for consumers: build, stage the publish-form manifest, verify the runtime shape,
 * then `npm pack`.
 *
 * WHY THIS EXISTS
 * A hand-picked staging directory is how the 1.0.3 publish shipped WITHOUT `browser-extension/`:
 * `native-host/install.mjs` imports `../browser-extension/constants.mjs`, so every native-host
 * registration failed with ERR_MODULE_NOT_FOUND on a real desktop install. The `files` field in
 * package.json already lists everything a consumer needs; this script copies the checkout, lets
 * `files` govern the tarball, and refuses to pack when a consumer-critical path is missing.
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stagePublishManifest } from './publish-manifest.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))

/** Paths a consumer install must contain, relative to the package root. */
export const CONSUMER_PATHS = [
  'lib/index.js',
  'lib/client.js',
  'lib/browser/runtime.js',
  'lib/browser-electron/entry.js',
  'lib/tool-browser/index.js',
  'lib/startpage.js',
  'cordis.patch.yml',
  // native-host/install.mjs imports this; a tarball without it cannot register the extension.
  'browser-extension/constants.mjs',
  'native-host/install.mjs',
  'desktop-bridge/install.mjs',
]

/** Directories never copied into a staged package. */
const EXCLUDED = new Set(['node_modules', '.git', '.dsh-sdk-types', 'dist'])

/**
 * Copy the checkout into a staging directory.
 * @param root - the checkout.
 * @param target - the staging directory.
 */
export function copyCheckout(root, target) {
  cpSync(root, target, {
    recursive: true,
    force: true,
    filter: source => {
      const relative = source.slice(root.length).replace(/^[\\/]/u, '')
      const head = relative.split(/[\\/]/u)[0]
      return head === '' || !EXCLUDED.has(head)
    },
  })
  rmSync(join(target, 'lib', '__tests__'), { recursive: true, force: true })
}

/**
 * Fail when the staged tree is missing something a consumer runtime needs.
 * @param target - the staging directory.
 * @returns the missing paths.
 */
export function missingConsumerPaths(target) {
  return CONSUMER_PATHS.filter(path => !existsSync(join(target, path)))
}

/**
 * Build and pack.
 * @param options - build first (default true) and where to put the tarball.
 * @returns the tarball path.
 */
export function pack(options = {}) {
  if (options.build !== false) {
    const build = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: ROOT, stdio: 'inherit' })
    if ((build.status ?? 1) !== 0) throw new Error('build failed; nothing was packed')
  }
  const staging = mkdtempSync(join(tmpdir(), 'dsh-browser-pack-'))
  try {
    copyCheckout(ROOT, staging)
    const manifest = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
    const { manifest: staged } = stagePublishManifest(manifest)
    writeFileSync(join(staging, 'package.json'), `${JSON.stringify(staged, null, 2)}\n`, 'utf8')
    const missing = missingConsumerPaths(staging)
    if (missing.length > 0) throw new Error(`staged package is missing ${missing.join(', ')}`)
    const packed = spawnSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['pack', '--json'], { cwd: staging, encoding: 'utf8', shell: process.platform === 'win32' })
    if ((packed.status ?? 1) !== 0) throw new Error(`npm pack failed: ${packed.stderr ?? packed.stdout ?? ''}`)
    const report = JSON.parse(packed.stdout)
    const filename = report[0]?.filename
    if (filename === undefined) throw new Error('npm pack reported no filename')
    const destination = resolve(options.outDir ?? ROOT, filename)
    cpSync(join(staging, filename), destination)
    return destination
  } finally { rmSync(staging, { recursive: true, force: true }) }
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  const tarball = pack({ build: !process.argv.includes('--no-build') })
  console.log(`[pack] ${tarball}`)
}
