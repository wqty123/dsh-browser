// The bridge boundary is where this project's bugs keep coming from.
//
// Every op the host sends crosses into another process with a payload the bridge validates. When
// the bridge gained an owner ledger, four call sites were left behind and three of them failed
// SILENTLY — showView refused to switch tabs, closeSidebarBrowser closed nothing, releasePage
// closed nothing — with no error anywhere. Each one cost a round of "it still doesn't work".
//
// These tests hold the two invariants that catch that class:
//   1. every op the host calls exists on the bridge;
//   2. every op the bridge gates on `owner` is CALLED with an owner.
//
// They are static comparisons of the two files, which is exactly the level the mistake was made.
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const BRIDGE = readFileSync('desktop-bridge/plugin-browser-bridge.js', 'utf8')
const HOST = readFileSync('src/browser-electron/desktop-bridge-host.ts', 'utf8')

/** @returns every `if (op === 'x')` name in the bridge. */
function bridgeOps () {
  return [...BRIDGE.matchAll(/if \(op === '([a-zA-Z]+)'\)/g)].map(match => match[1])
}

/** @returns the op names the host sends, with whether an owner travels alongside. */
function hostCalls () {
  const found = []
  for (const match of HOST.matchAll(/op: '([a-zA-Z]+)'([\s\S]{0,120}?)\}/g)) {
    found.push({ op: match[1], owner: /owner:/.test(match[2]) })
  }
  return found
}

test('every op the host sends exists on the bridge', () => {
  const known = new Set(bridgeOps())
  const unknown = [...new Set(hostCalls().map(c => c.op))].filter(op => !known.has(op))
  assert.deepEqual(unknown, [], 'the host sends ops the bridge does not implement: ' + unknown.join(', '))
})

test('every op that gates on owner is called with an owner', () => {
  // Ops whose bridge handler consults the claims ledger. A call without `owner` becomes
  // 'anonymous' and either gets refused by a guard or matches nothing.
  const gated = ['ensureSidebar', 'ensureTabs', 'showTab', 'closeSidebarBrowser']
  const missing = []
  for (const call of hostCalls()) {
    if (gated.includes(call.op) && !call.owner) missing.push(call.op)
  }
  assert.deepEqual(missing, [], 'these ops are called without an owner and will silently do nothing: ' + missing.join(', '))
})

test('the bridge still gates those ops — the list above is not stale', () => {
  // If an op stops using the ledger, this test tells the previous one to be relaxed rather than
  // leaving it asserting a rule that no longer exists.
  for (const op of ['ensureSidebar', 'ensureTabs', 'showTab', 'closeSidebarBrowser']) {
    const start = BRIDGE.indexOf(`if (op === '${op}')`)
    assert.ok(start >= 0, `${op} exists on the bridge`)
    const rest = BRIDGE.slice(start)
    const end = rest.indexOf("\n  if (op === '", 10)
    const body = end >= 0 ? rest.slice(0, end) : rest.slice(0, 6000)
    assert.ok(/pruneClaims\(\)|claims\./.test(body), `${op} still consults the claims ledger`)
  }
})

test('the liveness probe is the only owner-less list call', () => {
  // Deliberate: it only asks whether the bridge answers at all, and an answer filtered to nothing
  // is still an answer. Anything else calling list without an owner would see an empty sidebar.
  const listCalls = hostCalls().filter(c => c.op === 'list')
  const withoutOwner = listCalls.filter(c => !c.owner)
  assert.equal(withoutOwner.length, 1, 'exactly one owner-less list call, the probe')
  assert.ok(/probe\.call/.test(HOST), 'and it is the probe')
})
