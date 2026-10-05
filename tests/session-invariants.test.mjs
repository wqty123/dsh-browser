// The invariants of this session's fixes, re-derived from the code.
//
// Ten rounds passed without a restart, each finding something. That cannot go on: a process that
// always finds one more bug is not converging. So the invariants the fixes were meant to establish
// are written down here, and this suite fails the moment one of them stops holding — which is a
// different question from "is every line correct", and the one that says when to stop reading and
// start testing against the real thing.
//
// Each was broken at least once. The point is that they cannot break silently again.
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const bridge = readFileSync('desktop-bridge/plugin-browser-bridge.js', 'utf8')
const host = readFileSync('src/browser-electron/desktop-bridge-host.ts', 'utf8')

/** The bridge's ops, with the line each starts on. */
function ops () {
  const found = []
  bridge.split('\n').forEach((line, i) => {
    const m = /if \(op === '([a-zA-Z]+)'\)/.exec(line)
    if (m) found.push({ name: m[1], line: i + 1 })
  })
  return found
}

test('every guest-touching op consults the owner ledger', () => {
  const lines = bridge.split('\n')
  const offenders = []
  const list = ops()
  list.forEach((op, k) => {
    const end = k + 1 < list.length ? list[k + 1].line - 1 : lines.length
    const body = lines.slice(op.line - 1, end).join('\n')
    if (!/getType\(\) === 'webview'/.test(body)) return
    const uses = /claims\.get\([^)]*\) === owner/.test(body)
      || /claims\.set\([^)]*owner\)/.test(body)
      || /!claims\.has\([^)]*\)/.test(body)
      || /mineOrFree/.test(body)
      || /unclaimed\(/.test(body)
    if (!uses) offenders.push(op.name)
  })
  assert.deepEqual(offenders, [], 'these ops touch guests without asking who is asking: ' + offenders.join(', '))
})

test('the launcher card is bounded to one click per call', () => {
  const clickSites = (bridge.match(/card\.click\(\)/g) ?? []).length
  const guards = (bridge.match(/cardClicked/g) ?? []).length
  assert.equal(clickSites, 2, 'two routes may click the card; that is why a guard is required')
  assert.ok(guards >= 3, 'the guard must be declared, set, and checked — ' + String(guards) + ' mentions')
})

test('no CDP reply is stringified before its value is read', () => {
  const offenders = bridge.split('\n')
    .map((line, i) => ({ line: i + 1, code: line.replace(/\/\/.*$/, '') }))
    .filter(entry => /String\(\s*await\s+\w+\(/.test(entry.code))
  assert.deepEqual(offenders.map(o => 'L' + o.line), [],
    'String() on a response leaves .result undefined, so the reader answers undefined forever')
})

test('shellPrepareSidebar has exactly one call site', () => {
  const calls = (bridge.match(/expression: shellPrepareSidebar\(\)/g) ?? []).length
  assert.equal(calls, 1, 'it clicks the launcher card, so the newTab path must not reach it')
})

test('guest allocation claims what it returns', () => {
  const claims = (bridge.match(/claims\.set\(/g) ?? []).length
  assert.ok(claims >= 3, 'each allocation path must claim its guest — found ' + String(claims))
})

test('guestFor asks for a new tab from the second view onward', () => {
  assert.match(host, /const needsNewTab = this\.views\.size > 0/,
    'the first view takes the sidebar as it is; later views need a tab of their own')
  assert.match(host, /\.\.\.needsNewTab \? \{ newTab: true \} : \{\}/,
    'and that decision must reach the bridge')
})

test('every gated op is called with an owner from the host', () => {
  const gated = ['ensureSidebar', 'ensureTabs', 'showTab', 'closeSidebarBrowser']
  const missing = gated.filter(name => {
    const re = new RegExp("op: '" + name + "'[\\s\\S]{0,120}?owner:")
    return !re.test(host)
  })
  assert.deepEqual(missing, [], 'these are called without an owner and fail silently: ' + missing.join(', '))
})

test('ensureTabs counts, and does not create tabs', () => {
  // It used to click the strip's "+" and then the guide card, in a loop of thirty. That could
  // never work: a guest appears only once a page NAVIGATES, and this op never navigates — so the
  // tab it made stayed a guide page, the count it waited for never arrived, and it spent eighteen
  // seconds failing while leaving the empty guide tab behind. Those leftovers are what the user
  // saw as "it keeps creating new browser entries".
  //
  // Tab creation belongs to ensureSidebar, which carries a url. This op only reports.
  const lines = bridge.split('\n')
  const start = lines.findIndex(l => /if \(op === 'ensureTabs'\)/.test(l))
  assert.ok(start >= 0, 'ensureTabs exists')
  const end = lines.findIndex((l, i) => i > start && /if \(op === 'showTab'\)/.test(l))
  const body = lines.slice(start, end > 0 ? end : start + 200).join('\n')
  assert.ok(!/\.click\(\)/.test(body), 'ensureTabs must not click anything')
  assert.ok(!/clickedPlus|clickedGuide/.test(body), 'nor keep round-scoped click flags')
})
