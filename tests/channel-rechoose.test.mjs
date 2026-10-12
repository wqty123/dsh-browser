// `browser.channel` is read live everywhere else, but the carrier was chosen once.
//
// The settings route stores the value and answers `ok`, the settings file is re-read on every
// call, and the one thing a caller cannot tell apart from a working write is a write that stored a
// value nothing will ever read. Reported with a reproduction that measured it: after editing the
// channel the browser stayed the bundled Electron one, and only a DSH restart produced the Edge
// the setting named.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { resolveSettings } from '../lib/browser-electron/settings-store.js'

const entrySource = () => readFileSync(new URL('../src/browser-electron/entry.ts', import.meta.url), 'utf8')

test('a mistyped channel is reported, not silently replaced by the default', () => {
  const complaints = []
  const resolved = resolveSettings({ browser: { channel: 'edgeee' } }, message => complaints.push(message))

  assert.equal(resolved.browser.channel, 'bundled', 'the value is still coerced')
  assert.equal(complaints.length, 1, 'but never quietly')
  assert.match(complaints[0] ?? '', /edgeee/, 'the message quotes what was written')
  assert.match(complaints[0] ?? '', /chrome, edge, auto, bundled, sidebar/,
    'and lists what would have been accepted')
})

test('a channel that is absent is the ordinary case, not a mistake', () => {
  // Most documents never mention it. Reporting those would train people to ignore the warning.
  const complaints = []
  resolveSettings({ browser: {} }, message => complaints.push(message))
  resolveSettings({}, message => complaints.push(message))
  assert.deepEqual(complaints, [], 'an unset channel says nothing')
})

test('a valid channel says nothing at all', () => {
  const complaints = []
  const resolved = resolveSettings({ browser: { channel: 'edge' } }, message => complaints.push(message))
  assert.equal(resolved.browser.channel, 'edge')
  assert.deepEqual(complaints, [])
})

test('the carrier choice is re-runnable, and a second run is not refused', () => {
  const source = entrySource()

  // The choice lives in a function, because a write that changes the channel has to be able to
  // run it again.
  assert.match(source, /const chooseCarrier = \(\): void => \{/,
    'the carrier choice is a function')
  assert.match(source, /installSettingsRoute\(ctx, settings, \(\) => \{ chooseCarrier\(\) \}\)/,
    'and the settings route is wired to re-run it')

  // The one-shot guard would make that re-run a no-op, which is the bug in a new costume. It now
  // releases the previous carrier instead of refusing the new one.
  assert.match(source, /const previous = adoptedCarrier/, 'a replaced carrier is remembered')
  assert.match(source, /previous\.dispose\?\.\(\)/, 'and released')
  assert.doesNotMatch(source, /if \(upgraded\) \{ host\.dispose\?\.\(\); return \}/,
    'the refusal that made the first choice final is gone')
})

test('the settings response distinguishes applied from merely stored', () => {
  const source = entrySource()
  assert.match(source, /const channelChanged = updated\.browser\.channel !== before/,
    'a changed channel is noticed')
  assert.match(source, /channelChanged \? \{ carrierRechosen: true \} : \{\}/,
    'and reported back, so ok never means "stored and ignored"')
})

test('a surface whose carrier comes from its composition says the setting cannot apply', () => {
  // On the desktop shell the carrier is supplied by the composition, so the setting is outranked.
  // That is a legitimate outcome; leaving it unsaid is what makes it look like a bug elsewhere.
  const source = entrySource()
  assert.match(source, /browser\.channel is "\$\{asked\}", but this surface's carrier was/,
    'the mismatch is reported rather than passed over')
})
