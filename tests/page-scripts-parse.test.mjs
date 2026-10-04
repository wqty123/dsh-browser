// Every page script must parse — checked as a list, not as a side effect of some behaviour.
//
// WHY THIS FILE EXISTS
//
// A page script here is a template string that runs inside the browser. TypeScript cannot see
// inside it, so a syntax error ships silently and only shows up when a tool is called: that
// happened once, and `browser_content` was broken for all four of its formats until someone
// noticed.
//
// The existing guard drove click/type/setValue and parsed whatever those paths happened to
// emit — four of the sixteen scripts at most, and nothing at all for the cursor, the download
// path, or the bridge. A script whose only caller is rare was never parsed.
//
// This walks the sources instead, extracts every template that looks like a page script, and
// parses all of them. It does not check that they work; only that they are syntactically
// valid, which is the failure mode the compiler cannot catch.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { Script } from 'node:vm'

/**
 * Extract every template literal from a source file that is invoked as a script.
 *
 * Backticks are matched with their `${...}` substitutions balanced, because a page script is
 * built by interpolating constants into it — a naive scan stops at the first inner backtick
 * and reports a syntax error that is really a truncation.
 * @param source - the file's text.
 * @returns the script bodies found, with the line each starts on.
 */
function extractScripts(source) {
  const found = []
  for (let i = 0; i < source.length; i++) {
    if (source[i] !== '`') continue
    const line = source.slice(0, i).split('\n').length
    let body = ''
    let j = i + 1
    let closed = false
    while (j < source.length) {
      const ch = source[j]
      if (ch === '\\') {
        // Decode the template escape rather than copying it. The source writes `\\/` inside a
        // regular expression, which reaches the browser as `\/`; keeping the doubled form makes
        // the backslash escape a backslash and ends the regex early, so the rest of it is read
        // as flags and the parse fails on a script that is perfectly valid. Modelling the
        // escape is what makes this a check on the script rather than on its spelling.
        const next = source[j + 1]
        if (next === 'n') body += '\n'
        else if (next === 't') body += '\t'
        else if (next === 'r') body += '\r'
        else if (next === '`' || next === '$' || next === '\\') body += next
        else body += ch + (next ?? '')
        j += 2
        continue
      }
      if (ch === '`') {
        closed = true
        break
      }
      if (ch === '$' && source[j + 1] === '{') {
        // Copy the substitution verbatim, balancing braces so `}` inside it does not end it.
        let depth = 0
        let k = j + 1
        while (k < source.length) {
          if (source[k] === '{') depth++
          else if (source[k] === '}') {
            depth--
            if (depth === 0) {
              k++
              break
            }
          }
          k++
        }
        // A substituted constant cannot be resolved here, so stand in for it with an
        // identifier: it is legal inside a regular expression, inside a string, and as a value,
        // which a number or a quoted string would not all be.
        body += 'x'
        j = k
        continue
      }
      body += ch
      j++
    }
    if (closed) found.push({ body, line })
    i = j
  }
  return found
}

/** True for a template that is meant to be executed as a script rather than used as text. */
function looksLikeScript(body) {
  const trimmed = body.trim()
  return trimmed.startsWith('(() =>') || trimmed.startsWith('(async () =>') || trimmed.startsWith('async () =>')
}

/**
 * Wrap a body the way the caller would, so `return` at the top level is legal.
 * The callers either hand the body to CDP as an expression or wrap it in a Function; wrapping
 * it here is the more permissive of the two and is what a parse check should use, because a
 * body that only parses as an expression is still a body that cannot be a syntax error.
 * @param body - the template's contents.
 * @returns something whose parse failure means the body itself is malformed.
 */
function wrap(body) {
  return `void (${body.trim()})`
}

const SOURCES = [
  ['src/browser-electron/provider.ts', 'the provider’s page scripts'],
  ['src/browser-electron/host-main.ts', 'the toolbar and download scripts'],
  ['src/browser-electron/virtual-cursor.ts', 'the cursor script'],
  ['desktop-bridge/plugin-browser-bridge.js', 'the sidebar bridge’s scripts'],
]

test('every page script in the sources parses', () => {
  let checked = 0
  const failures = []

  for (const [path, label] of SOURCES) {
    let source
    try {
      source = readFileSync(path, 'utf8')
    } catch {
      failures.push(`${path}: could not be read`)
      continue
    }
    for (const { body, line } of extractScripts(source)) {
      if (!looksLikeScript(body)) continue
      checked++
      try {
        new Script(wrap(body))
      } catch (error) {
        failures.push(`${label} — ${path}:${line}: ${error.message}`)
      }
    }
  }

  assert.ok(checked > 0, 'the scan found no scripts at all, which means it is broken rather than that they are fine')
  assert.deepEqual(failures, [], `${failures.length} script(s) do not parse:\n${failures.join('\n')}`)
})

test('the scan actually finds the scripts it claims to cover', () => {
  // A guard against the guard: if a refactor renames the files or changes how scripts are
  // written, this test failing is the signal that the scan above became a no-op rather than a
  // pass.
  const provider = readFileSync('src/browser-electron/provider.ts', 'utf8')
  const found = extractScripts(provider).filter(entry => looksLikeScript(entry.body))
  assert.ok(
    found.length >= 5,
    `expected several page scripts in provider.ts, found ${found.length} — the extraction is probably broken`,
  )
})
