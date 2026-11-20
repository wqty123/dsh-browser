#!/usr/bin/env node
/**
 * Run the behaviour suite with one command: `node tests/run.mjs`.
 *
 * The suite imports the built `lib/*.js`, which in turn import `@deepseek-ai/*`. Inside this
 * monorepo those resolve to the vendored **TypeScript sources**, and Node's built-in type stripping
 * refuses the decorators they use (`@Remote`) — every test that touches them dies with
 * `SyntaxError: Invalid or unexpected token` before a single assertion runs. A loader that
 * transforms types solves it, so this finds one and runs the suite under it.
 *
 * Extra arguments are forwarded, so `node tests/run.mjs tests/delivery.test.mjs` runs one file.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkg = dirname(here)

/**
 * Locate a TypeScript loader capable of decorators.
 *
 * `tsx` is the one this monorepo already installs for its bundler, so it is preferred; `ts-node`'s
 * ESM loader is accepted as a fallback. Any failure is reported with what to install rather than
 * silently running the suite without type support (which would fail for the wrong reason).
 * @returns the module specifier to pass to `--import`.
 */
function findLoader() {
  const require = createRequire(join(pkg, 'package.json'))
  for (const name of ['tsx', 'ts-node/esm']) {
    try {
      const resolved = require.resolve(name)
      return pathToFileURL(resolved).href
    } catch { /* try the next one */ }
  }
  // pnpm keeps packages under `<repo>/node_modules/.pnpm/<name>@<version>/node_modules/<name>`.
  let dir = pkg
  for (let depth = 0; depth < 6; depth += 1) {
    const store = join(dir, 'node_modules', '.pnpm')
    if (existsSync(store)) {
      const match = readdirSync(store).filter(name => /^tsx@/.test(name)).sort().pop()
      if (match !== undefined) {
        for (const entry of ['dist/loader.mjs', 'dist/esm/index.mjs']) {
          const candidate = join(store, match, 'node_modules', 'tsx', entry)
          if (existsSync(candidate)) return pathToFileURL(candidate).href
        }
      }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

const loader = findLoader()
if (loader === undefined) {
  console.error('[tests] no TypeScript loader found. Install one (tsx) and retry:')
  console.error('[tests]   pnpm add -D tsx')
  process.exit(1)
}

const requested = process.argv.slice(2)
const files = requested.length > 0
  ? requested
  : readdirSync(here)
    .filter(name => name.endsWith('.test.mjs'))
    .sort()
    .map(name => join(here, name))

console.log(`[tests] loader: ${loader}`)
console.log(`[tests] files:  ${String(files.length)}`)

const result = spawnSync(process.execPath, ['--import', loader, '--test', ...files], {
  cwd: pkg,
  stdio: 'inherit',
  windowsHide: true,
})
process.exit(result.status ?? 1)
