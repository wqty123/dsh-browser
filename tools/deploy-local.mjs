// Deploy this plugin into a profile that links the directory directly.
//
// WHY THIS EXISTS
// A directory link (`link:./plugins/...`) is not an npm install: pnpm never applies `publishConfig`,
// so the package keeps its development `exports` — `./client` → `./src/client/index.ts`. The host's
// client-module service reads `exports`, serves that TypeScript file to the browser, and the browser
// cannot execute it: the plugin never calls `__ModuleLoader__.load`, the settings section stays on
// its skeleton, and the host logs `loaded without registering`. Publishing through npm does not hit
// this because the registry applies `publishConfig`.
//
// So a local deploy has to write the publish-form manifest itself, and then prove the installed tree
// resolves the way the host will read it.
import { cpSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Files and directories that belong to the checkout, not to an install. */
const CHECKOUT_ONLY = new Set(['node_modules', '.git', '.github', '.dsh-sdk-types', 'tests', 'dist', '.deploy-stage'])

/**
 * The manifest an installed directory must carry: development `exports` replaced by the publish
 * ones, everything else untouched.
 *
 * `publishConfig.exports` is the single source of the mapping — the same map npm would apply — so a
 * new subpath never has to be added here as well.
 * @param manifest - the package manifest as committed.
 * @returns the manifest to write into the installed directory.
 */
export function stageManifest(manifest) {
  const publish = manifest.publishConfig?.exports
  if (publish === undefined || typeof publish !== 'object') {
    throw new Error('package.json has no publishConfig.exports: nothing to stage for a directory install')
  }
  return { ...manifest, exports: structuredClone(publish) }
}

/**
 * Resolve every export the way Node and the host's client service will, against the installed tree.
 * @param target - the installed plugin directory.
 * @param manifest - the manifest written into it.
 * @returns the resolved paths, relative to `target`.
 */
export function resolveStagedExports(target, manifest) {
  const resolved = {}
  for (const [subpath, specifier] of Object.entries(manifest.exports)) {
    if (subpath === './package.json') continue
    if (typeof specifier !== 'string' || !specifier.startsWith('./')) {
      throw new Error(`export ${subpath} is not a relative file: ${String(specifier)}`)
    }
    const path = resolve(target, specifier)
    if (!existsSync(path) || !statSync(path).isFile()) {
      throw new Error(`export ${subpath} points at a missing file: ${specifier}`)
    }
    resolved[subpath] = specifier
  }
  return resolved
}

/**
 * The browser half must be an executable `__ModuleLoader__` envelope, never a TypeScript source.
 * @param target - the installed plugin directory.
 * @param manifest - the manifest written into it.
 * @returns the size of the served client bundle.
 */
export function assertClientEnvelope(target, manifest) {
  const specifier = manifest.exports['./client']
  if (specifier !== './lib/client.js') {
    throw new Error(`./client must resolve to ./lib/client.js for a directory install (got ${String(specifier)})`)
  }
  const source = readFileSync(resolve(target, specifier), 'utf8')
  if (/^\s*(?:import|export)\s+type\b/mu.test(source.slice(0, 4000))) {
    throw new Error('./lib/client.js looks like TypeScript source, not a built bundle')
  }
  if (!source.includes('__ModuleLoader__')) {
    throw new Error('./lib/client.js does not carry the __ModuleLoader__ envelope the host expects')
  }
  return Buffer.byteLength(source, 'utf8')
}

/**
 * Copy the package into `target`, keeping the installed `node_modules` that the profile owns.
 * @param root - the checkout to copy from.
 * @param target - the installed plugin directory.
 */
export function copyPackage(root, target) {
  cpSync(root, target, {
    recursive: true,
    force: true,
    filter: source => {
      const name = source.slice(root.length).replace(/^[\\/]/u, '').split(/[\\/]/u)[0]
      return name === '' || !CHECKOUT_ONLY.has(name)
    },
  })
  rmSync(join(target, 'dist'), { recursive: true, force: true })
}

/**
 * Build, stage, copy and verify.
 * @param options - target directory and whether to rebuild first.
 * @returns a one-line summary of the installed package.
 */
export function deploy(options = {}) {
  const home = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
  const target = resolve(options.target ?? join(home, 'profiles', 'web', 'plugins', 'dsh-builtin-browser'))
  if (options.build !== false) {
    const build = spawnSync(process.execPath, ['scripts/build.mjs'], { cwd: ROOT, stdio: 'inherit' })
    if ((build.status ?? 1) !== 0) throw new Error('build failed; nothing was installed')
  }
  const staged = stageManifest(JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')))
  copyPackage(ROOT, target)
  writeFileSync(join(target, 'package.json'), `${JSON.stringify(staged, null, 2)}\n`, 'utf8')
  const resolved = resolveStagedExports(target, staged)
  const bytes = assertClientEnvelope(target, staged)
  return { target, version: staged.version, clientBytes: bytes, resolved }
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (invokedDirectly) {
  const targetIndex = process.argv.indexOf('--target')
  const target = targetIndex === -1 ? undefined : process.argv[targetIndex + 1]
  const result = deploy({ target, build: !process.argv.includes('--no-build') })
  console.log(`[deploy] ${result.version} -> ${result.target}`)
  console.log(`[deploy] ./client = ${result.resolved['./client']} (${Math.round(result.clientBytes / 1024)} KB, __ModuleLoader__ envelope)`)
  console.log('[deploy] exports verified: ' + Object.entries(result.resolved).map(([subpath, specifier]) => `${subpath}=${specifier}`).join(' '))
}
