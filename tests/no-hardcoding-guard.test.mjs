// Deployment- and build-specific literals must not come back into shipped code.
//
// Three kinds have bitten this plugin: a personal drive-letter path baked in as a default, a DOM lookup
// keyed on a CSS Modules class name that the host renames on every build, and a branch on a DSH version
// string. Each one works on the machine it was written on and breaks quietly everywhere else. The
// allowlist holds the exact lines that are knowingly kept; anything new fails here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCANNED = ['src', 'assets', 'desktop-bridge', 'browser-extension', 'dsh-host-patch', 'scripts', 'tools']
const SKIPPED_DIRS = new Set(['node_modules', '__tests__', 'fixtures'])
const CODE = /\.(?:ts|tsx|mts|cts|mjs|cjs|js)$/
const TEST_FILE = /\.(?:spec|test)\.[cm]?[jt]sx?$/

export const RULES = {
  'drive-letter path': /(?<![\w$])[A-Za-z]:(?:\\{1,2}|\/)[\w.%<>-]/,
  // A hashed class reads `.acoR2W_panel`: a mixed-case six-character prefix, then the local name.
  'CSS Modules class name': /\[class[*^$~|]?=|_tabStrip|_tabHost|\.(?=[A-Za-z0-9]{0,5}[a-z])(?=[A-Za-z0-9]{0,5}[A-Z0-9])[A-Za-z0-9]{6}_[a-z][\w-]*/,
  'version comparison': new RegExp([
    /(?:===?|!==?|<=?|>=?)\s*['"`]v?\d+\.\d+\.\d+(?:-[\w.]+)?['"`]/.source,
    /['"`]v?\d+\.\d+\.\d+(?:-[\w.]+)?['"`]\s*(?:===?|!==?|<=?|>=?)/.source,
    /\.startsWith\(\s*['"`]v?\d+\.\d+/.source,
    /\bsemver\.(?:lt|lte|gt|gte|eq|neq|satisfies|compare|cmp)\s*\(/.source,
    /\b(?:dsh|host|desktop|shell)\w*Version\b\s*(?:===?|!==?|<=?|>=?|\.startsWith|\.localeCompare)/.source,
  ].join('|'), 'i'),
}

/**
 * Lines kept on purpose, as `path: [rule, exact trimmed line]`.
 *
 * The DSH 0.2.2-rc.3 sidebar has no `data-sidebar-right-session` markers, so its tab strip is only
 * reachable by class: the settings panel keeps that one selector, and the deployed desktop bridge
 * (which cannot import it, and whose bytes are its version) carries the same lookup.
 */
const ALLOWED = {
  'src/client/settings/panel.ts': [
    ['CSS Modules class name', 'const LEGACY_TAB_STRIP_SELECTOR = "[class*=_tabStrip]"'],
  ],
  'desktop-bridge/plugin-browser-bridge.js': [
    ['CSS Modules class name', "const mine = Array.from(document.querySelectorAll('[class*=_tabStrip]')).find(el => sessionOf(el) === wanted);"],
    ['CSS Modules class name', "return mine.closest('[class*=_tabHost]') ?? mine.parentElement ?? mine;"],
  ],
}

function* sourceFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) yield* sourceFiles(join(dir, entry.name))
    } else if (CODE.test(entry.name) && !TEST_FILE.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      yield join(dir, entry.name)
    }
  }
}

function findings() {
  const found = []
  for (const top of SCANNED) {
    for (const file of sourceFiles(join(ROOT, top))) {
      const path = relative(ROOT, file).split(sep).join('/')
      readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
        for (const [rule, pattern] of Object.entries(RULES)) {
          if (pattern.test(line)) found.push({ path, line: index + 1, rule, text: line.trim() })
        }
      })
    }
  }
  return found
}

const allowed = ({ path, rule, text }) => (ALLOWED[path] ?? []).some(([r, line]) => r === rule && line === text)

test('the rules recognise what they forbid', () => {
  const cases = {
    'drive-letter path': ["const home = 'D:/dsh-home/settings.json'", 'const dir = "C:\\\\Users\\\\me"', '// C:\\Users\\me\\Downloads'],
    'CSS Modules class name': ['document.querySelector("[class*=_tabStrip]")', "el.closest('._tabHost')", "query('.acoR2W_panel')"],
    'version comparison': ["if (manifest.version === '0.2.2-rc.3')", "dshVersion < '0.2.3'", "if (version.startsWith('0.2'))", 'semver.gte(v, x)', 'if (hostVersion === wanted)'],
  }
  for (const [rule, lines] of Object.entries(cases)) {
    for (const line of lines) assert.ok(RULES[rule].test(line), `${rule} matches ${line}`)
  }
  for (const line of ["const url = 'http://127.0.0.1:9222/json'", "if (host === '127.0.0.1')", "/^[A-Za-z]:[\\\\/]/.test(path)", "item.version === manifest.version", 'const evidence = process.env.NATIVE_SLOT_EVIDENCE']) {
    assert.equal(Object.values(RULES).some(rule => rule.test(line)), false, `no rule matches ${line}`)
  }
})

test('shipped code carries no drive-letter paths, CSS Modules class names or version branches', () => {
  const offending = findings().filter(finding => !allowed(finding)).map(({ path, line, rule, text }) => `${path}:${line} [${rule}] ${text}`)
  assert.deepEqual(offending, [], 'use a configured path, a stable data-* attribute or protocol, or a capability check')
})

test('every allowlisted line still exists, so the allowlist cannot outlive its reason', () => {
  const present = findings()
  const stale = Object.entries(ALLOWED).flatMap(([path, entries]) => entries
    .filter(([rule, text]) => !present.some(found => found.path === path && found.rule === rule && found.text === text))
    .map(([rule, text]) => `${path} [${rule}] ${text}`))
  assert.deepEqual(stale, [])
})
