// A DSH 0.2.3 host loads plugin sources with Node's strip-only type stripping.
//
// Strip-only removes type annotations but performs no syntax transforms, so a TypeScript
// parameter property (`constructor(private readonly x: T)`) — which is syntax, not a type —
// throws `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` and the whole plugin fails to load. That is how
// the plugin broke on 0.2.3-alpha.2: the renderer logged the error for `web-sources.ts` and
// `settings-store.ts` and nothing else came up.
//
// This test asks Node itself, for every `.ts` source, whether it survives strip-only mode, so
// the rewrite cannot regress without a failing test. `.tsx` is excluded on purpose: strip-only
// does not handle JSX at all, so its failure would be a false positive.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripTypeScriptTypes } from 'node:module'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Every `.ts` file under `src`, excluding declarations. */
function sources(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...sources(full))
    else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) out.push(full)
  }
  return out
}

test('every .ts source survives strip-only type stripping (what a DSH 0.2.3 host does)', () => {
  const failures = []
  const files = sources(join(ROOT, 'src'))
  assert.ok(files.length > 50, `expected the plugin sources to be found, got ${files.length}`)
  for (const file of files) {
    try {
      stripTypeScriptTypes(readFileSync(file, 'utf8'), { mode: 'strip' })
    } catch (error) {
      failures.push(`${relative(ROOT, file)}: ${error.message.split('\n')[0]}`)
    }
  }
  assert.deepEqual(
    failures,
    [],
    'these sources cannot be loaded on a strip-only host; write the field and assign it in the '
    + 'constructor body instead of using a parameter property',
  )
})
