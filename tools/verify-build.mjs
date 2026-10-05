// Is every TypeScript change actually built into lib/?
//
// The plugin loads from `lib/`, which is COMPILED from `src/`. A source edit that was never
// compiled means a restart runs the OLD behaviour — and the acceptance run then looks like a
// failure of the new code, sending the next hour after a bug that is not there. This is the
// cheapest possible guard against misreading your own evidence.
//
// Run before every restart:  node tools/verify-build.mjs
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

/** @returns every .ts file under a directory. */
function walk (dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) walk(full, out)
    else if (entry.name.endsWith('.ts')) out.push(full)
  }
  return out
}

const sources = walk('src')
const stale = []
const missing = []
for (const source of sources) {
  // A declaration file has no build output; it is types only.
  if (source.endsWith('.d.ts')) continue
  const rel = relative('src', source).replace(/\.ts$/, '.js')
  const built = join('lib', rel)
  if (!existsSync(built)) { missing.push(rel); continue }
  if (statSync(source).mtimeMs > statSync(built).mtimeMs + 1000) stale.push(rel)
}

console.log('  sources checked: ' + String(sources.length))
if (missing.length > 0) {
  console.log('  NO BUILD OUTPUT (' + String(missing.length) + '):')
  for (const m of missing.slice(0, 10)) console.log('    ' + m)
}
if (stale.length > 0) {
  console.log('  STALE — the source is newer than its build, so the old code would run:')
  for (const s of stale.slice(0, 10)) console.log('    ' + s)
}
if (missing.length === 0 && stale.length === 0) {
  console.log('  ok   every source is older than its build output — a restart loads this code')
}

// And name the files this work touched, with what they should contain.
const CHECKS = [
  ['browser-electron/desktop-bridge-host.js', /needsNewTab/, 'asks for a new tab from the second view'],
  ['browser-electron/settings-route.js', /Mozilla\\\/5/, 'admits the desktop panel by user-agent + accept-language'],
]
console.log('')
for (const [file, pattern, what] of CHECKS) {
  const full = join('lib', file)
  if (!existsSync(full)) { console.log('  MISSING  ' + file); continue }
  const text = readFileSync(full, 'utf8')
  console.log('  ' + (pattern.test(text) ? 'ok  ' : 'OLD ') + file + '  (' + what + ')')
}

// The profile reaches the plugin through a link: confirm it resolves to THIS build.
const linked = 'D:/dsh-home/profiles/desktop/node_modules/dsh-builtin-browser/lib/browser-electron/desktop-bridge-host.js'
if (existsSync(linked)) {
  const same = readFileSync(join('lib', 'browser-electron/desktop-bridge-host.js'), 'utf8') === readFileSync(linked, 'utf8')
  console.log('')
  console.log('  the desktop profile resolves to this same file: ' + String(same))
}

process.exit(missing.length === 0 && stale.length === 0 ? 0 : 1)
