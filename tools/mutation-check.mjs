// Are the guards actually guarding?
//
// A test that passes on a broken implementation proves nothing — and this session's most expensive
// mistakes were exactly that kind. The ownership suite was green while sessions drove each other's
// pages, because it exercised the allocation path and the code took the reuse path. Green suites
// over wrong behaviour are the failure mode to fear here, not red ones.
//
// So: each fix is reverted in turn, and the suite must FAIL. A revert that slips through means that
// fix is not covered, which is worth knowing before a restart is spent on it.
//
//   node tools/mutation-check.mjs
//
// The edited file is restored in a finally block; a crash must not leave the bridge broken, and
// the run exits non-zero if any mutant survives.
import { readFileSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'


// A tool, not a test. `node --test` executes every file it is given, and this one runs on
// purpose — it talks to the live bridge, or edits the source. Node's test runner sets
// NODE_TEST_CONTEXT for the child it spawns for each file, so that is the signal. A test that
// needs to run this tool for real spawns it with the variable cleared.
if (process.env.NODE_TEST_CONTEXT !== undefined) {
  process.exit(0)
}

const BRIDGE = 'desktop-bridge/plugin-browser-bridge.js'
const HOST = 'src/browser-electron/desktop-bridge-host.ts'

/** Each fix, the revert that undoes it, and the test file that must notice. */
const MUTATIONS = [
  {
    name: 'reuse ignores the owner ledger',
    file: BRIDGE,
    patch: (src) => src.replace(
      /let reuseId = request\.newTab === true \? undefined : \[\.\.\.claims\.entries\(\)\]\s*\n\s*\.find\(\(\[guest, holder\]\) => holder === owner && guestById\(guest\) !== undefined\)\?\.\[0\]/,
      'let reuseId = request.newTab === true ? undefined : [...claims.entries()][0]?.[0]',
    ),
    expect: 'bridge-ownership',
  },
  {
    name: 'list returns every guest regardless of owner',
    file: BRIDGE,
    patch: (src) => src.replace(
      /const mineOrFree = all\.filter\(g => g\.type !== 'webview' \|\| !claims\.has\(g\.id\) \|\| claims\.get\(g\.id\) === owner\)/,
      'const mineOrFree = all',
    ),
    expect: 'bridge-ownership',
  },
  {
    name: 'showTab does not check ownership',
    file: BRIDGE,
    patch: (src) => src.replace(
      /if \(claims\.has\(viewId\) && claims\.get\(viewId\) !== owner\) \{\s*\n\s*throw new Error\(`showTab: guest \$\{viewId\} belongs to another session`\)\s*\n\s*\}/,
      '',
    ),
    expect: 'bridge-ownership',
  },
  {
    name: 'closeSidebarBrowser does not bound by owner',
    file: BRIDGE,
    patch: (src) => src.replace(
      /\.filter\(contents => claims\.get\(contents\.id\) === owner\)/,
      '.filter(contents => true)',
    ),
    expect: '',
  },
  {
    name: 'the card click loses its once-per-call bound',
    file: BRIDGE,
    patch: (src) => src.replace(/const created = cardClicked \|\| addressBarAlready/, 'const created = false'),
    expect: 'bridge-card-clicks',
  },
  {
    name: 'guestFor stops asking for a new tab',
    file: HOST,
    patch: (src) => src.replace('const needsNewTab = this.views.size > 0', 'const needsNewTab = false'),
    expect: 'session-invariants',
  },
  {
    name: 'the reply-shape mistake returns',
    file: BRIDGE,
    patch: (src) => src.replace('String((await sendCdp', 'String(await sendCdp'),
    expect: 'bridge-reply-shape',
  },
]

/** @returns whether the named test file still passes. */
function passes (name) {
  const glob = name === '' ? 'tests/*.test.mjs' : 'tests/' + name + '.test.mjs'
  try {
    execFileSync(process.execPath, ['--test', glob], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

let uncovered = 0
console.log('  revert each fix; the suite must notice')
console.log('')
for (const mutation of MUTATIONS) {
  const original = readFileSync(mutation.file, 'utf8')
  const patched = mutation.patch(original)
  if (patched === original) {
    console.log('  SKIP   ' + mutation.name + '  (the pattern no longer matches — update this list)')
    continue
  }
  writeFileSync(mutation.file, patched)
  try {
    if (passes(mutation.expect)) {
      uncovered += 1
      console.log('  MISS   ' + mutation.name + '  — reverting it changed no test result')
    } else {
      console.log('  ok     ' + mutation.name + '  — caught by ' + (mutation.expect || 'the suite'))
    }
  } finally {
    writeFileSync(mutation.file, original)
  }
}
console.log('')
console.log(uncovered === 0
  ? '  every fix is covered: reverting any one of them fails a test'
  : '  ' + String(uncovered) + ' fix(es) are NOT covered by any test')
process.exit(uncovered === 0 ? 0 : 1)
