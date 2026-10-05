// Guard the mistake class that cost three rounds and no other check caught.
//
// `String(await sendCdp(...))?.result?.value` stringifies the RESPONSE, so `.result` is undefined
// on a string and the reader returns undefined forever. In this file that meant the address-bar
// probe always answered "no bar", so the newTab path always clicked the launcher card and made a
// page that already existed — reported three times as "it keeps creating new browser entries".
//
// It passed `node --check`, the ownership suite, the boundary suite, and several readings. A
// scanner is the cheap way to keep it from coming back, and the rule is mechanical: a value taken
// out of a CDP reply must be read from the reply, not from its stringification.
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const src = readFileSync('desktop-bridge/plugin-browser-bridge.js', 'utf8')

test('no CDP reply is stringified before its value is read', () => {
  const offenders = []
  src.split('\n').forEach((line, index) => {
    // Comments describe the mistake; only code counts.
    const code = line.replace(/\/\/.*$/, '')
    if (/String\(\s*await\s+\w+\(/.test(code)) {
      offenders.push('L' + (index + 1) + ': ' + line.trim().slice(0, 88))
    }
  })
  assert.deepEqual(offenders, [],
    'these stringify a response object, so .result is undefined:\n' + offenders.join('\n'))
})

test('every reply value that drives a branch has a fallback', () => {
  // The reader functions in this file all end in `?? ''` or an equivalent, so a missing value
  // becomes a defined string instead of undefined. A branch on undefined silently takes the
  // false path forever, which is exactly what the address-bar probe did.
  const bare = []
  src.split('\n').forEach((line, index) => {
    const code = line.replace(/\/\/.*$/, '')
    if (!/\?\.result\?\.value/.test(code)) return
    // A bare read is fine when it is inside a ternary or a template literal, where the caller
    // handles undefined explicitly.
    const handled = /\?\?/.test(code) || /\?.*:/.test(code) || /`/.test(code)
    if (!handled) bare.push('L' + (index + 1) + ': ' + line.trim().slice(0, 88))
  })
  assert.deepEqual(bare, [],
    'these read a reply value with no fallback:\n' + bare.join('\n'))
})
