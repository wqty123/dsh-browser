// The bridge boundary is where this project's bugs keep coming from.
//
// Every op the host sends crosses into another process with a payload the bridge validates. When
// the bridge gained an handle ledger, four call sites were left behind and three of them failed
// SILENTLY — showView refused to switch tabs, releaseSession closed nothing, releasePage
// closed nothing — with no error anywhere. Each one cost a round of "it still doesn't work".
//
// These tests hold the two invariants that catch that class:
//   1. every op the host calls exists on the bridge;
//   2. every op the bridge gates on `handle` is CALLED with an handle.
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

/** @returns the op names the host sends, with whether an handle travels alongside. */
function hostCalls () {
  const found = []
  for (const match of HOST.matchAll(/op: '([a-zA-Z]+)'([\s\S]{0,200}?)\}/g)) {
    // `handle` arrives as shorthand on some calls and as a key on others; the window starts at the
    // op name, so any `handle` inside it belongs to this call.
    found.push({ op: match[1], handle: /\bhandle\b/.test(match[2]) })
  }
  return found
}

test('every op the host sends exists on the bridge', () => {
  const known = new Set(bridgeOps())
  const unknown = [...new Set(hostCalls().map(c => c.op))].filter(op => !known.has(op))
  assert.deepEqual(unknown, [], 'the host sends ops the bridge does not implement: ' + unknown.join(', '))
})

test('every op that gates on handle is called with an handle', () => {
  // Ops whose bridge handler consults the claims ledger. A call without `handle` becomes
  // 'anonymous' and either gets refused by a guard or matches nothing.
  const gated = ['ensureSidebar', 'showTab', 'releaseSession', 'closePage', 'download', 'cdp', 'collapseSidebar']
  const missing = []
  for (const call of hostCalls()) {
    if (gated.includes(call.op) && !call.handle) missing.push(call.op)
  }
  assert.deepEqual(missing, [], 'these ops are called without an handle and will silently do nothing: ' + missing.join(', '))
})

test('canonical bindings replace per-call ownership gates', () => {
  assert.ok(BRIDGE.includes('const guest = boundGuest(request.handle)'))
  assert.ok(BRIDGE.includes("wireHandle(request.handle, 'session')"))
  assert.ok(BRIDGE.includes("wireHandle(request.handle, 'tab')"))
  assert.doesNotMatch(BRIDGE, /assertGuestOwner|pruneClaims|const claims/)
})

test('the liveness probe is the only handle-less list call', () => {
  // Deliberate: it only asks whether the bridge answers at all, and an answer filtered to nothing
  // is still an answer. Anything else calling list without an handle would see an empty sidebar.
  const listCalls = hostCalls().filter(c => c.op === 'list')
  const withoutOwner = listCalls.filter(c => !c.handle)
  assert.equal(withoutOwner.length, 1, 'exactly one handle-less list call, the probe')
  assert.ok(/probe\.call/.test(HOST), 'and it is the probe')
})
