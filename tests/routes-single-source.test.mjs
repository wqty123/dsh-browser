// Every plugin HTTP path has one home: `assets/browser-policy.mjs`.
//
// The same path used to be declared three ways — a constant in the module that served it, a second
// constant in the client that called it, and a raw literal in a `fetch()`. Renaming a route then
// meant finding all three, and the one that was missed failed at runtime as a 404 instead of at
// review time. These checks keep the single home honest.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const POLICY = 'assets/browser-policy.mjs'
const PREFIX = '/dsh-builtin-browser/'

/** Routes the host and the client must agree on; each must be exported by the policy module. */
const SHARED = [
  'GUEST_ROUTE',
  'OPEN_REQUEST_ROUTE',
  'SURFACE_DECL_ROUTE',
  'BRIDGE_ACTION_ROUTE',
  'HOST_PATCH_ROUTE',
  'AUTOMATIC_MAINTENANCE_ROUTE',
  'TAKEOVER_ROUTE',
  'WEB_SOURCE_ROUTE',
  'REFERENCE_LIST_ROUTE',
  'REFERENCE_EXPORT_ROUTE',
]

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (entry.name !== '__tests__' && entry.name !== 'fixtures') yield* sourceFiles(join(dir, entry.name))
    } else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      yield join(dir, entry.name)
    }
  }
}

/** Comments describe paths; only executable lines must import them. */
const isComment = line => /^\s*(?:\/\/|\*|\/\*)/.test(line)

test('src carries route paths only as policy imports, never as literals', () => {
  const offending = []
  for (const file of sourceFiles(join(ROOT, 'src'))) {
    const path = relative(ROOT, file).split(sep).join('/')
    readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (isComment(line)) return
      if (line.includes(PREFIX)) offending.push(`${path}:${index + 1} ${line.trim()}`)
    })
  }
  assert.deepEqual(offending, [], `import the path from ${POLICY} instead of spelling it out`)
})

test('every shared route is declared once in the policy module', () => {
  const policy = readFileSync(join(ROOT, POLICY), 'utf8')
  const exported = new Map([...policy.matchAll(/export const ([A-Z][A-Z0-9_]*ROUTE) = '([^']+)'/gu)].map(m => [m[1], m[2]]))
  for (const name of SHARED) assert.ok(exported.has(name), `${name} is exported by ${POLICY}`)
  for (const [name, value] of exported) {
    assert.ok(value.startsWith(PREFIX), `${name} stays under the plugin prefix (got ${value})`)
  }
  // One path per name and one name per path: a duplicate value means two constants will drift.
  const seen = new Map()
  for (const [name, value] of exported) {
    assert.equal(seen.get(value), undefined, `${name} duplicates the path of ${String(seen.get(value))}`)
    seen.set(value, name)
  }
})

test('policy paths end without a query or fragment', () => {
  // Callers append `?u=`/`?limit=`; a policy value that already carries a query cannot be reused.
  const policy = readFileSync(join(ROOT, POLICY), 'utf8')
  for (const [, name, value] of policy.matchAll(/export const ([A-Z][A-Z0-9_]*ROUTE) = '([^']+)'/gu)) {
    assert.doesNotMatch(value, /[?#]/u, `${name} is a bare path`)
  }
})
