// The bridge is a script the shell loads once at boot; if it does not parse, the bridge never
// starts and every browser call fails with a connection error.
//
// This exists because I broke it four times in one session the same way: writing a comment that
// quotes a name or a regex with backticks, inside one of the file's `expression: \`...\``
// templates. The template ended early and the file stopped parsing.
//
// Two attempts to build a more targeted check were made and both were deleted, which is worth
// recording so nobody rebuilds them:
//
//   - a scanner for a backtick inside a template, shape-based: false-positive on a one-line
//     template (`expression: \`(${...}) !== null\``), which closes on its own line, so every later
//     comment read as a violation;
//   - the same scanner, parity-based: a single stray backtick reads as a CLOSE, so it went blind —
//     verified by injection, after which it reported zero offenders;
//   - and a "prove the parser always catches it" test, which could not be made to hold: injecting
//     the quoted-name shape at the natural place still parsed, because what follows the dangling
//     backtick happened to be valid. A test that cannot fail reliably is not a test.
//
// What remains is the real parser. It caught all four of my mistakes, and it cannot both miss and
// misfire the way a heuristic can.
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import assert from 'node:assert/strict'

test('the bridge file parses', () => {
  try {
    execFileSync(process.execPath, ['--check', 'desktop-bridge/plugin-browser-bridge.js'], { stdio: 'pipe' })
  } catch (error) {
    const detail = String(error.stderr ?? error.message).split('\n').slice(0, 6).join('\n')
    assert.fail('desktop-bridge/plugin-browser-bridge.js does not parse:\n' + detail)
  }
})
