// The bridge is a script the shell loads once at boot; if it does not parse, the bridge never
// starts and every browser call fails with a connection error.
//
// This exists because I broke it three times in one session in the same way: writing a comment
// that quotes a regex or a parameter name with backticks, inside one of the file's many
// `expression: \`...\`` templates. Each time the template ended early and the file stopped
// parsing. `node --check` catches it in one line, which is the point — it is the JS parser, not a
// hand-rolled scanner.
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

test('no backtick appears inside an evaluated page script', async () => {
  // Deliberately narrow: only the lines BETWEEN `expression: \`` and its closing `})()\``, which
  // is the region where a stray backtick ends the template. A general scanner produces false
  // positives on the file's ordinary backticks, as my first attempt did.
  const fs = await import('node:fs')
  const source = fs.readFileSync('desktop-bridge/plugin-browser-bridge.js', 'utf8')
  const tick = String.fromCharCode(96)
  const lines = source.split('\n')
  const offenders = []
  let open = false
  let openedAt = 0
  lines.forEach((line, index) => {
    if (!open && line.includes('expression: ' + tick)) { open = true; openedAt = index + 1; return }
    if (!open) return
    if (line.includes('})()' + tick) || line.includes('})()' + tick + ',')) { open = false; return }
    if (line.includes(tick)) offenders.push('L' + (index + 1) + ' (template at L' + openedAt + '): ' + line.trim().slice(0, 64))
  })
  assert.deepEqual(offenders, [], 'a backtick inside a template ends it early:\n' + offenders.join('\n'))
})
